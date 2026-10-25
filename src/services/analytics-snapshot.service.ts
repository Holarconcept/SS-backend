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

/**
 * Investment statuses that count toward realized funding volume.
 * Realized funding includes active (confirmed) and settled investments,
 * while excluding unfunded commitments (pending) and reversed/abandoned
 * commitments (cancelled).
 */
export const FUNDED_INVESTMENT_STATUSES: readonly InvestmentStatus[] = Object.freeze([
  InvestmentStatus.CONFIRMED,
  InvestmentStatus.SETTLED,
]);

export function isFundedInvestmentStatus(status: InvestmentStatus): boolean {
  return (FUNDED_INVESTMENT_STATUSES as readonly InvestmentStatus[]).includes(status);
}

export interface CaptureSnapshotOptions {
  /**
   * Target reporting date to capture (Date or string 'YYYY-MM-DD').
   * If omitted, derived from runTime or defaults to the previous complete UTC day.
   */
  targetDate?: Date | string;

  /**
   * Reference run time. When targetDate is not specified, targetDate is computed
   * as the previous complete UTC day relative to this runTime.
   */
  runTime?: Date;

  /**
   * Optional custom half-open funding interval [start, end) where end is exclusive.
   * If omitted, the full UTC day [targetDate 00:00:00.000Z, nextDay 00:00:00.000Z) is used.
   */
  fundingInterval?: {
    start: Date;
    end: Date;
  };
}

/**
 * Returns the previous complete UTC day relative to referenceTime (midnight UTC).
 * E.g., at 2026-03-02 00:00:00 UTC, the previous complete UTC day is 2026-03-01.
 */
export function getPreviousUtcDay(referenceTime: Date = new Date()): Date {
  return new Date(
    Date.UTC(
      referenceTime.getUTCFullYear(),
      referenceTime.getUTCMonth(),
      referenceTime.getUTCDate() - 1,
      0,
      0,
      0,
      0
    )
  );
}

/**
 * Calculates the UTC half-open interval [dayStart, dayEnd) and date key (YYYY-MM-DD)
 * for a target reporting date, completely independent of local timezone.
 */
export function getUtcReportingDayBounds(dateOrString?: Date | string): {
  dayStart: Date;
  dayEnd: Date;
  snapshotDate: string;
} {
  const target = dateOrString ?? getPreviousUtcDay();

  let year: number;
  let month: number;
  let day: number;

  if (typeof target === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(target);
    if (match) {
      year = parseInt(match[1], 10);
      month = parseInt(match[2], 10) - 1;
      day = parseInt(match[3], 10);
    } else {
      const parsed = new Date(target);
      year = parsed.getUTCFullYear();
      month = parsed.getUTCMonth();
      day = parsed.getUTCDate();
    }
  } else {
    year = target.getUTCFullYear();
    month = target.getUTCMonth();
    day = target.getUTCDate();
  }

  const dayStart = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  const dayEnd = new Date(Date.UTC(year, month, day + 1, 0, 0, 0, 0));
  const snapshotDate = dayStart.toISOString().slice(0, 10);

  return { dayStart, dayEnd, snapshotDate };
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
   * Captures a platform-wide analytics snapshot for a reporting day (UTC).
   * Separates the run time from the funding interval being archived:
   * by default or when invoked at 00:00 UTC, it archives the previous complete UTC day
   * using the half-open interval [dayStart, dayEnd).
   *
   * If a snapshot for the reporting day already exists, it is updated in-place (idempotent).
   */
  async captureSnapshot(
    optionsOrDate?: Date | string | CaptureSnapshotOptions
  ): Promise<AnalyticsSnapshotDTO> {
    let targetDate: Date | string | undefined;
    let runTime: Date | undefined;
    let customInterval: { start: Date; end: Date } | undefined;

    if (optionsOrDate instanceof Date || typeof optionsOrDate === "string") {
      targetDate = optionsOrDate;
    } else if (optionsOrDate && typeof optionsOrDate === "object") {
      targetDate = optionsOrDate.targetDate;
      runTime = optionsOrDate.runTime;
      customInterval = optionsOrDate.fundingInterval;
    }

    if (!targetDate && runTime) {
      targetDate = getPreviousUtcDay(runTime);
    }

    const bounds = getUtcReportingDayBounds(targetDate);
    const snapshotDate = bounds.snapshotDate;
    const dayStart = customInterval ? customInterval.start : bounds.dayStart;
    const dayEnd = customInterval ? customInterval.end : bounds.dayEnd;

    logger.info("AnalyticsSnapshot: Starting capture", {
      snapshotDate,
      intervalStart: dayStart.toISOString(),
      intervalEnd: dayEnd.toISOString(),
    });

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

    // ---- Daily funding volume (realized investments: confirmed or settled, in [dayStart, dayEnd)) ----
    const dailyVolumeResult = await this.investmentRepo
      .createQueryBuilder("i")
      .select("COALESCE(SUM(CAST(i.investment_amount AS DECIMAL)), 0)", "volume")
      .where("i.status IN (:...statuses)", { statuses: FUNDED_INVESTMENT_STATUSES })
      .andWhere("i.created_at >= :dayStart", { dayStart })
      .andWhere("i.created_at < :dayEnd", { dayEnd })
      .getRawOne<{ volume: string | number }>();

    const dailyFundingVolume =
      dailyVolumeResult?.volume !== undefined && dailyVolumeResult?.volume !== null
        ? String(dailyVolumeResult.volume)
        : "0";

    // ---- Cumulative funding volume (all realized investments confirmed or settled up to dayEnd) ----
    const cumulativeResult = await this.investmentRepo
      .createQueryBuilder("i")
      .select("COALESCE(SUM(CAST(i.investment_amount AS DECIMAL)), 0)", "volume")
      .where("i.status IN (:...statuses)", { statuses: FUNDED_INVESTMENT_STATUSES })
      .andWhere("i.created_at < :dayEnd", { dayEnd })
      .getRawOne<{ volume: string | number }>();

    const cumulativeFundingVolume =
      cumulativeResult?.volume !== undefined && cumulativeResult?.volume !== null
        ? String(cumulativeResult.volume)
        : "0";

    // ---- Active investor count (distinct investors with active confirmed investments) ----
    const activeInvestorResult = await this.investmentRepo
      .createQueryBuilder("i")
      .select("COUNT(DISTINCT i.investor_id)", "count")
      .where("i.status = :status", { status: InvestmentStatus.CONFIRMED })
      .getRawOne<{ count: string | number }>();

    const activeInvestorCount = parseInt(String(activeInvestorResult?.count ?? "0"), 10);

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
