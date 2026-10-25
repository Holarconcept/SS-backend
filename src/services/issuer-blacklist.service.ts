import { DataSource } from "typeorm";
import { TtlCache } from "../lib/ttl-cache";

export interface BlacklistStatus {
  isBlacklisted: boolean;
  reason: string | null;
  blacklistedAt: number | null;
}

export interface BlacklistedIssuer {
  wallet: string;
  reason: string;
  blacklistedAt: number;
}

export interface BlacklistPage {
  issuers: BlacklistedIssuer[];
  total: number;
  page: number;
  pageSize: number;
}

interface BlacklistStatusRow {
  is_blacklisted: boolean;
  reason: string | null;
  blacklisted_at: number | null;
}

interface BlacklistedIssuerRow {
  wallet: string;
  reason: string;
  blacklisted_at: number;
}

interface BlacklistCountRow {
  total: number | string;
}

/**
 * #685 — Issuer blacklist indexer and status REST API.
 * Indexes IssuerBlacklisted and IssuerRestored events.
 */
export class IssuerBlacklistService {
  private cache: TtlCache;

  constructor(private readonly dataSource: DataSource) {
    this.cache = new TtlCache({ ttlSeconds: 60, namespace: "issuer-blacklist" });
  }

  async getBlacklistStatus(wallet: string): Promise<BlacklistStatus> {
    const cacheKey = `status:${wallet}`;
    const cached = await this.cache.get<BlacklistStatus>(cacheKey);
    if (cached) return cached;

    const rows = (await this.dataSource.query(
      `SELECT is_blacklisted, reason, blacklisted_at
       FROM issuer_blacklist WHERE wallet = $1`,
      [wallet],
    )) as BlacklistStatusRow[];

    let status: BlacklistStatus;
    if (rows.length && rows[0].is_blacklisted) {
      status = {
        isBlacklisted: true,
        reason: rows[0].reason,
        blacklistedAt: rows[0].blacklisted_at,
      };
    } else {
      status = { isBlacklisted: false, reason: null, blacklistedAt: null };
    }

    await this.cache.set(cacheKey, status);
    return status;
  }

  async getBlacklistedIssuers(page: number = 1, pageSize: number = 20): Promise<BlacklistPage> {
    const cacheKey = `list:${page}:${pageSize}`;
    const cached = await this.cache.get<BlacklistPage>(cacheKey);
    if (cached) return cached;

    const offset = (page - 1) * pageSize;
    const [rows, countResult] = await Promise.all([
      this.dataSource.query(
        `SELECT wallet, reason, blacklisted_at
         FROM issuer_blacklist WHERE is_blacklisted = true
         ORDER BY blacklisted_at DESC LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      ),
      this.dataSource.query(
        `SELECT COUNT(*) as total FROM issuer_blacklist WHERE is_blacklisted = true`,
      ),
    ]) as [BlacklistedIssuerRow[], BlacklistCountRow[]];

    const result: BlacklistPage = {
      issuers: rows.map((row) => ({
        wallet: row.wallet,
        reason: row.reason,
        blacklistedAt: row.blacklisted_at,
      })),
      total: parseInt(String(countResult[0].total), 10),
      page,
      pageSize,
    };

    await this.cache.set(cacheKey, result);
    return result;
  }

  /** Invalidate cache for a wallet when a blacklist event occurs. */
  async invalidate(wallet: string): Promise<void> {
    await this.cache.delete(`status:${wallet}`);
    this.cache.invalidatePrefix("list:");
  }
}
