import { DataSource } from "typeorm";
import {
  AnalyticsSnapshotService,
  AnalyticsSnapshotDTO,
  getPreviousUtcDay,
  getUtcReportingDayBounds,
} from "../services/analytics-snapshot.service";
import { AnalyticsSnapshot } from "../models/AnalyticsSnapshot.model";
import { logger } from "../observability/logger";

export interface RunAnalyticsSnapshotJobOptions {
  /**
   * Reference run time (defaults to Date.now()).
   * When targetDate is not specified, targetDate is computed as the previous complete UTC day relative to this runTime.
   */
  runTime?: Date;

  /**
   * Explicit target reporting date to capture (Date or string 'YYYY-MM-DD').
   * If provided, overrides the default calculation of previous complete UTC day.
   */
  targetDate?: Date | string;

  /**
   * Number of retries on failure (default: 3).
   */
  maxRetries?: number;

  /**
   * Base delay between retries in milliseconds (default: 1000).
   */
  retryDelayMs?: number;
}

export interface CatchUpOptions {
  /**
   * Reference run time (defaults to Date.now()).
   */
  runTime?: Date;

  /**
   * Maximum number of preceding complete UTC days to inspect for missing snapshots (default: 7).
   */
  maxCatchUpDays?: number;

  /**
   * Retry attempts per missing day (default: 3).
   */
  maxRetries?: number;

  /**
   * Base delay between retries in milliseconds (default: 1000).
   */
  retryDelayMs?: number;
}

export interface ScheduleAnalyticsSnapshotJobOptions {
  /**
   * Whether to check and catch up missed snapshots upon scheduler startup (default: true).
   */
  catchUpOnStartup?: boolean;

  /**
   * Maximum number of preceding complete UTC days to inspect for missing snapshots (default: 7).
   */
  maxCatchUpDays?: number;

  /**
   * Retry attempts per execution (default: 3).
   */
  maxRetries?: number;

  /**
   * Base delay between retries in milliseconds (default: 1000).
   */
  retryDelayMs?: number;
}

/**
 * Calculates milliseconds from reference time until the next midnight UTC.
 * Independent of the host's local timezone.
 */
export function msUntilMidnightUTC(now: Date = new Date()): number {
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );
  return tomorrow.getTime() - now.getTime();
}

/**
 * Runs the daily analytics snapshot job once, capturing previous complete UTC day metrics.
 * Designed to be called by a scheduler daily at midnight UTC, or manually for a target date.
 *
 * Separates the run time from the funding interval being archived:
 * A run at 00:00 UTC archives the previous date's full funding interval.
 *
 * Idempotent: re-running for the same date updates that date's row in-place.
 * Retries on transient failure up to maxRetries.
 */
export async function runAnalyticsSnapshotJob(
  dataSource: DataSource,
  options?: RunAnalyticsSnapshotJobOptions | Date
): Promise<AnalyticsSnapshotDTO> {
  const opts: RunAnalyticsSnapshotJobOptions =
    options instanceof Date ? { runTime: options } : (options ?? {});

  const startedAt = Date.now();
  const runTime = opts.runTime ?? new Date();
  const targetDate = opts.targetDate ?? getPreviousUtcDay(runTime);
  const bounds = getUtcReportingDayBounds(targetDate);
  const reportingDate = bounds.snapshotDate;
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  logger.info("AnalyticsSnapshotJob: Starting", {
    jobRunTime: runTime.toISOString(),
    reportingDate,
    intervalStart: bounds.dayStart.toISOString(),
    intervalEnd: bounds.dayEnd.toISOString(),
    maxRetries,
  });

  const service = new AnalyticsSnapshotService(dataSource);

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const snapshot = await service.captureSnapshot({
        targetDate,
        runTime,
      });

      const durationMs = Date.now() - startedAt;

      logger.info("AnalyticsSnapshotJob: Completed successfully", {
        jobRunTime: runTime.toISOString(),
        reportingDate,
        snapshotDate: snapshot.snapshotDate,
        attempt,
        durationMs,
        totalInvoices: snapshot.totalInvoices,
        dailyFundingVolume: snapshot.dailyFundingVolume,
        cumulativeFundingVolume: snapshot.cumulativeFundingVolume,
        activeInvestorCount: snapshot.activeInvestorCount,
        settlementRate: snapshot.settlementRate,
        invoicesByStatus: {
          draft: snapshot.totalInvoicesDraft,
          pending: snapshot.totalInvoicesPending,
          published: snapshot.totalInvoicesPublished,
          funded: snapshot.totalInvoicesFunded,
          settled: snapshot.totalInvoicesSettled,
          cancelled: snapshot.totalInvoicesCancelled,
          rejected: snapshot.totalInvoicesRejected,
        },
      });

      return snapshot;
    } catch (error) {
      const isLastAttempt = attempt > maxRetries;
      if (isLastAttempt) {
        const durationMs = Date.now() - startedAt;
        logger.error("AnalyticsSnapshotJob: Failed all retry attempts", {
          jobRunTime: runTime.toISOString(),
          reportingDate,
          attempt,
          durationMs,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }

      logger.warn("AnalyticsSnapshotJob: Attempt failed, retrying...", {
        jobRunTime: runTime.toISOString(),
        reportingDate,
        attempt,
        nextAttemptDelayMs: retryDelayMs * attempt,
        error: error instanceof Error ? error.message : String(error),
      });

      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

  throw new Error("AnalyticsSnapshotJob: Exhausted retries without outcome");
}

/**
 * Checks for missing daily analytics snapshots prior to current day (up to maxCatchUpDays)
 * and captures them in chronological order.
 * Returns the list of date keys successfully captured.
 */
export async function catchUpMissedSnapshots(
  dataSource: DataSource,
  options?: CatchUpOptions
): Promise<string[]> {
  const runTime = options?.runTime ?? new Date();
  const maxDays = Math.max(1, options?.maxCatchUpDays ?? 7);
  const snapshotRepo = dataSource.getRepository(AnalyticsSnapshot);

  const missingDates: string[] = [];

  // Check from yesterday backwards up to maxDays
  for (let i = 1; i <= maxDays; i++) {
    const checkDate = new Date(
      Date.UTC(
        runTime.getUTCFullYear(),
        runTime.getUTCMonth(),
        runTime.getUTCDate() - i,
        0,
        0,
        0,
        0
      )
    );
    const dateKey = checkDate.toISOString().slice(0, 10);
    const existing = await snapshotRepo.findOne({ where: { snapshotDate: dateKey } });
    if (!existing) {
      missingDates.push(dateKey);
    }
  }

  if (missingDates.length === 0) {
    logger.info("AnalyticsSnapshotJob: No missed daily snapshots found", {
      checkedDays: maxDays,
    });
    return [];
  }

  // Process chronological (oldest missing date first)
  missingDates.sort();

  logger.warn("AnalyticsSnapshotJob: Found missed daily snapshots to catch up", {
    missingDates,
  });

  const capturedDates: string[] = [];
  for (const dateKey of missingDates) {
    try {
      await runAnalyticsSnapshotJob(dataSource, {
        targetDate: dateKey,
        runTime,
        maxRetries: options?.maxRetries,
        retryDelayMs: options?.retryDelayMs,
      });
      capturedDates.push(dateKey);
      logger.info("AnalyticsSnapshotJob: Successfully caught up missed snapshot", {
        snapshotDate: dateKey,
      });
    } catch (error) {
      logger.error("AnalyticsSnapshotJob: Failed to catch up missed snapshot", {
        snapshotDate: dateKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return capturedDates;
}

/**
 * Schedules the analytics snapshot job to run daily at midnight UTC.
 * On startup, optionally checks and catches up any missed daily captures.
 *
 * Returns a stop function that cancels the schedule. Call it on graceful shutdown.
 */
export function scheduleAnalyticsSnapshotJob(
  dataSource: DataSource,
  options?: ScheduleAnalyticsSnapshotJobOptions
): { stop: () => void } {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function runJob(): Promise<void> {
    if (stopped) return;
    try {
      await runAnalyticsSnapshotJob(dataSource, {
        maxRetries: options?.maxRetries,
        retryDelayMs: options?.retryDelayMs,
      });
    } catch {
      // Errors already logged and retried inside runAnalyticsSnapshotJob
    }
  }

  // Startup catch-up check for missed captures
  if (options?.catchUpOnStartup !== false) {
    void catchUpMissedSnapshots(dataSource, {
      maxCatchUpDays: options?.maxCatchUpDays,
      maxRetries: options?.maxRetries,
      retryDelayMs: options?.retryDelayMs,
    }).catch((err) => {
      logger.error("AnalyticsSnapshotJob: Startup catch-up check encountered an error", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  const delayMs = msUntilMidnightUTC();
  logger.info("AnalyticsSnapshotJob: Scheduled", {
    firstRunInMs: delayMs,
    firstRunAt: new Date(Date.now() + delayMs).toISOString(),
  });

  timeout = setTimeout(() => {
    if (stopped) return;
    void runJob();
    // After first midnight fire, run every 24 hours
    interval = setInterval(() => void runJob(), 24 * 60 * 60 * 1000);
    if (interval.unref) interval.unref();
  }, delayMs);

  if (timeout.unref) timeout.unref();

  return {
    stop() {
      stopped = true;
      if (timeout) clearTimeout(timeout);
      if (interval) clearInterval(interval);
      logger.info("AnalyticsSnapshotJob: Scheduler stopped");
    },
  };
}
