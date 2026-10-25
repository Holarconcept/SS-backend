import type { DataSource } from "typeorm";
import { BulkCancelledOrder } from "../models/BulkCancelledOrder.model";
import { ContractEventHandler } from "./contract-event-bus.service";
import type { DecodedSorobanEvent } from "../types/soroban.types";

/**
 * Bulk secondary market bid cancellation indexer (#688).
 *
 * Indexes BulkOrdersCancelled events, marks affected orders as cancelled,
 * and exposes paginated lists of cancelled orders with refund amounts.
 * Cache is invalidated on each bulk cancellation event.
 */
const CACHE_TTL_MS = 30 * 1000;

export interface CancelledOrderView {
  order_id: string;
  wallet: string;
  invoice_id: string | null;
  refund_amount: string;
  cancelled_at: string | null;
}

export interface CancelledOrdersPage {
  orders: CancelledOrderView[];
  total: number;
  page: number;
  limit: number;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class BulkCancellationService implements ContractEventHandler {
  private readonly dataSource: DataSource;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly now: () => Date;

  constructor(dataSource: DataSource, now: () => Date = () => new Date()) {
    this.dataSource = dataSource;
    this.now = now;
  }

  topics(): string[] {
    return ["bulk_orders_cancelled"];
  }

  async handle(event: DecodedSorobanEvent): Promise<void> {
    const data = event.data as Record<string, unknown>;
    const orders = (data.orders ?? data.cancelledOrders ?? []) as Array<Record<string, unknown>>;
    await this.ingestBulkCancellation({
      orders: orders.map((o) => ({
        orderId: String(o.orderId ?? o.order_id ?? ""),
        wallet: String(o.wallet ?? o.seller ?? ""),
        invoiceId: o.invoiceId ? String(o.invoiceId) : o.invoice_id ? String(o.invoice_id) : null,
        refundAmount: String(o.refundAmount ?? o.refund_amount ?? "0"),
      })),
      eventId: event.id ?? null,
      occurredAt: event.occurredAt ?? this.now(),
    });
  }

  async ingestBulkCancellation(input: {
    orders: Array<{
      orderId: string;
      wallet: string;
      invoiceId?: string | null;
      refundAmount: string;
    }>;
    eventId?: string | null;
    occurredAt?: Date;
  }): Promise<BulkCancelledOrder[]> {
    const repo = this.dataSource.getRepository(BulkCancelledOrder);
    const cancelledAt = input.occurredAt ?? this.now();
    const results: BulkCancelledOrder[] = [];

    for (const order of input.orders) {
      // Upsert: skip if already cancelled (idempotent).
      const existing = await repo.findOneBy({ orderId: order.orderId });
      if (existing) continue;

      const row = repo.create({
        orderId: order.orderId,
        wallet: order.wallet.toLowerCase(),
        invoiceId: order.invoiceId ?? null,
        refundAmount: order.refundAmount,
        eventId: input.eventId ?? null,
        cancelledAt,
      });
      results.push(await repo.save(row));
    }

    // Invalidate cache for affected wallets.
    for (const order of input.orders) {
      this.invalidateWallet(order.wallet.toLowerCase());
    }
    return results;
  }

  private invalidateWallet(wallet: string): void {
    this.cache.delete(`cancelled:${wallet}`);
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

  /** GET /orders/:wallet/cancelled */
  async getCancelledOrders(
    wallet: string,
    page = 1,
    limit = 20,
  ): Promise<CancelledOrdersPage> {
    const normalized = wallet.toLowerCase();
    const cacheKey = `cancelled:${normalized}:${page}:${limit}`;
    const cached = this.getCached<CancelledOrdersPage>(cacheKey);
    if (cached) return cached;

    const repo = this.dataSource.getRepository(BulkCancelledOrder);
    const [rows, total] = await repo.findAndCount({
      where: { wallet: normalized },
      order: { cancelledAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });

    const result: CancelledOrdersPage = {
      orders: rows.map((r) => ({
        order_id: r.orderId,
        wallet: r.wallet,
        invoice_id: r.invoiceId,
        refund_amount: r.refundAmount,
        cancelled_at: r.cancelledAt?.toISOString() ?? null,
      })),
      total,
      page,
      limit,
    };
    this.setCached(cacheKey, result);
    return result;
  }
}

export function createBulkCancellationService(
  dataSource: DataSource,
  now?: () => Date,
): BulkCancellationService {
  return new BulkCancellationService(dataSource, now);
}
