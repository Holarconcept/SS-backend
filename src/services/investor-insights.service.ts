import { DataSource } from "typeorm";
import { AlertPreference } from "../models/AlertPreference.model";
import { OnboardingBonus } from "../models/OnboardingBonus.model";
import { YieldAdjustment } from "../models/YieldAdjustment.model";
import { Investment } from "../models/Investment.model";
import type { AppLogger } from "../observability/logger";
import { logger as globalLogger } from "../observability/logger";
import type { DecodedSorobanEvent } from "../types/soroban.types";
import { HttpError } from "../utils/http-error";
import { Address, SorobanRpc, nativeToScVal, scValToNative, xdr } from "stellar-sdk";

const ONBOARDING_CACHE_TTL_MS = 60_000;
const YIELD_CACHE_TTL_MS = 5 * 60_000;

type AlertKind =
  | "settlement"
  | "kyc_expiry"
  | "watchlist_change"
  | "auto_invest"
  | "maturity";

export interface OnboardingBonusStatus {
  is_claimed: boolean;
  bonus_amount: string | null;
  invoice_id: string | null;
  claimed_at: string | null;
}

export interface AlertPreferencesView {
  settlement: boolean;
  kyc_expiry: boolean;
  watchlist_change: boolean;
  auto_invest: boolean;
  maturity: boolean;
}

export interface YieldAdjustmentView {
  invoice_id: string;
  adjustment_bps: number;
  basis_rating: string | null;
  adjusted_yield: string | null;
  settled_at: string | null;
}

interface CachedValue<T> {
  expiresAt: number;
  value: T;
}

interface InvestorInsightsConfig {
  notificationServiceUrl?: string;
  bonusPoolContractId?: string;
  bonusPoolStorageKey?: string;
  rpcUrl?: string;
  notificationServiceToken?: string;
}

function dataObject(value: unknown): Record<string, unknown> {
  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((entry, index) => [String(index), entry]));
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Address) return value.toString();
  return null;
}

function valueFrom(
  data: Record<string, unknown>,
  aliases: string[],
  topics: unknown[],
  topicIndex: number,
): unknown {
  for (const alias of aliases) {
    if (data[alias] !== undefined && data[alias] !== null) return data[alias];
    const camel = alias.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    if (data[camel] !== undefined && data[camel] !== null) return data[camel];
  }
  if (data[String(topicIndex - 1)] !== undefined) return data[String(topicIndex - 1)];
  return topics[topicIndex];
}

function normalizeTopic(topic: string): string {
  return topic.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function preferenceFor(kind: AlertKind): keyof AlertPreferencesView {
  return kind;
}

function detectAlertKind(topic: string): AlertKind | null {
  const normalized = normalizeTopic(topic).replace(/_/g, "");
  if (
    normalized.includes("settlement") ||
    normalized.includes("settled") ||
    normalized.startsWith("settle") ||
    normalized.includes("paymentrecorded")
  ) return "settlement";
  if (
    normalized.includes("kycexpiry") ||
    normalized.includes("kycexpired") ||
    normalized.includes("kycexpiration")
  ) return "kyc_expiry";
  if (
    normalized.includes("watchlistchange") ||
    normalized.includes("watchlistupdated")
  ) return "watchlist_change";
  if (normalized.includes("autoinvest")) return "auto_invest";
  if (normalized.includes("maturity") || normalized.includes("matured")) return "maturity";
  return null;
}

export class InvestorInsightsService {
  private readonly onboardingCache = new Map<string, CachedValue<OnboardingBonusStatus>>();
  private readonly preferenceCache = new Map<string, CachedValue<AlertPreferencesView>>();
  private readonly currentYieldCache = new Map<string, CachedValue<YieldAdjustmentView>>();
  private readonly yieldHistoryCache = new Map<string, CachedValue<YieldAdjustmentView[]>>();
  private readonly logger: AppLogger;
  private readonly rpcServer?: SorobanRpc.Server;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: InvestorInsightsConfig = {},
    logger: AppLogger = globalLogger,
    private readonly request: typeof fetch = fetch,
  ) {
    this.logger = logger;
    if (config.rpcUrl) {
      this.rpcServer = new SorobanRpc.Server(config.rpcUrl, {
        allowHttp: config.rpcUrl.startsWith("http://"),
      });
    }
  }

  async getOnboardingBonus(wallet: string): Promise<OnboardingBonusStatus> {
    const cached = this.readCache(this.onboardingCache, wallet);
    if (cached) return cached;

    const bonus = await this.dataSource.getRepository(OnboardingBonus).findOne({ where: { wallet } });
    const status: OnboardingBonusStatus = bonus
      ? {
          is_claimed: true,
          bonus_amount: bonus.bonusAmount,
          invoice_id: bonus.invoiceId,
          claimed_at: bonus.claimedAt.toISOString(),
        }
      : { is_claimed: false, bonus_amount: null, invoice_id: null, claimed_at: null };
    this.writeCache(this.onboardingCache, wallet, status, ONBOARDING_CACHE_TTL_MS);
    return status;
  }

  async getAlertPreferences(wallet: string): Promise<AlertPreferencesView> {
    const cached = this.readCache(this.preferenceCache, wallet);
    if (cached) return cached;

    const preferences = await this.dataSource.getRepository(AlertPreference).findOne({ where: { wallet } });
    const view: AlertPreferencesView = preferences
      ? {
          settlement: preferences.settlementEnabled,
          kyc_expiry: preferences.kycExpiryEnabled,
          watchlist_change: preferences.watchlistChangeEnabled,
          auto_invest: preferences.autoInvestEnabled,
          maturity: preferences.maturityEnabled,
        }
      : { settlement: true, kyc_expiry: true, watchlist_change: true, auto_invest: true, maturity: true };
    this.writeCache(this.preferenceCache, wallet, view, ONBOARDING_CACHE_TTL_MS);
    return view;
  }

  async getYieldAdjustment(invoiceId: string): Promise<YieldAdjustmentView> {
    const cached = this.readCache(this.currentYieldCache, invoiceId);
    if (cached) return cached;

    const row = await this.dataSource.getRepository(YieldAdjustment).findOne({
      where: { invoiceId },
      order: { settledAt: "DESC" },
    });
    const view = row
      ? this.toYieldView(row)
      : { invoice_id: invoiceId, adjustment_bps: 0, basis_rating: null, adjusted_yield: null, settled_at: null };
    this.writeCache(this.currentYieldCache, invoiceId, view, YIELD_CACHE_TTL_MS);
    return view;
  }

  async getYieldAdjustmentHistory(invoiceId: string): Promise<YieldAdjustmentView[]> {
    const cached = this.readCache(this.yieldHistoryCache, invoiceId);
    if (cached) return cached;

    const rows = await this.dataSource.getRepository(YieldAdjustment).find({
      where: { invoiceId },
      order: { settledAt: "DESC" },
    });
    const history = rows.map((row) => this.toYieldView(row));
    this.writeCache(this.yieldHistoryCache, invoiceId, history, YIELD_CACHE_TTL_MS);
    return history;
  }

  async getBonusPoolBalance(): Promise<string> {
    if (!this.rpcServer || !this.config.bonusPoolContractId) {
      throw new HttpError(503, "Onboarding bonus pool contract is not configured.");
    }
    let contractAddress: xdr.ScAddress;
    try {
      contractAddress = new Address(this.config.bonusPoolContractId).toScAddress();
    } catch {
      const rawBytes = Buffer.from(this.config.bonusPoolContractId, "utf8");
      contractAddress = xdr.ScAddress.scAddressTypeContract(rawBytes.subarray(0, 32));
    }

    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractAddress,
        key: nativeToScVal(this.config.bonusPoolStorageKey ?? "pool_balance", { type: "symbol" }),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const result = await this.rpcServer.getLedgerEntries(ledgerKey);
    const storedEntry = result.entries[0];
    if (!storedEntry) throw new HttpError(404, "Onboarding bonus pool balance was not found on-chain.");
    const entry = storedEntry.val.contractData().val();
    const balance = scValToNative(entry);
    const parsed = scalarString(balance);
    if (parsed === null) {
      throw new Error("The onboarding bonus pool storage value is not a scalar balance.");
    }
    return parsed;
  }

  async processEvent(event: DecodedSorobanEvent): Promise<void> {
    const topic = normalizeTopic(event.topic);
    const data = dataObject(event.data);
    const topics = event.topics;
    const eventId = event.id || `${event.txHash}:${topic}:${event.ledger}`;

    if (topic === "onboarding_bonus_claimed") {
      await this.processOnboardingBonus(event, data, topics, eventId);
      return;
    }

    if (topic === "alert_preference_updated") {
      await this.processAlertPreference(event, data, topics, eventId);
      return;
    }

    if (
      topic.includes("settle") ||
      topic.includes("settlement") ||
      topic.includes("invoice_settled") ||
      topic.includes("yield_adjustment") ||
      topic.includes("payment_recorded")
    ) {
      await this.processYieldAdjustment(event, data, topics, eventId);
    }

    const kind = detectAlertKind(event.topic);
    if (kind) await this.dispatchAlert(event, data, topics, kind);
  }

  private async processOnboardingBonus(
    event: DecodedSorobanEvent,
    data: Record<string, unknown>,
    topics: unknown[],
    eventId: string,
  ): Promise<void> {
    const wallet = scalarString(valueFrom(data, ["wallet", "investor", "investor_wallet", "claimer"], topics, 1));
    const amount = scalarString(valueFrom(data, ["bonus_amount", "amount"], topics, 2));
    const invoiceValue = valueFrom(data, ["invoice_id", "invoice"], topics, 3);
    if (!wallet || amount === null || !Number.isFinite(Number(amount)) || Number(amount) < 0) {
      throw new Error(`OnboardingBonusClaimed event ${eventId} is missing a valid wallet or bonus amount.`);
    }

    const claimedAtValue = scalarString(data.claimed_at ?? data.claimedAt) ?? event.ledgerClosedAt;
    const claimedAt = new Date(claimedAtValue);
    if (Number.isNaN(claimedAt.getTime())) {
      throw new Error(`OnboardingBonusClaimed event ${eventId} has an invalid claim timestamp.`);
    }
    const repository = this.dataSource.getRepository(OnboardingBonus);
    const existing = await repository.findOne({ where: [{ wallet }, { eventId }] });
    await repository.save(repository.create({
      ...(existing ?? {}),
      wallet,
      bonusAmount: amount,
      invoiceId: scalarString(invoiceValue),
      claimedAt,
      eventId,
    }));
    this.onboardingCache.delete(wallet);
  }

  private async processAlertPreference(
    event: DecodedSorobanEvent,
    data: Record<string, unknown>,
    topics: unknown[],
    eventId: string,
  ): Promise<void> {
    const wallet = scalarString(valueFrom(data, ["wallet", "investor", "owner"], topics, 1));
    if (!wallet) throw new Error(`AlertPreferenceUpdated event ${eventId} is missing its wallet.`);

    const rawPreferences = data.preferences ?? data;
    const values = dataObject(rawPreferences);
    if (Array.isArray(rawPreferences)) {
      const names = ["settlement", "kyc_expiry", "watchlist_change", "auto_invest", "maturity"];
      rawPreferences.forEach((value, index) => {
        if (names[index]) values[names[index]] = value;
      });
    }
    const repository = this.dataSource.getRepository(AlertPreference);
    const existing = await repository.findOne({ where: { wallet } });
    const preference = repository.create({
      ...(existing ?? {}),
      wallet,
      settlementEnabled: this.booleanPreference(values, ["settlement", "settlements", "settlement_enabled"], existing?.settlementEnabled),
      kycExpiryEnabled: this.booleanPreference(values, ["kyc_expiry", "kyc_expired", "kyc_expiry_enabled"], existing?.kycExpiryEnabled),
      watchlistChangeEnabled: this.booleanPreference(values, ["watchlist_change", "watchlist", "watchlist_change_enabled"], existing?.watchlistChangeEnabled),
      autoInvestEnabled: this.booleanPreference(values, ["auto_invest", "auto_invest_enabled"], existing?.autoInvestEnabled),
      maturityEnabled: this.booleanPreference(values, ["maturity", "maturity_enabled"], existing?.maturityEnabled),
      eventId,
    });
    await repository.save(preference);
    this.preferenceCache.delete(wallet);
  }

  private async processYieldAdjustment(
    event: DecodedSorobanEvent,
    data: Record<string, unknown>,
    topics: unknown[],
    eventId: string,
  ): Promise<void> {
    const invoiceId = scalarString(valueFrom(data, ["invoice_id", "invoice"], topics, 1));
    if (!invoiceId) return;

    const adjustmentValue = valueFrom(data, ["adjustment_bps", "yield_adjustment_bps", "bps"], topics, 2);
    const basisRatingValue = valueFrom(data, ["basis_rating", "rating"], topics, 3);
    const adjustedYieldValue = valueFrom(data, ["adjusted_yield", "yield_after_adjustment"], topics, 4);
    const adjustmentBps = adjustmentValue === undefined ? 0 : Number(adjustmentValue);
    if (!Number.isInteger(adjustmentBps)) {
      throw new Error(`Settlement event ${eventId} has invalid adjustment basis points.`);
    }
    const settledAt = new Date(event.ledgerClosedAt);
    if (Number.isNaN(settledAt.getTime())) {
      throw new Error(`Settlement event ${eventId} has an invalid ledger timestamp.`);
    }
    const repository = this.dataSource.getRepository(YieldAdjustment);
    const existing = await repository.findOne({ where: { settlementEventId: eventId } });
    await repository.save(repository.create({
      ...(existing ?? {}),
      invoiceId,
      settlementEventId: eventId,
      adjustmentBps,
      basisRating: scalarString(basisRatingValue),
      adjustedYield: scalarString(adjustedYieldValue),
      settledAt,
      transactionHash: event.txHash,
    }));
    this.currentYieldCache.delete(invoiceId);
    this.yieldHistoryCache.delete(invoiceId);
  }

  private async dispatchAlert(
    event: DecodedSorobanEvent,
    data: Record<string, unknown>,
    topics: unknown[],
    kind: AlertKind,
  ): Promise<void> {
    const primaryWallet = scalarString(valueFrom(
      data,
      ["wallet", "investor", "investor_wallet", "owner", "user"],
      kind === "settlement" ? [] : topics,
      1,
    ));
    const listedWallets = Array.isArray(data.wallets)
      ? data.wallets.map(scalarString).filter((wallet): wallet is string => wallet !== null)
      : [];
    let wallets = primaryWallet ? [primaryWallet, ...listedWallets] : listedWallets;
    if (kind === "settlement") {
      const invoiceId = scalarString(valueFrom(data, ["invoice_id", "invoice"], topics, 1));
      if (invoiceId) {
        const investments = await this.dataSource.getRepository(Investment).find({
          where: { invoiceId },
          relations: { investor: true },
        });
        wallets = [...wallets, ...investments
          .map((investment) => investment.investor?.stellarAddress)
          .filter((wallet): wallet is string => Boolean(wallet))];
      }
    }
    if (wallets.length === 0) return;
    const notificationServiceUrl = this.config.notificationServiceUrl;
    if (!notificationServiceUrl) {
      throw new Error("NOTIFICATION_SERVICE_URL is required to dispatch opted-in investor alerts.");
    }

    await Promise.all([...new Set(wallets)].map(async (wallet) => {
      const preferences = await this.getAlertPreferences(wallet);
      if (!preferences[preferenceFor(kind)]) return;
      try {
        const response = await this.request(notificationServiceUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `${event.id}:${wallet}`,
            ...(this.config.notificationServiceToken
              ? { authorization: `Bearer ${this.config.notificationServiceToken}` }
              : {}),
          },
          body: JSON.stringify({
            wallet,
            event_type: kind,
            event: {
              id: event.id,
              topic: event.topic,
              transaction_hash: event.txHash,
              ledger: event.ledger,
              data: event.data,
            },
          }),
          signal: AbortSignal.timeout(4_500),
        });
        if (!response.ok) {
          throw new Error(`Notification service returned HTTP ${response.status} for ${event.id}.`);
        }
      } catch (error) {
        this.logger.error("Investor alert dispatch failed", {
          eventId: event.id,
          eventType: kind,
          error,
        });
        throw error;
      }
    }));
  }

  private booleanPreference(
    source: Record<string, unknown>,
    keys: string[],
    fallback: boolean | undefined,
  ): boolean {
    for (const key of keys) {
      if (typeof source[key] === "boolean") return source[key] as boolean;
      if (source[key] === 0 || source[key] === 1) return Boolean(source[key]);
    }
    return fallback ?? true;
  }

  private toYieldView(row: YieldAdjustment): YieldAdjustmentView {
    return {
      invoice_id: row.invoiceId,
      adjustment_bps: row.adjustmentBps,
      basis_rating: row.basisRating,
      adjusted_yield: row.adjustedYield,
      settled_at: row.settledAt.toISOString(),
    };
  }

  private readCache<T>(cache: Map<string, CachedValue<T>>, key: string): T | undefined {
    const cached = cache.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= Date.now()) {
      cache.delete(key);
      return undefined;
    }
    return cached.value;
  }

  private writeCache<T>(
    cache: Map<string, CachedValue<T>>,
    key: string,
    value: T,
    ttl: number,
  ): void {
    cache.set(key, { value, expiresAt: Date.now() + ttl });
  }
}

export function createInvestorInsightsService(
  dataSource: DataSource,
  config?: InvestorInsightsConfig,
  logger?: AppLogger,
): InvestorInsightsService {
  return new InvestorInsightsService(dataSource, config, logger);
}
