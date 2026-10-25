import type { DataSource } from "typeorm";
import { PoolRebalance } from "../models/PoolRebalance.model";
import { ContractEventHandler } from "./contract-event-bus.service";
import type { DecodedSorobanEvent } from "../types/soroban.types";

/**
 * Pool rebalance indexer and weight history service (#684).
 *
 * Indexes PoolRebalanceProposed and PoolRebalanceExecuted events into
 * pool_rebalances and exposes pending proposals and paginated history
 * with ETA countdowns. Cache TTL 60s, invalidated on new rebalance events.
 */
const CACHE_TTL_MS = 60 * 1000;

export interface PendingRebalanceView {
  pool_id: string;
  new_weights: Record<string, string>;
  eta: string | null;
  eta_seconds: number | null;
  proposed_at: string | null;
}

export interface RebalanceHistoryEntry {
  id: string;
  pool_id: string;
  status: "pending" | "executed";
  old_weights: Record<string, string>;
  new_weights: Record<string, string>;
  eta: string | null;
  proposed_at: string | null;
  executed_at: string | null;
}

export interface RebalanceHistoryPage {
  entries: RebalanceHistoryEntry[];
  total: number;
  page: number;
  limit: number;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class PoolRebalanceService implements ContractEventHandler {
  private readonly dataSource: DataSource;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly now: () => Date;

  constructor(dataSource: DataSource, now: () => Date = () => new Date()) {
    this.dataSource = dataSource;
    this.now = now;
  }

  topics(): string[] {
    return ["pool_rebalance_proposed", "pool_rebalance_executed"];
  }

  async handle(event: DecodedSorobanEvent): Promise<void> {
    const data = event.data as Record<string, unknown>;
    const topic = event.topic?.toLowerCase() ?? "";

    if (topic.includes("proposed")) {
      await this.ingestProposed({
        poolId: String(data.poolId ?? data.pool_id ?? ""),
        newWeights: (data.newWeights ?? data.new_weights ?? {}) as Record<string, string>,
        oldWeights: (data.oldWeights ?? data.old_weights ?? {}) as Record<string, string>,
        eta: data.eta ? new Date(String(data.eta)) : null,
        eventId: event.id ?? null,
        occurredAt: event.occurredAt ?? this.now(),
      });
    } else {
      await this.ingestExecuted({
        poolId: String(data.poolId ?? data.pool_id ?? ""),
        eventId: event.id ?? null,
        occurredAt: event.occurredAt ?? this.now(),
      });
    }
  }

  async ingestProposed(input: {
    poolId: string;
    newWeights: Record<string, string>;
    oldWeights: Record<string, string>;
    eta: Date | null;
    eventId?: string | null;
    occurredAt?: Date;
  }): Promise<PoolRebalance> {
    const repo = this.dataSource.getRepository(PoolRebalance);
    const row = repo.create({
      poolId: input.poolId,
      status: "pending" as const,
      oldWeights: input.oldWeights,
      newWeights: input.newWeights,
      eta: input.eta,
      proposedAt: input.occurredAt ?? this.now(),
      proposedEventId: input.eventId ?? null,
    });
    const saved = await repo.save(row);
    this.invalidatePool(input.poolId);
    return saved;
  }

  async ingestExecuted(input: {
    poolId: string;
    eventId?: string | null;
    occurredAt?: Date;
  }): Promise<PoolRebalance | null> {
    const repo = this.dataSource.getRepository(PoolRebalance);
    const pending = await repo.findOne({
      where: { poolId: input.poolId, status: "pending" as const },
      order: { proposedAt: "DESC" },
    });
    if (!pending) return null;

    pending.status = "executed" as const;
    pending.executedAt = input.occurredAt ?? this.now();
    pending.executedEventId = input.eventId ?? null;
    const saved = await repo.save(pending);
    this.invalidatePool(input.poolId);
    return saved;
  }

  private invalidatePool(poolId: string): void {
    this.cache.delete(`pending:${poolId}`);
    this.cache.delete(`history:${poolId}`);
  }

  private getCached<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCached<T>(key: string, data: T): void {
    this.cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  /** GET /pools/:pool_id/rebalances/pending */
  async getPending(poolId: string): Promise<PendingRebalanceView | null> {
    const cacheKey = `pending:${poolId}`;
    const cached = this.getCached<PendingRebalanceView | null>(cacheKey);
    if (cached !== null) return cached;

    const repo = this.dataSource.getRepository(PoolRebalance);
    const row = await repo.findOne({
      where: { poolId, status: "pending" as const },
      order: { proposedAt: "DESC" },
    });

    if (!row) {
      this.setCached(cacheKey, null);
      return null;
    }

    const nowMs = this.now().getTime();
    const etaMs = row.eta?.getTime() ?? null;
    const view: PendingRebalanceView = {
      pool_id: row.poolId,
      new_weights: row.newWeights,
      eta: row.eta?.toISOString() ?? null,
      eta_seconds: etaMs !== null ? Math.max(0, Math.round((etaMs - nowMs) / 1000)) : null,
      proposed_at: row.proposedAt?.toISOString() ?? null,
    };
    this.setCached(cacheKey, view);
    return view;
  }

  /** GET /pools/:pool_id/rebalances/history */
  async getHistory(
    poolId: string,
    page = 1,
    limit = 20,
  ): Promise<RebalanceHistoryPage> {
    const cacheKey = `history:${poolId}:${page}:${limit}`;
    const cached = this.getCached<RebalanceHistoryPage>(cacheKey);
    if (cached) return cached;

    const repo = this.dataSource.getRepository(PoolRebalance);
    const [rows, total] = await repo.findAndCount({
      where: { poolId },
      order: { proposedAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });

    const result: RebalanceHistoryPage = {
      entries: rows.map((r) => ({
        id: r.id,
        pool_id: r.poolId,
        status: r.status,
        old_weights: r.oldWeights,
        new_weights: r.newWeights,
        eta: r.eta?.toISOString() ?? null,
        proposed_at: r.proposedAt?.toISOString() ?? null,
        executed_at: r.executedAt?.toISOString() ?? null,
      })),
      total,
      page,
      limit,
    };
    this.setCached(cacheKey, result);
    return result;
  }
}

export function createPoolRebalanceService(
  dataSource: DataSource,
  now?: () => Date,
): PoolRebalanceService {
  return new PoolRebalanceService(dataSource, now);
}
