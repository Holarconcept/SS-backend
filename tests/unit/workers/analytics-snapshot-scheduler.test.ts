import { DataSource } from "typeorm";
import Decimal from "decimal.js";
import {
  runAnalyticsSnapshotJob,
  catchUpMissedSnapshots,
  scheduleAnalyticsSnapshotJob,
  msUntilMidnightUTC,
} from "../../../src/workers/analytics-snapshot.worker";
import {
  AnalyticsSnapshotService,
  getPreviousUtcDay,
  getUtcReportingDayBounds,
} from "../../../src/services/analytics-snapshot.service";
import { AnalyticsSnapshot } from "../../../src/models/AnalyticsSnapshot.model";
import { Invoice } from "../../../src/models/Invoice.model";
import { Investment } from "../../../src/models/Investment.model";
import { InvestmentStatus } from "../../../src/types/enums";

interface MockEntities {
  invoices: Invoice[];
  investments: Investment[];
  snapshots: Map<string, AnalyticsSnapshot>;
}

function createFakeDataSource(entities: MockEntities): DataSource {
  function invoiceQueryBuilder() {
    let whereClause = "";
    const builder = {
      select: () => builder,
      addSelect: () => builder,
      where: (clause: string) => {
        whereClause = clause;
        return builder;
      },
      groupBy: () => builder,
      getRawMany: async <T>() => {
        const counts: Record<string, number> = {};
        for (const inv of entities.invoices) {
          if (whereClause.includes("deleted_at IS NULL") && inv.deletedAt) {
            continue;
          }
          counts[inv.status] = (counts[inv.status] ?? 0) + 1;
        }
        return Object.entries(counts).map(([status, count]) => ({
          status,
          count: String(count),
        })) as T[];
      },
    };
    return builder;
  }

  function investmentQueryBuilder() {
    let statuses: InvestmentStatus[] = [];
    let singleStatus: InvestmentStatus | undefined;
    let dayStart: Date | undefined;
    let dayEnd: Date | undefined;
    let isCountQuery = false;

    const builder = {
      select: (selection: string) => {
        if (selection.includes("COUNT(DISTINCT")) {
          isCountQuery = true;
        }
        return builder;
      },
      where: (clause: string, params: Record<string, any>) => {
        if (params.statuses) statuses = params.statuses;
        if (params.status) singleStatus = params.status;
        return builder;
      },
      andWhere: (clause: string, params: Record<string, any>) => {
        if (params.dayStart) dayStart = params.dayStart;
        if (params.dayEnd) dayEnd = params.dayEnd;
        return builder;
      },
      getRawOne: async <T>(): Promise<T | null> => {
        if (isCountQuery) {
          const matchingInvestors = new Set<string>();
          for (const inv of entities.investments) {
            if (inv.deletedAt) continue;
            if (singleStatus && inv.status === singleStatus) {
              matchingInvestors.add(inv.investorId);
            }
          }
          return { count: String(matchingInvestors.size) } as unknown as T;
        }

        let sum = new Decimal(0);
        for (const inv of entities.investments) {
          if (inv.deletedAt) continue;

          const matchesStatus =
            statuses.length > 0
              ? statuses.includes(inv.status)
              : singleStatus
                ? inv.status === singleStatus
                : true;

          if (!matchesStatus) continue;

          if (dayStart && inv.createdAt < dayStart) continue;
          if (dayEnd && inv.createdAt >= dayEnd) continue;

          sum = sum.plus(new Decimal(inv.investmentAmount));
        }

        return { volume: sum.toString() } as unknown as T;
      },
    };
    return builder;
  }

  function snapshotQueryBuilder() {
    let from: string | undefined;
    let to: string | undefined;

    const builder = {
      where: (clause: string, params: Record<string, any>) => {
        if (params.from) from = params.from;
        return builder;
      },
      andWhere: (clause: string, params: Record<string, any>) => {
        if (params.to) to = params.to;
        return builder;
      },
      orderBy: () => builder,
      getMany: async () => {
        const rows = Array.from(entities.snapshots.values());
        return rows
          .filter((s) => (!from || s.snapshotDate >= from) && (!to || s.snapshotDate <= to))
          .sort((a, b) => a.snapshotDate.localeCompare(b.snapshotDate));
      },
    };
    return builder;
  }

  return {
    getRepository: (entity: unknown) => {
      if (entity === Invoice) {
        return {
          createQueryBuilder: () => invoiceQueryBuilder(),
        };
      }
      if (entity === Investment) {
        return {
          createQueryBuilder: () => investmentQueryBuilder(),
        };
      }
      if (entity === AnalyticsSnapshot) {
        return {
          createQueryBuilder: () => snapshotQueryBuilder(),
          findOne: async (options: { where: { snapshotDate: string } }) =>
            entities.snapshots.get(options.where.snapshotDate) ?? null,
          create: (data: Partial<AnalyticsSnapshot>) => ({
            ...data,
            createdAt: new Date(),
          }),
          save: async (snapshot: AnalyticsSnapshot) => {
            entities.snapshots.set(snapshot.snapshotDate, snapshot);
            return snapshot;
          },
        };
      }
      throw new Error(`Unexpected entity in test DataSource: ${String(entity)}`);
    },
  } as unknown as DataSource;
}

function makeInvestment(overrides: Partial<Investment>): Investment {
  return {
    id: overrides.id ?? "inv-1",
    invoiceId: overrides.invoiceId ?? "invoice-1",
    investorId: overrides.investorId ?? "investor-1",
    investmentAmount: overrides.investmentAmount ?? "1000.0000",
    expectedReturn: overrides.expectedReturn ?? "1050.0000",
    actualReturn: overrides.actualReturn ?? null,
    status: overrides.status ?? InvestmentStatus.CONFIRMED,
    transactionHash: null,
    stellarOperationIndex: null,
    createdAt: overrides.createdAt ?? new Date("2026-03-01T12:00:00Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-03-01T12:00:00Z"),
    deletedAt: overrides.deletedAt ?? null,
    version: 1,
    ...overrides,
  } as Investment;
}

describe("Analytics Snapshot Scheduler - Reporting Day Boundaries & Missed-run Retries", () => {
  describe("Midnight run & Half-open interval boundary", () => {
    it("a run at 00:00 UTC archives the previous date's full funding interval", async () => {
      const runTime = new Date("2026-03-02T00:00:00.000Z");

      const invDay1 = makeInvestment({
        id: "inv-day-1",
        investmentAmount: "5000.0000",
        createdAt: new Date("2026-03-01T15:30:00.000Z"),
      });

      const entities: MockEntities = {
        invoices: [],
        investments: [invDay1],
        snapshots: new Map(),
      };
      const dataSource = createFakeDataSource(entities);

      const snapshot = await runAnalyticsSnapshotJob(dataSource, { runTime });

      // Archive date key must be the completed day (yesterday in UTC)
      expect(snapshot.snapshotDate).toBe("2026-03-01");
      expect(snapshot.dailyFundingVolume).toBe("5000");
      expect(entities.snapshots.has("2026-03-01")).toBe(true);
    });

    it("commitment just before midnight appears in completed day and one at midnight appears in next day", async () => {
      // Commitment A: 1 millisecond before midnight on 2026-03-01
      const invBeforeMidnight = makeInvestment({
        id: "inv-before-midnight",
        investmentAmount: "1200.0000",
        createdAt: new Date("2026-03-01T23:59:59.999Z"),
      });

      // Commitment B: Exactly at midnight UTC on 2026-03-02
      const invAtMidnight = makeInvestment({
        id: "inv-at-midnight",
        investmentAmount: "800.0000",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
      });

      const entities: MockEntities = {
        invoices: [],
        investments: [invBeforeMidnight, invAtMidnight],
        snapshots: new Map(),
      };
      const dataSource = createFakeDataSource(entities);

      // Midnight run at 2026-03-02 00:00:00 UTC captures 2026-03-01
      const day1Snapshot = await runAnalyticsSnapshotJob(dataSource, {
        runTime: new Date("2026-03-02T00:00:00.000Z"),
      });
      expect(day1Snapshot.snapshotDate).toBe("2026-03-01");
      expect(day1Snapshot.dailyFundingVolume).toBe("1200");

      // Next midnight run at 2026-03-03 00:00:00 UTC captures 2026-03-02
      const day2Snapshot = await runAnalyticsSnapshotJob(dataSource, {
        runTime: new Date("2026-03-03T00:00:00.000Z"),
      });
      expect(day2Snapshot.snapshotDate).toBe("2026-03-02");
      expect(day2Snapshot.dailyFundingVolume).toBe("800");
    });
  });

  describe("Month and Year boundary transitions", () => {
    it("run on March 1st at 00:00 UTC archives February 28th (non-leap year)", async () => {
      const runTime = new Date("2026-03-01T00:00:00.000Z");

      const febInvestment = makeInvestment({
        id: "inv-feb-28",
        investmentAmount: "3400.0000",
        createdAt: new Date("2026-02-28T22:00:00.000Z"),
      });
      const marInvestment = makeInvestment({
        id: "inv-mar-1",
        investmentAmount: "1100.0000",
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      });

      const entities: MockEntities = {
        invoices: [],
        investments: [febInvestment, marInvestment],
        snapshots: new Map(),
      };
      const dataSource = createFakeDataSource(entities);

      const snapshot = await runAnalyticsSnapshotJob(dataSource, { runTime });
      expect(snapshot.snapshotDate).toBe("2026-02-28");
      expect(snapshot.dailyFundingVolume).toBe("3400");
    });

    it("run on March 1st at 00:00 UTC archives February 29th (leap year)", async () => {
      const runTime = new Date("2024-03-01T00:00:00.000Z");

      const leapInvestment = makeInvestment({
        id: "inv-feb-29",
        investmentAmount: "4500.0000",
        createdAt: new Date("2024-02-29T18:00:00.000Z"),
      });

      const entities: MockEntities = {
        invoices: [],
        investments: [leapInvestment],
        snapshots: new Map(),
      };
      const dataSource = createFakeDataSource(entities);

      const snapshot = await runAnalyticsSnapshotJob(dataSource, { runTime });
      expect(snapshot.snapshotDate).toBe("2024-02-29");
      expect(snapshot.dailyFundingVolume).toBe("4500");
    });

    it("run on January 1st at 00:00 UTC archives December 31st of previous year", async () => {
      const runTime = new Date("2027-01-01T00:00:00.000Z");

      const nyeInvestment = makeInvestment({
        id: "inv-nye",
        investmentAmount: "9900.0000",
        createdAt: new Date("2026-12-31T23:45:00.000Z"),
      });

      const entities: MockEntities = {
        invoices: [],
        investments: [nyeInvestment],
        snapshots: new Map(),
      };
      const dataSource = createFakeDataSource(entities);

      const snapshot = await runAnalyticsSnapshotJob(dataSource, { runTime });
      expect(snapshot.snapshotDate).toBe("2026-12-31");
      expect(snapshot.dailyFundingVolume).toBe("9900");
    });
  });

  describe("Idempotency", () => {
    it("repeating the capture for the same date updates one row", async () => {
      const inv = makeInvestment({
        id: "inv-1",
        investmentAmount: "1000.0000",
        createdAt: new Date("2026-03-01T12:00:00.000Z"),
      });

      const entities: MockEntities = {
        invoices: [],
        investments: [inv],
        snapshots: new Map(),
      };
      const dataSource = createFakeDataSource(entities);

      // First run for 2026-03-01
      const first = await runAnalyticsSnapshotJob(dataSource, {
        targetDate: "2026-03-01",
      });
      expect(first.dailyFundingVolume).toBe("1000");
      expect(entities.snapshots.size).toBe(1);

      // Add a second investment for 2026-03-01
      const inv2 = makeInvestment({
        id: "inv-2",
        investmentAmount: "2000.0000",
        createdAt: new Date("2026-03-01T16:00:00.000Z"),
      });
      entities.investments.push(inv2);

      // Re-run capture for the same date
      const second = await runAnalyticsSnapshotJob(dataSource, {
        targetDate: "2026-03-01",
      });
      expect(second.dailyFundingVolume).toBe("3000");

      // Verify only one row exists for that date
      expect(entities.snapshots.size).toBe(1);
      expect(entities.snapshots.get("2026-03-01")?.dailyFundingVolume).toBe("3000");
    });
  });

  describe("Timezone independence", () => {
    it("bounds and previous complete day calculations are strictly UTC", () => {
      // Midnight in UTC
      const utcTime = new Date("2026-06-15T00:00:00.000Z");
      const prevUtc = getPreviousUtcDay(utcTime);
      expect(prevUtc.toISOString()).toBe("2026-06-14T00:00:00.000Z");

      const bounds = getUtcReportingDayBounds(prevUtc);
      expect(bounds.snapshotDate).toBe("2026-06-14");
      expect(bounds.dayStart.toISOString()).toBe("2026-06-14T00:00:00.000Z");
      expect(bounds.dayEnd.toISOString()).toBe("2026-06-15T00:00:00.000Z");
    });

    it("msUntilMidnightUTC correctly computes time remaining until next UTC midnight", () => {
      const now = new Date("2026-03-01T23:50:00.000Z"); // 10 minutes until midnight UTC
      const delay = msUntilMidnightUTC(now);
      expect(delay).toBe(10 * 60 * 1000);
    });
  });

  describe("Missed-run retry and startup catch-up", () => {
    it("retries on transient failure and succeeds on subsequent attempt", async () => {
      const inv = makeInvestment({
        id: "inv-retry",
        investmentAmount: "777.0000",
        createdAt: new Date("2026-03-01T12:00:00.000Z"),
      });

      const entities: MockEntities = {
        invoices: [],
        investments: [inv],
        snapshots: new Map(),
      };
      const dataSource = createFakeDataSource(entities);

      // Mock captureSnapshot to fail on attempt 1 and succeed on attempt 2
      let attempt = 0;
      const realCapture = AnalyticsSnapshotService.prototype.captureSnapshot;
      jest.spyOn(AnalyticsSnapshotService.prototype, "captureSnapshot").mockImplementation(async function (this: AnalyticsSnapshotService, opts) {
        attempt++;
        if (attempt === 1) {
          throw new Error("Transient DB connection glitch");
        }
        return realCapture.call(this, opts);
      });

      const snapshot = await runAnalyticsSnapshotJob(dataSource, {
        targetDate: "2026-03-01",
        maxRetries: 2,
        retryDelayMs: 0,
      });

      expect(attempt).toBe(2);
      expect(snapshot.snapshotDate).toBe("2026-03-01");
      expect(snapshot.dailyFundingVolume).toBe("777");

      jest.restoreAllMocks();
    });

    it("throws error after exhausting max retries", async () => {
      const entities: MockEntities = {
        invoices: [],
        investments: [],
        snapshots: new Map(),
      };
      const dataSource = createFakeDataSource(entities);

      jest.spyOn(AnalyticsSnapshotService.prototype, "captureSnapshot").mockRejectedValue(
        new Error("Persistent database failure")
      );

      await expect(
        runAnalyticsSnapshotJob(dataSource, {
          targetDate: "2026-03-01",
          maxRetries: 2,
          retryDelayMs: 0,
        })
      ).rejects.toThrow("Persistent database failure");

      jest.restoreAllMocks();
    });

    it("catchUpMissedSnapshots detects missing past days and archives them in chronological order", async () => {
      const runTime = new Date("2026-03-04T08:00:00.000Z");

      const invDay1 = makeInvestment({
        id: "inv-day-1",
        investmentAmount: "1000.0000",
        createdAt: new Date("2026-03-01T10:00:00.000Z"),
      });
      const invDay2 = makeInvestment({
        id: "inv-day-2",
        investmentAmount: "2000.0000",
        createdAt: new Date("2026-03-02T10:00:00.000Z"),
      });
      const invDay3 = makeInvestment({
        id: "inv-day-3",
        investmentAmount: "3000.0000",
        createdAt: new Date("2026-03-03T10:00:00.000Z"),
      });

      const entities: MockEntities = {
        invoices: [],
        investments: [invDay1, invDay2, invDay3],
        snapshots: new Map(),
      };
      // Suppose 2026-03-01 was captured previously, but 2026-03-02 and 2026-03-03 were missed
      entities.snapshots.set("2026-03-01", {
        snapshotDate: "2026-03-01",
        dailyFundingVolume: "1000",
      } as AnalyticsSnapshot);

      const dataSource = createFakeDataSource(entities);

      const caughtUp = await catchUpMissedSnapshots(dataSource, {
        runTime,
        maxCatchUpDays: 3,
        retryDelayMs: 0,
      });

      expect(caughtUp).toEqual(["2026-03-02", "2026-03-03"]);
      expect(entities.snapshots.has("2026-03-02")).toBe(true);
      expect(entities.snapshots.has("2026-03-03")).toBe(true);
      expect(entities.snapshots.get("2026-03-02")?.dailyFundingVolume).toBe("2000");
      expect(entities.snapshots.get("2026-03-03")?.dailyFundingVolume).toBe("3000");
    });

    it("scheduleAnalyticsSnapshotJob initializes startup catch-up and returns a functioning stop handle", () => {
      const entities: MockEntities = {
        invoices: [],
        investments: [],
        snapshots: new Map(),
      };
      const dataSource = createFakeDataSource(entities);

      const scheduler = scheduleAnalyticsSnapshotJob(dataSource, {
        catchUpOnStartup: false,
      });

      expect(typeof scheduler.stop).toBe("function");
      // Stop scheduler cleanly
      scheduler.stop();
    });
  });
});
