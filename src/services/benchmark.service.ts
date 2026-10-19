import { DataSource } from "typeorm";
import { SectorBenchmark } from "../models/SectorBenchmark.model";
import { Invoice } from "../models/Invoice.model";
import { ServiceError } from "../utils/service-error";
import { TtlCache } from "../lib/ttl-cache";

const CACHE_TTL_MS = 5 * 60 * 1000;

export interface BenchmarkUpdatedEvent {
  sector: string;
  avgYield: string;
  avgDaysToSettle: string;
  defaultRate: string;
  sampleCount?: number;
  eventId?: string;
  occurredAt?: Date;
}

export interface SectorBenchmarkView {
  sector: string;
  avgYield: string;
  avgDaysToSettle: string;
  defaultRate: string;
  sampleCount: number;
  updatedAt: string;
}

export interface InvoiceBenchmarkComparison {
  invoiceId: string;
  sector: string | null;
  invoice: {
    yield: string;
    daysToSettle: number | null;
    amount: string;
    status: string;
  };
  benchmark: SectorBenchmarkView | null;
}

/**
 * Sector benchmark aggregates (#676). `ingestBenchmarkUpdated` is the
 * indexer entry point for BenchmarkUpdated contract events; reads go
 * through a 5-minute TTL cache that is invalidated per sector on write.
 */
export class BenchmarkService {
  private readonly cache = new TtlCache<SectorBenchmarkView>(CACHE_TTL_MS);
  private readonly comparisonCache = new TtlCache<InvoiceBenchmarkComparison>(CACHE_TTL_MS);

  constructor(private readonly dataSource: DataSource) {}

  /** Indexer: upsert sector averages from a BenchmarkUpdated event. */
  async ingestBenchmarkUpdated(event: BenchmarkUpdatedEvent): Promise<SectorBenchmark> {
    const sector = event.sector.trim().toLowerCase();
    if (!sector) {
      throw new ServiceError("INVALID_SECTOR", "sector is required", 400);
    }

    const repo = this.dataSource.getRepository(SectorBenchmark);
    let row = await repo.findOneBy({ sector });
    if (!row) {
      row = repo.create({ sector });
    }

    row.avgYield = event.avgYield;
    row.avgDaysToSettle = event.avgDaysToSettle;
    row.defaultRate = event.defaultRate;
    if (event.sampleCount !== undefined) row.sampleCount = event.sampleCount;
    if (event.eventId) row.lastEventId = event.eventId;

    const saved = await repo.save(row);

    this.cache.invalidatePrefix(sector);
    this.comparisonCache.clear();
    return saved;
  }

  async getSectorBenchmark(sector: string): Promise<SectorBenchmarkView> {
    const normalized = sector.trim().toLowerCase();
    const cached = this.cache.get(normalized);
    if (cached) return cached;

    const row = await this.dataSource.getRepository(SectorBenchmark).findOneBy({
      sector: normalized,
    });
    if (!row) {
      throw new ServiceError(
        "BENCHMARK_NOT_FOUND",
        `No benchmark data for sector "${normalized}"`,
        404,
      );
    }

    const view = toView(row);
    this.cache.set(normalized, view);
    return view;
  }

  /** Invoice metrics side-by-side with its sector benchmark (#676). */
  async getInvoiceBenchmark(invoiceId: string): Promise<InvoiceBenchmarkComparison> {
    const cached = this.comparisonCache.get(invoiceId);
    if (cached) return cached;

    const invoice = await this.dataSource.getRepository(Invoice).findOneBy({ id: invoiceId });
    if (!invoice) {
      throw new ServiceError("INVOICE_NOT_FOUND", "Invoice not found", 404);
    }

    let benchmark: SectorBenchmarkView | null = null;
    if (invoice.category) {
      try {
        benchmark = await this.getSectorBenchmark(invoice.category);
      } catch (err) {
        if ((err as ServiceError).code !== "BENCHMARK_NOT_FOUND") throw err;
      }
    }

    const comparison: InvoiceBenchmarkComparison = {
      invoiceId: invoice.id,
      sector: invoice.category,
      invoice: {
        yield: invoice.discountRate,
        daysToSettle: daysToSettle(invoice),
        amount: invoice.amount,
        status: invoice.status,
      },
      benchmark,
    };

    this.comparisonCache.set(invoiceId, comparison);
    return comparison;
  }

  invalidateSector(sector: string): void {
    this.cache.invalidatePrefix(sector.trim().toLowerCase());
    this.comparisonCache.clear();
  }
}

function toView(row: SectorBenchmark): SectorBenchmarkView {
  return {
    sector: row.sector,
    avgYield: row.avgYield,
    avgDaysToSettle: row.avgDaysToSettle,
    defaultRate: row.defaultRate,
    sampleCount: row.sampleCount,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function daysToSettle(invoice: Invoice): number | null {
  const due =
    invoice.dueDate instanceof Date ? invoice.dueDate : new Date(invoice.dueDate as unknown as string);
  const created = invoice.createdAt;
  if (Number.isNaN(due.getTime()) || Number.isNaN(created.getTime())) return null;
  return Math.max(0, Math.round((due.getTime() - created.getTime()) / 86_400_000));
}

export function createBenchmarkService(dataSource: DataSource): BenchmarkService {
  return new BenchmarkService(dataSource);
}
