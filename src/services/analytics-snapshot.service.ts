import { DataSource, Repository } from "typeorm";
import { AnalyticsSnapshot } from "../models/AnalyticsSnapshot.model";
import { Invoice } from "../models/Invoice.model";
import { Investment } from "../models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../types/enums";
import { logger } from "../observability/logger";

export interface AnalyticsSnapshotDTO {
  snapshotDate: string;
  totalInvoicesDraft: number;
  totalInvoicesPending: number;
  totalInvoicesPublished: number;
  totalInvoicesFunded: number;
  totalInvoicesSettled: number;
  totalInvoicesCancelled: number;
  totalInvoicesRejected: number;
  totalInvoices: number;
  dailyFundingVolume: string;
  cumulativeFundingVolume: string;
  activeInvestorCount: number;
  settlementRate: string;
  createdAt: string;
}

export interface TrendsResult {
  data: (AnalyticsSnapshotDTO | null)[];
  dates: string[];
  meta: {
    from: string;
    to: string;
    totalDays: number;
  };
}

export class AnalyticsSnapshotService {
  private readonly snapshotRepo: Repository<AnalyticsSnapshot>;
  private readonly invoiceRepo: Repository<Invoice>;
  private readonly investmentRepo: Repository<Investment>;

  constructor(dataSource: DataSource) {
    this.snapshotRepo = dataSource.getRepository(AnalyticsSnapshot);
    this.invoiceRepo = dataSource.getRepository(Invoice);
    this.investmentRepo = dataSource.getRepository(Investment);
  }

  /**
   * Captures a platform-wide analytics snapshot for today (UTC).
   * Called daily at midnight UTC by the cron job.
   * If a snapshot for today already exists, it is overwritten (idempotent).
   */
  async captureSnapshot(dateOverride?: Date): Promise<AnalyticsSnapshotDTO> {
    const now = dateOverride ?? new Date();
    const snapshotDate = this.toDateKey(now);

    logger.info("AnalyticsSnapshot: Starting daily capture", { snapshotDate });

    // ---- Invoice counts by status ----
    const statusCounts = await this.invoiceRepo
      .createQueryBuilder("inv")
      .select("inv.status", "status")
      .addSelect("COUNT(inv.id)", "count")
      .where("inv.deleted_at IS NULL")
      .groupBy("inv.status")
      .getRawMany<{ status: string; count: string }>();

    const countMap: Record<string, number> = {};
    for (const row of statusCounts) {
      countMap[row.status] = parseInt(row.count, 10);
    }

    const totalInvoicesDraft = countMap[InvoiceStatus.DRAFT] ?? 0;
    const totalInvoicesPending = countMap[InvoiceStatus.PENDING] ?? 0;
    const totalInvoicesPublished = countMap[InvoiceStatus.PUBLISHED] ?? 0;
    const totalInvoicesFunded = countMap[InvoiceStatus.FUNDED] ?? 0;
    const totalInvoicesSettled = countMap[InvoiceStatus.SETTLED] ?? 0;
    const totalInvoicesCancelled = countMap[InvoiceStatus.CANCELLED] ?? 0;
    const totalInvoicesRejected = countMap[InvoiceStatus.REJECTED] ?? 0;
    const totalInvoices = Object.values(countMap).reduce((a, b) => a + b, 0);

    // ---- Daily funding volume (confirmed investments created today) ----
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const dailyVolumeResult = await this.investmentRepo
      .createQueryBuilder("i")
      .select("COALESCE(SUM(CAST(i.investment_amount AS DECIMAL)), 0)", "volume")
      .where("i.status = :status", { status: InvestmentStatus.CONFIRMED })
      .andWhere("i.created_at >= :dayStart", { dayStart })
      .andWhere("i.created_at <= :dayEnd", { dayEnd })
      .getRawOne<{ volume: string }>();

    const dailyFundingVolume = dailyVolumeResult?.volume ?? "0";

    // ---- Cumulative funding volume (all confirmed investments) ----
    const cumulativeResult = await this.investmentRepo
      .createQueryBuilder("i")
      .select("COALESCE(SUM(CAST(i.investment_amount AS DECIMAL)), 0)", "volume")
      .where("i.status = :status", { status: InvestmentStatus.CONFIRMED })
      .getRawOne<{ volume: string }>();

    const cumulativeFundingVolume = cumulativeResult?.volume ?? "0";

    // ---- Active investor count (distinct investors with confirmed investments) ----
    const activeInvestorResult = await this.investmentRepo
      .createQueryBuilder("i")
      .select("COUNT(DISTINCT i.investor_id)", "count")
      .where("i.status = :status", { status: InvestmentStatus.CONFIRMED })
      .getRawOne<{ count: string }>();

    const activeInvestorCount = parseInt(activeInvestorResult?.count ?? "0", 10);

    // ---- Settlement rate ----
    // Ratio of settled to (settled + funded)
    const totalFundedOrSettled = totalInvoicesSettled + totalInvoicesFunded;
    const settlementRateNum =
      totalFundedOrSettled > 0
        ? ((totalInvoicesSettled / totalFundedOrSettled) * 100).toFixed(2)
        : "0.00";

    // Upsert the snapshot (overwrite if already exists for today)
    const existing = await this.snapshotRepo.findOne({ where: { snapshotDate } });
    const snapshot = existing ?? this.snapshotRepo.create({ snapshotDate });

    snapshot.totalInvoicesDraft = totalInvoicesDraft;
    snapshot.totalInvoicesPending = totalInvoicesPending;
    snapshot.totalInvoicesPublished = totalInvoicesPublished;
    snapshot.totalInvoicesFunded = totalInvoicesFunded;
    snapshot.totalInvoicesSettled = totalInvoicesSettled;
    snapshot.totalInvoicesCancelled = totalInvoicesCancelled;
    snapshot.totalInvoicesRejected = totalInvoicesRejected;
    snapshot.totalInvoices = totalInvoices;
    snapshot.dailyFundingVolume = dailyFundingVolume;
    snapshot.cumulativeFundingVolume = cumulativeFundingVolume;
    snapshot.activeInvestorCount = activeInvestorCount;
    snapshot.settlementRate = settlementRateNum;

    await this.snapshotRepo.save(snapshot);

    logger.info("AnalyticsSnapshot: Snapshot saved", {
      snapshotDate,
      totalInvoices,
      dailyFundingVolume,
      activeInvestorCount,
      settlementRate: settlementRateNum,
    });

    return this.toDTO(snapshot);
  }

  /**
   * Returns snapshot history for a date range.
   * Dates with no snapshot return null in the data array.
   */
  async getTrends(from: Date, to: Date): Promise<TrendsResult> {
    // Clamp to max 365 days
    const fromKey = this.toDateKey(from);
    const toKey = this.toDateKey(to);

    const rows = await this.snapshotRepo
      .createQueryBuilder("s")
      .where("s.snapshot_date >= :from", { from: fromKey })
      .andWhere("s.snapshot_date <= :to", { to: toKey })
      .orderBy("s.snapshot_date", "ASC")
      .getMany();

    const rowMap = new Map<string, AnalyticsSnapshot>();
    for (const row of rows) {
      rowMap.set(row.snapshotDate, row);
    }

    // Generate the full list of dates in the range
    const dates: string[] = [];
    const current = new Date(from);
    current.setUTCHours(0, 0, 0, 0);
    const endDate = new Date(to);
    endDate.setUTCHours(0, 0, 0, 0);

    while (current <= endDate) {
      dates.push(this.toDateKey(current));
      current.setUTCDate(current.getUTCDate() + 1);
    }

    const data: (AnalyticsSnapshotDTO | null)[] = dates.map((d) => {
      const row = rowMap.get(d);
      return row ? this.toDTO(row) : null;
    });

    return {
      data,
      dates,
      meta: {
        from: fromKey,
        to: toKey,
        totalDays: dates.length,
      },
    };
  }

  private toDateKey(date: Date): string {
    return date.toISOString().slice(0, 10); // "YYYY-MM-DD"
  }

  private toDTO(snapshot: AnalyticsSnapshot): AnalyticsSnapshotDTO {
    return {
      snapshotDate: snapshot.snapshotDate,
      totalInvoicesDraft: snapshot.totalInvoicesDraft,
      totalInvoicesPending: snapshot.totalInvoicesPending,
      totalInvoicesPublished: snapshot.totalInvoicesPublished,
      totalInvoicesFunded: snapshot.totalInvoicesFunded,
      totalInvoicesSettled: snapshot.totalInvoicesSettled,
      totalInvoicesCancelled: snapshot.totalInvoicesCancelled,
      totalInvoicesRejected: snapshot.totalInvoicesRejected,
      totalInvoices: snapshot.totalInvoices,
      dailyFundingVolume: snapshot.dailyFundingVolume,
      cumulativeFundingVolume: snapshot.cumulativeFundingVolume,
      activeInvestorCount: snapshot.activeInvestorCount,
      settlementRate: snapshot.settlementRate,
      createdAt: snapshot.createdAt.toISOString(),
    };
  }
}

export function createAnalyticsSnapshotService(dataSource: DataSource): AnalyticsSnapshotService {
  return new AnalyticsSnapshotService(dataSource);
}
