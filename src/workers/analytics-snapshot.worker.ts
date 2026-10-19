import { DataSource } from "typeorm";
import { AnalyticsSnapshotService } from "../services/analytics-snapshot.service";
import { logger } from "../observability/logger";

/**
 * Runs the daily analytics snapshot job once, capturing current platform metrics.
 * Designed to be called by a scheduler (e.g. node-cron) daily at midnight UTC.
 *
 * This function is idempotent: re-running it on the same day overwrites the existing snapshot.
 */
export async function runAnalyticsSnapshotJob(dataSource: DataSource): Promise<void> {
  const startedAt = Date.now();
  const jobDate = new Date().toISOString().slice(0, 10);

  logger.info("AnalyticsSnapshotJob: Starting", { jobDate });

  try {
    const service = new AnalyticsSnapshotService(dataSource);
    const snapshot = await service.captureSnapshot();

    const durationMs = Date.now() - startedAt;

    logger.info("AnalyticsSnapshotJob: Completed successfully", {
      jobDate,
      durationMs,
      snapshotDate: snapshot.snapshotDate,
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
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logger.error("AnalyticsSnapshotJob: Failed", {
      jobDate,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Schedules the analytics snapshot job to run daily at midnight UTC using node-cron.
 *
 * Returns a stop function that cancels the schedule. Call it on graceful shutdown.
 */
export function scheduleAnalyticsSnapshotJob(dataSource: DataSource): { stop: () => void } {
  // We use setInterval as a zero-dependency approach; for production use
  // node-cron or a proper scheduler. The interval is calculated to fire at
  // the next midnight UTC and then repeat every 24 hours.

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function msUntilMidnightUTC(): number {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return tomorrow.getTime() - now.getTime();
  }

  async function runJob(): Promise<void> {
    if (stopped) return;
    try {
      await runAnalyticsSnapshotJob(dataSource);
    } catch {
      // Errors already logged inside runAnalyticsSnapshotJob
    }
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
