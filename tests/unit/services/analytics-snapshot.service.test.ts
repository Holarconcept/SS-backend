import { DataSource } from "typeorm";
import Decimal from "decimal.js";
import {
  AnalyticsSnapshotService,
  FUNDED_INVESTMENT_STATUSES,
  isFundedInvestmentStatus,
} from "../../../src/services/analytics-snapshot.service";
import { AnalyticsSnapshot } from "../../../src/models/AnalyticsSnapshot.model";
import { Invoice } from "../../../src/models/Invoice.model";
import { Investment } from "../../../src/models/Investment.model";
import { InvoiceStatus, InvestmentStatus } from "../../../src/types/enums";

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
        if (params.statuses) {
          statuses = params.statuses;
        }
        if (params.status) {
          singleStatus = params.status;
        }
        return builder;
      },
      andWhere: (clause: string, params: Record<string, any>) => {
        if (params.dayStart) {
          dayStart = params.dayStart;
        }
        if (params.dayEnd) {
          dayEnd = params.dayEnd;
        }
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

function makeInvoice(overrides: Partial<Invoice>): Invoice {
  return {
    id: overrides.id ?? "invoice-1",
    sellerId: "seller-1",
    invoiceNumber: "INV-001",
    customerName: "Acme Corp",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: new Date("2026-04-01T00:00:00Z"),
    ipfsHash: null,
    riskScore: null,
    status: overrides.status ?? InvoiceStatus.FUNDED,
    smartContractId: null,
    createdAt: new Date("2026-02-01T00:00:00Z"),
    updatedAt: new Date("2026-02-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as Invoice;
}

describe("AnalyticsSnapshotService - Funded Volume Preservation (#717)", () => {
  describe("FUNDED_INVESTMENT_STATUSES membership", () => {
    it("defines funded volume membership independently from active status", () => {
      expect(FUNDED_INVESTMENT_STATUSES).toContain(InvestmentStatus.CONFIRMED);
      expect(FUNDED_INVESTMENT_STATUSES).toContain(InvestmentStatus.SETTLED);
      expect(FUNDED_INVESTMENT_STATUSES).not.toContain(InvestmentStatus.PENDING);
      expect(FUNDED_INVESTMENT_STATUSES).not.toContain(InvestmentStatus.CANCELLED);
    });

    it("isFundedInvestmentStatus helper correctly identifies funded vs unfunded statuses", () => {
      expect(isFundedInvestmentStatus(InvestmentStatus.CONFIRMED)).toBe(true);
      expect(isFundedInvestmentStatus(InvestmentStatus.SETTLED)).toBe(true);
      expect(isFundedInvestmentStatus(InvestmentStatus.PENDING)).toBe(false);
      expect(isFundedInvestmentStatus(InvestmentStatus.CANCELLED)).toBe(false);
    });
  });

  describe("Settling investments preserves cumulative and daily volume", () => {
    it("settling a confirmed investment does not reduce cumulative funded principal", async () => {
      const investment = makeInvestment({
        id: "inv-1",
        investorId: "investor-1",
        investmentAmount: "2500.5000",
        status: InvestmentStatus.CONFIRMED,
        createdAt: new Date("2026-03-01T10:00:00Z"),
      });

      const entities: MockEntities = {
        invoices: [makeInvoice({ id: "invoice-1", status: InvoiceStatus.FUNDED })],
        investments: [investment],
        snapshots: new Map(),
      };

      const dataSource = createFakeDataSource(entities);
      const service = new AnalyticsSnapshotService(dataSource);

      // Snapshot while investment is CONFIRMED
      const beforeSettlement = await service.captureSnapshot(new Date("2026-03-01T12:00:00Z"));
      expect(beforeSettlement.cumulativeFundingVolume).toBe("2500.5");
      expect(beforeSettlement.dailyFundingVolume).toBe("2500.5");
      expect(beforeSettlement.activeInvestorCount).toBe(1);

      // Settle the investment
      investment.status = InvestmentStatus.SETTLED;
      entities.invoices[0].status = InvoiceStatus.SETTLED;

      // Capture snapshot again (e.g. later day or updated snapshot)
      const afterSettlement = await service.captureSnapshot(new Date("2026-03-02T12:00:00Z"));

      // Acceptance criterion: Settling a confirmed investment does not reduce cumulative funded principal
      expect(afterSettlement.cumulativeFundingVolume).toBe("2500.5");
      expect(new Decimal(afterSettlement.cumulativeFundingVolume).equals(new Decimal(beforeSettlement.cumulativeFundingVolume))).toBe(true);

      // Acceptance criterion: Active-investor metrics stay separate from cumulative volume
      // Investor has no remaining CONFIRMED investments, so active count drops to 0
      expect(afterSettlement.activeInvestorCount).toBe(0);
    });

    it("a settled investment retains its contribution to the appropriate funding day", async () => {
      const day1 = new Date("2026-03-01T10:00:00Z");
      const day2 = new Date("2026-03-02T10:00:00Z");

      const investment = makeInvestment({
        id: "inv-day1",
        investmentAmount: "1500.7500",
        status: InvestmentStatus.CONFIRMED,
        createdAt: day1,
      });

      const entities: MockEntities = {
        invoices: [makeInvoice({ status: InvoiceStatus.FUNDED })],
        investments: [investment],
        snapshots: new Map(),
      };

      const dataSource = createFakeDataSource(entities);
      const service = new AnalyticsSnapshotService(dataSource);

      // Snapshot captured on Day 1
      const day1SnapshotBefore = await service.captureSnapshot(day1);
      expect(day1SnapshotBefore.dailyFundingVolume).toBe("1500.75");

      // Investment settles on Day 2
      investment.status = InvestmentStatus.SETTLED;

      // Re-running or recalculating Day 1 snapshot after settlement must retain the contribution
      const day1SnapshotAfter = await service.captureSnapshot(day1);
      expect(day1SnapshotAfter.dailyFundingVolume).toBe("1500.75");

      // Day 2 daily funding volume should be 0 (no new funding created on Day 2)
      const day2Snapshot = await service.captureSnapshot(day2);
      expect(day2Snapshot.dailyFundingVolume).toBe("0");
      // But Day 2 cumulative volume still retains Day 1's investment
      expect(day2Snapshot.cumulativeFundingVolume).toBe("1500.75");
    });
  });

  describe("Pending and cancelled commitments are excluded", () => {
    it("pending and cancelled commitments do not count as realized funding", async () => {
      const pendingInv = makeInvestment({
        id: "inv-pending",
        investmentAmount: "3000.0000",
        status: InvestmentStatus.PENDING,
        createdAt: new Date("2026-03-01T10:00:00Z"),
      });

      const cancelledInv = makeInvestment({
        id: "inv-cancelled",
        investmentAmount: "2000.0000",
        status: InvestmentStatus.CANCELLED,
        createdAt: new Date("2026-03-01T11:00:00Z"),
      });

      const entities: MockEntities = {
        invoices: [makeInvoice({ status: InvoiceStatus.PUBLISHED })],
        investments: [pendingInv, cancelledInv],
        snapshots: new Map(),
      };

      const dataSource = createFakeDataSource(entities);
      const service = new AnalyticsSnapshotService(dataSource);

      const snapshot = await service.captureSnapshot(new Date("2026-03-01T12:00:00Z"));
      expect(snapshot.dailyFundingVolume).toBe("0");
      expect(snapshot.cumulativeFundingVolume).toBe("0");
      expect(snapshot.activeInvestorCount).toBe(0);
    });

    it("regression test compares totals before and after settlement and cancellation", async () => {
      const inv1 = makeInvestment({
        id: "inv-1",
        investorId: "inv-user-1",
        investmentAmount: "1000.0000",
        status: InvestmentStatus.CONFIRMED,
        createdAt: new Date("2026-03-01T08:00:00Z"),
      });
      const inv2 = makeInvestment({
        id: "inv-2",
        investorId: "inv-user-2",
        investmentAmount: "2000.0000",
        status: InvestmentStatus.CONFIRMED,
        createdAt: new Date("2026-03-01T09:00:00Z"),
      });
      const inv3 = makeInvestment({
        id: "inv-3",
        investorId: "inv-user-3",
        investmentAmount: "500.0000",
        status: InvestmentStatus.PENDING,
        createdAt: new Date("2026-03-01T10:00:00Z"),
      });

      const entities: MockEntities = {
        invoices: [makeInvoice({ status: InvoiceStatus.FUNDED })],
        investments: [inv1, inv2, inv3],
        snapshots: new Map(),
      };

      const dataSource = createFakeDataSource(entities);
      const service = new AnalyticsSnapshotService(dataSource);

      // State 1: Baseline (inv1 confirmed, inv2 confirmed, inv3 pending)
      const baseline = await service.captureSnapshot(new Date("2026-03-01T12:00:00Z"));
      expect(baseline.cumulativeFundingVolume).toBe("3000");
      expect(baseline.dailyFundingVolume).toBe("3000");
      expect(baseline.activeInvestorCount).toBe(2);

      // State 2: Settle inv1 -> Cumulative should remain 3000, active investors drops to 1
      inv1.status = InvestmentStatus.SETTLED;
      const afterSettlement = await service.captureSnapshot(new Date("2026-03-01T13:00:00Z"));
      expect(afterSettlement.cumulativeFundingVolume).toBe("3000");
      expect(afterSettlement.dailyFundingVolume).toBe("3000");
      expect(afterSettlement.activeInvestorCount).toBe(1);

      // State 3: Cancel inv2 -> Cumulative decreases by 2000 (cancelled commitments do not count)
      inv2.status = InvestmentStatus.CANCELLED;
      const afterCancellation = await service.captureSnapshot(new Date("2026-03-01T14:00:00Z"));
      expect(afterCancellation.cumulativeFundingVolume).toBe("1000");
      expect(afterCancellation.dailyFundingVolume).toBe("1000");
      expect(afterCancellation.activeInvestorCount).toBe(0);
    });
  });

  describe("Exact decimal arithmetic across multiple investments", () => {
    it("decimal sums remain exact for multiple investments with precision scale", async () => {
      const investments = [
        makeInvestment({
          id: "inv-1",
          investmentAmount: "1234.5678",
          status: InvestmentStatus.CONFIRMED,
          createdAt: new Date("2026-03-01T08:00:00Z"),
        }),
        makeInvestment({
          id: "inv-2",
          investmentAmount: "8765.4321",
          status: InvestmentStatus.SETTLED,
          createdAt: new Date("2026-03-01T09:00:00Z"),
        }),
        makeInvestment({
          id: "inv-3",
          investmentAmount: "0.0001",
          status: InvestmentStatus.CONFIRMED,
          createdAt: new Date("2026-03-01T10:00:00Z"),
        }),
      ];

      const entities: MockEntities = {
        invoices: [makeInvoice({ status: InvoiceStatus.FUNDED })],
        investments,
        snapshots: new Map(),
      };

      const dataSource = createFakeDataSource(entities);
      const service = new AnalyticsSnapshotService(dataSource);

      const snapshot = await service.captureSnapshot(new Date("2026-03-01T12:00:00Z"));

      // 1234.5678 + 8765.4321 + 0.0001 = 10000.0000
      expect(snapshot.cumulativeFundingVolume).toBe("10000");
      expect(snapshot.dailyFundingVolume).toBe("10000");
    });
  });

  describe("Trends retrieval over date ranges", () => {
    it("correctly retrieves trends including preserved funding volumes", async () => {
      const day1 = new Date("2026-03-01T12:00:00Z");
      const day2 = new Date("2026-03-02T12:00:00Z");

      const investment = makeInvestment({
        id: "inv-1",
        investmentAmount: "5000.0000",
        status: InvestmentStatus.CONFIRMED,
        createdAt: day1,
      });

      const entities: MockEntities = {
        invoices: [makeInvoice({ status: InvoiceStatus.FUNDED })],
        investments: [investment],
        snapshots: new Map(),
      };

      const dataSource = createFakeDataSource(entities);
      const service = new AnalyticsSnapshotService(dataSource);

      // Capture snapshot on Day 1
      await service.captureSnapshot(day1);

      // Settle investment on Day 2 and capture Day 2
      investment.status = InvestmentStatus.SETTLED;
      await service.captureSnapshot(day2);

      const trends = await service.getTrends(day1, day2);
      expect(trends.dates).toEqual(["2026-03-01", "2026-03-02"]);
      expect(trends.data).toHaveLength(2);

      // Day 1
      expect(trends.data[0]?.dailyFundingVolume).toBe("5000");
      expect(trends.data[0]?.cumulativeFundingVolume).toBe("5000");
      expect(trends.data[0]?.activeInvestorCount).toBe(1);

      // Day 2
      expect(trends.data[1]?.dailyFundingVolume).toBe("0");
      expect(trends.data[1]?.cumulativeFundingVolume).toBe("5000");
      expect(trends.data[1]?.activeInvestorCount).toBe(0);
    });
  });
});
