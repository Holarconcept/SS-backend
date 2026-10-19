import { DataSource } from "typeorm";
import { YieldBoost } from "../models/YieldBoost.model";
import { Invoice } from "../models/Invoice.model";
import { LoyaltyTier } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { TtlCache } from "../lib/ttl-cache";

const CACHE_TTL_MS = 60_000;

/** Boost in basis points per eligible loyalty tier (#678). Bronze is ineligible. */
const TIER_BOOST_BPS: Partial<Record<LoyaltyTier, number>> = {
  [LoyaltyTier.SILVER]: 25,
  [LoyaltyTier.GOLD]: 50,
  [LoyaltyTier.PLATINUM]: 100,
};

export interface YieldBoostAppliedEvent {
  invoiceId: string;
  wallet: string;
  tier: LoyaltyTier;
  boostBps?: number;
  eventId?: string;
  occurredAt?: Date;
}

export interface YieldBoostView {
  invoiceId: string;
  wallet: string;
  isEligible: boolean;
  tier: LoyaltyTier | null;
  boostBps: number;
  baseYield: string | null;
  boostedYield: string | null;
}

/**
 * Yield boost eligibility and amounts (#678). `ingestYieldBoostApplied` is
 * the indexer entry point. Reads compute eligibility from the wallet's
 * loyalty tier at request time (Bronze and unregistered are ineligible).
 */
export class YieldBoostService {
  private readonly cache = new TtlCache<YieldBoostView>(CACHE_TTL_MS);

  constructor(private readonly dataSource: DataSource) {}

  /** Indexer: record a YieldBoostApplied event for an invoice/wallet pair. */
  async ingestYieldBoostApplied(event: YieldBoostAppliedEvent): Promise<YieldBoost> {
    const wallet = event.wallet.trim();
    if (!wallet) {
      throw new ServiceError("INVALID_WALLET", "wallet is required", 400);
    }
    if (!Object.values(LoyaltyTier).includes(event.tier)) {
      throw new ServiceError("INVALID_TIER", `Unknown loyalty tier "${event.tier}"`, 400);
    }

    const repo = this.dataSource.getRepository(YieldBoost);
    let row = await repo.findOneBy({ invoiceId: event.invoiceId, wallet });
    if (!row) {
      row = repo.create({
        invoiceId: event.invoiceId,
        wallet,
        tier: event.tier,
      });
    }

    row.tier = event.tier;
    row.boostBps = event.boostBps ?? TIER_BOOST_BPS[event.tier] ?? 0;
    if (event.eventId) row.lastEventId = event.eventId;
    row.appliedAt = event.occurredAt ?? new Date();

    const saved = await repo.save(row);
    this.cache.invalidatePrefix(`${event.invoiceId}:${wallet}`);
    return saved;
  }

  /**
   * Current boost for a wallet on an invoice. Eligibility is derived from the
   * latest indexed tier for the wallet; Bronze / unknown wallets get
   * `isEligible: false`.
   */
  async getBoost(invoiceId: string, wallet: string): Promise<YieldBoostView> {
    const normalized = wallet.trim();
    const cacheKey = `${invoiceId}:${normalized}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const invoice = await this.dataSource.getRepository(Invoice).findOneBy({ id: invoiceId });
    if (!invoice) {
      throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    }

    const boostRow = await this.dataSource.getRepository(YieldBoost).findOneBy({
      invoiceId,
      wallet: normalized,
    });

    const tier = boostRow?.tier ?? null;
    const eligible = tier !== null && tier !== LoyaltyTier.BRONZE && TIER_BOOST_BPS[tier] !== undefined;
    const boostBps = eligible ? (boostRow?.boostBps ?? TIER_BOOST_BPS[tier!] ?? 0) : 0;
    const baseYield = Number(invoice.discountRate);
    const boostedYield = eligible
      ? (baseYield + boostBps / 100).toFixed(2)
      : invoice.discountRate;

    const view: YieldBoostView = {
      invoiceId,
      wallet: normalized,
      isEligible: eligible,
      tier,
      boostBps,
      baseYield: invoice.discountRate,
      boostedYield,
    };

    this.cache.set(cacheKey, view);
    return view;
  }

  invalidate(invoiceId: string, wallet?: string): void {
    if (wallet) {
      this.cache.invalidatePrefix(`${invoiceId}:${wallet.trim()}`);
    } else {
      this.cache.invalidatePrefix(`${invoiceId}:`);
    }
  }
}

export function createYieldBoostService(dataSource: DataSource): YieldBoostService {
  return new YieldBoostService(dataSource);
}
