import { DataSource } from "typeorm";
import { ReferralTier } from "../models/ReferralTier.model";
import { ReferralTierHistory } from "../models/ReferralTierHistory.model";
import { ReferralTierLevel } from "../types/enums";
import { ServiceError } from "../utils/service-error";
import { TtlCache } from "../lib/ttl-cache";

const CACHE_TTL_MS = 60_000;
const HISTORY_PAGE_SIZE = 20;

/** Volume thresholds (in referred volume units) that gate each tier. */
const TIER_THRESHOLDS: Record<ReferralTierLevel, number | null> = {
  [ReferralTierLevel.STANDARD]: 10_000,
  [ReferralTierLevel.BRONZE]: 50_000,
  [ReferralTierLevel.SILVER]: 200_000,
  [ReferralTierLevel.GOLD]: null,
};

/** Commission rate in basis points per tier. */
const TIER_COMMISSION_BPS: Record<ReferralTierLevel, number> = {
  [ReferralTierLevel.STANDARD]: 100,
  [ReferralTierLevel.BRONZE]: 150,
  [ReferralTierLevel.SILVER]: 200,
  [ReferralTierLevel.GOLD]: 250,
};

const STANDARD_DEFAULTS = {
  tier: ReferralTierLevel.STANDARD,
  commissionRateBps: TIER_COMMISSION_BPS[ReferralTierLevel.STANDARD],
  cumulativeReferredVolume: "0.0000",
};

export interface ReferralTierUpgradedEvent {
  wallet: string;
  tier: ReferralTierLevel;
  commissionRateBps?: number;
  cumulativeReferredVolume?: string;
  eventId?: string;
  occurredAt?: Date;
}

export interface ReferralTierView {
  wallet: string;
  tier: ReferralTierLevel;
  commissionRateBps: number;
  cumulativeReferredVolume: string;
  nextTierThreshold: string | null;
  nextTier: ReferralTierLevel | null;
  isDefault: boolean;
  upgradedAt: string | null;
}

export interface ReferralTierHistoryPage {
  data: Array<{
    tier: ReferralTierLevel;
    commissionRateBps: number;
    cumulativeReferredVolume: string;
    upgradedAt: string | null;
  }>;
  meta: { page: number; limit: number; total: number; totalPages: number };
}

/**
 * Referral tier tracking (#677). Ingests ReferralTierUpgraded events into a
 * current-snapshot table plus an append-only history log. Wallets with no
 * history get Standard defaults at read time.
 */
export class ReferralTierService {
  private readonly cache = new TtlCache<ReferralTierView>(CACHE_TTL_MS);

  constructor(private readonly dataSource: DataSource) {}

  /** Indexer: record a ReferralTierUpgraded event. */
  async ingestReferralTierUpgraded(event: ReferralTierUpgradedEvent): Promise<ReferralTier> {
    const wallet = event.wallet.trim();
    if (!wallet) {
      throw new ServiceError("INVALID_WALLET", "wallet is required", 400);
    }
    if (!Object.values(ReferralTierLevel).includes(event.tier)) {
      throw new ServiceError("INVALID_TIER", `Unknown tier "${event.tier}"`, 400);
    }

    const repo = this.dataSource.getRepository(ReferralTier);
    let row = await repo.findOneBy({ wallet });
    if (!row) {
      row = repo.create({ wallet });
    }

    row.tier = event.tier;
    row.commissionRateBps =
      event.commissionRateBps ?? TIER_COMMISSION_BPS[event.tier];
    if (event.cumulativeReferredVolume !== undefined) {
      row.cumulativeReferredVolume = event.cumulativeReferredVolume;
    }
    if (event.eventId) row.lastEventId = event.eventId;
    row.upgradedAt = event.occurredAt ?? new Date();

    const saved = await repo.save(row);
    await this.appendHistory(saved);
    this.cache.invalidatePrefix(wallet);
    return saved;
  }

  async getTier(wallet: string): Promise<ReferralTierView> {
    const normalized = wallet.trim();
    const cached = this.cache.get(normalized);
    if (cached) return cached;

    const row = await this.dataSource.getRepository(ReferralTier).findOneBy({
      wallet: normalized,
    });

    const view = row ? toView(row) : defaultView(normalized);
    this.cache.set(normalized, view);
    return view;
  }

  async getTierHistory(
    wallet: string,
    page = 1,
    limit = HISTORY_PAGE_SIZE,
  ): Promise<ReferralTierHistoryPage> {
    const normalized = wallet.trim();
    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));

    const historyRepo = this.dataSource.getRepository(ReferralTierHistory);
    const [rows, total] = await historyRepo.findAndCount({
      where: { wallet: normalized },
      order: { upgradedAt: "DESC" },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });

    return {
      data: rows.map((r) => ({
        tier: r.tier,
        commissionRateBps: r.commissionRateBps,
        cumulativeReferredVolume: r.cumulativeReferredVolume,
        upgradedAt: r.upgradedAt ? r.upgradedAt.toISOString() : null,
      })),
      meta: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit)),
      },
    };
  }

  private async appendHistory(row: ReferralTier): Promise<void> {
    const historyRepo = this.dataSource.getRepository(ReferralTierHistory);
    const entry = historyRepo.create({
      wallet: row.wallet,
      tier: row.tier,
      commissionRateBps: row.commissionRateBps,
      cumulativeReferredVolume: row.cumulativeReferredVolume,
      lastEventId: row.lastEventId,
      upgradedAt: row.upgradedAt,
    });
    await historyRepo.save(entry);
  }
}

function toView(row: ReferralTier): ReferralTierView {
  return {
    wallet: row.wallet,
    tier: row.tier,
    commissionRateBps: row.commissionRateBps,
    cumulativeReferredVolume: row.cumulativeReferredVolume,
    nextTierThreshold: nextThreshold(row.tier),
    nextTier: nextTier(row.tier),
    isDefault: false,
    upgradedAt: row.upgradedAt ? row.upgradedAt.toISOString() : null,
  };
}

function defaultView(wallet: string): ReferralTierView {
  return {
    wallet,
    tier: STANDARD_DEFAULTS.tier,
    commissionRateBps: STANDARD_DEFAULTS.commissionRateBps,
    cumulativeReferredVolume: STANDARD_DEFAULTS.cumulativeReferredVolume,
    nextTierThreshold: nextThreshold(ReferralTierLevel.STANDARD),
    nextTier: nextTier(ReferralTierLevel.STANDARD),
    isDefault: true,
    upgradedAt: null,
  };
}

function nextThreshold(tier: ReferralTierLevel): string | null {
  const value = TIER_THRESHOLDS[tier];
  return value === null ? null : value.toFixed(4);
}

function nextTier(tier: ReferralTierLevel): ReferralTierLevel | null {
  const order = [
    ReferralTierLevel.STANDARD,
    ReferralTierLevel.BRONZE,
    ReferralTierLevel.SILVER,
    ReferralTierLevel.GOLD,
  ];
  const idx = order.indexOf(tier);
  return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;
}

export function createReferralTierService(dataSource: DataSource): ReferralTierService {
  return new ReferralTierService(dataSource);
}
