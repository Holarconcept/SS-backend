import type { DataSource } from "typeorm";
import { InvoiceRating } from "../models/InvoiceRating.model";
import { ContractEventHandler } from "./contract-event-bus.service";
import type { DecodedSorobanEvent } from "../types/soroban.types";

/**
 * Invoice rating indexer and aggregate score service (#683).
 *
 * Indexes RatingSubmitted events into invoice_ratings and exposes
 * aggregate queries for invoice and issuer ratings with distribution
 * breakdowns. Cache TTL 5 minutes, invalidated on new rating events.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface InvoiceRatingSummary {
  average: number;
  total_ratings: number;
  distribution: { 1: number; 2: number; 3: number; 4: number; 5: number };
  below_minimum: boolean;
}

export interface IssuerRatingSummary {
  average: number;
  total_ratings: number;
  total_invoices: number;
  below_minimum: boolean;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class InvoiceRatingService implements ContractEventHandler {
  private readonly dataSource: DataSource;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(dataSource: DataSource) {
    this.dataSource = dataSource;
  }

  topics(): string[] {
    return ["rating_submitted"];
  }

  async handle(event: DecodedSorobanEvent): Promise<void> {
    const data = event.data as Record<string, unknown>;
    await this.ingestRating({
      invoiceId: String(data.invoiceId ?? data.invoice_id ?? ""),
      issuerWallet: String(data.issuer ?? data.issuerWallet ?? ""),
      raterWallet: String(data.rater ?? data.raterWallet ?? ""),
      rating: Number(data.rating ?? 0),
      eventId: event.id ?? null,
      ratedAt: event.occurredAt ?? new Date(),
    });
  }

  async ingestRating(input: {
    invoiceId: string;
    issuerWallet: string;
    raterWallet: string;
    rating: number;
    eventId?: string | null;
    ratedAt?: Date;
  }): Promise<InvoiceRating> {
    const repo = this.dataSource.getRepository(InvoiceRating);
    const row = repo.create({
      invoiceId: input.invoiceId,
      issuerWallet: input.issuerWallet.toLowerCase(),
      raterWallet: input.raterWallet.toLowerCase(),
      rating: Math.max(1, Math.min(5, Math.round(input.rating))),
      eventId: input.eventId ?? null,
      ratedAt: input.ratedAt ?? new Date(),
    });
    const saved = await repo.save(row);
    this.invalidateCache(input.invoiceId);
    this.invalidateCache(`issuer:${input.issuerWallet.toLowerCase()}`);
    return saved;
  }

  private invalidateCache(key: string): void {
    this.cache.delete(key);
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

  /** GET /invoices/:invoice_id/rating */
  async getInvoiceRating(invoiceId: string): Promise<InvoiceRatingSummary> {
    const cacheKey = `invoice:${invoiceId}`;
    const cached = this.getCached<InvoiceRatingSummary>(cacheKey);
    if (cached) return cached;

    const repo = this.dataSource.getRepository(InvoiceRating);
    const rows = await repo.find({ where: { invoiceId } });

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    for (const row of rows) {
      const r = Math.max(1, Math.min(5, row.rating)) as 1 | 2 | 3 | 4 | 5;
      distribution[r] += 1;
      sum += row.rating;
    }

    const summary: InvoiceRatingSummary = {
      average: rows.length > 0 ? Math.round((sum / rows.length) * 100) / 100 : 0,
      total_ratings: rows.length,
      distribution,
      below_minimum: rows.length < 3,
    };
    this.setCached(cacheKey, summary);
    return summary;
  }

  /** GET /issuers/:wallet/rating */
  async getIssuerRating(wallet: string): Promise<IssuerRatingSummary> {
    const normalized = wallet.toLowerCase();
    const cacheKey = `issuer:${normalized}`;
    const cached = this.getCached<IssuerRatingSummary>(cacheKey);
    if (cached) return cached;

    const repo = this.dataSource.getRepository(InvoiceRating);
    const rows = await repo.find({ where: { issuerWallet: normalized } });

    const distinctInvoices = new Set(rows.map((r) => r.invoiceId));
    const sum = rows.reduce((acc, r) => acc + r.rating, 0);

    const summary: IssuerRatingSummary = {
      average: rows.length > 0 ? Math.round((sum / rows.length) * 100) / 100 : 0,
      total_ratings: rows.length,
      total_invoices: distinctInvoices.size,
      below_minimum: rows.length < 3,
    };
    this.setCached(cacheKey, summary);
    return summary;
  }
}

export function createInvoiceRatingService(dataSource: DataSource): InvoiceRatingService {
  return new InvoiceRatingService(dataSource);
}
