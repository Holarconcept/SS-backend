import { DataSource } from "typeorm";
import { YieldBoostService } from "../src/services/yield-boost.service";
import { YieldBoost } from "../src/models/YieldBoost.model";
import { Invoice } from "../src/models/Invoice.model";
import { InvoiceStatus, LoyaltyTier } from "../src/types/enums";

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "invoice-1",
    sellerId: "issuer-1",
    invoiceNumber: "INV-1",
    customerName: "Acme",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    dueDate: new Date("2026-02-01T00:00:00Z"),
    category: "logistics",
    ipfsHash: null,
    riskScore: null,
    status: InvoiceStatus.PUBLISHED,
    smartContractId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  } as Invoice;
}

function createFakeDataSource(boosts: YieldBoost[] = [], invoices: Invoice[] = [makeInvoice()]) {
  const rows = [...boosts];

  return {
    getRepository: (entity: unknown) => {
      if (entity === YieldBoost) {
        return {
          findOneBy: async (where: { invoiceId: string; wallet: string }) =>
            rows.find((b) => b.invoiceId === where.invoiceId && b.wallet === where.wallet) ?? null,
          create: (data: Partial<YieldBoost>) => ({ ...data }) as YieldBoost,
          save: async (row: YieldBoost) => {
            const idx = rows.findIndex(
              (b) => b.invoiceId === row.invoiceId && b.wallet === row.wallet,
            );
            const full = {
              id: row.id ?? `boost-${rows.length + 1}`,
              lastEventId: null,
              createdAt: new Date(),
              ...row,
            } as YieldBoost;
            if (idx >= 0) rows[idx] = full;
            else rows.push(full);
            return full;
          },
        };
      }
      if (entity === Invoice) {
        return {
          findOneBy: async (where: { id: string }) =>
            invoices.find((i) => i.id === where.id) ?? null,
        };
      }
      throw new Error(`Unexpected entity in test fake: ${String(entity)}`);
    },
  } as unknown as DataSource;
}

describe("YieldBoostService", () => {
  it("indexes YieldBoostApplied events with the correct tier and amount", async () => {
    const service = new YieldBoostService(createFakeDataSource());

    await service.ingestYieldBoostApplied({
      invoiceId: "invoice-1",
      wallet: "GWALLET1",
      tier: LoyaltyTier.GOLD,
      eventId: "evt-1",
    });

    const result = await service.getBoost("invoice-1", "GWALLET1");

    expect(result.tier).toBe(LoyaltyTier.GOLD);
    expect(result.boostBps).toBe(50);
    expect(result.isEligible).toBe(true);
  });

  it("computes boosted yield correctly for all three eligible tiers", async () => {
    const service = new YieldBoostService(createFakeDataSource());

    const cases: Array<[LoyaltyTier, number]> = [
      [LoyaltyTier.SILVER, 25],
      [LoyaltyTier.GOLD, 50],
      [LoyaltyTier.PLATINUM, 100],
    ];

    for (const [tier, bps] of cases) {
      await service.ingestYieldBoostApplied({
        invoiceId: "invoice-1",
        wallet: `GWALLET-${tier}`,
        tier,
      });
      const result = await service.getBoost("invoice-1", `GWALLET-${tier}`);
      expect(result.isEligible).toBe(true);
      expect(result.boostBps).toBe(bps);
      // base 5.00% + bps/100
      expect(Number(result.boostedYield)).toBeCloseTo(5 + bps / 100, 2);
    }
  });

  it("returns is_eligible: false for Bronze wallets", async () => {
    const service = new YieldBoostService(createFakeDataSource());

    await service.ingestYieldBoostApplied({
      invoiceId: "invoice-1",
      wallet: "GWALLET-BRONZE",
      tier: LoyaltyTier.BRONZE,
    });

    const result = await service.getBoost("invoice-1", "GWALLET-BRONZE");

    expect(result.isEligible).toBe(false);
    expect(result.boostBps).toBe(0);
    expect(result.boostedYield).toBe("5.00");
  });

  it("returns is_eligible: false for unregistered wallets", async () => {
    const service = new YieldBoostService(createFakeDataSource());

    const result = await service.getBoost("invoice-1", "GWALLET-UNKNOWN");

    expect(result.isEligible).toBe(false);
    expect(result.tier).toBeNull();
    expect(result.boostBps).toBe(0);
    expect(result.boostedYield).toBe("5.00");
  });

  it("invalidates the cache when a new boost event arrives for the pair", async () => {
    const service = new YieldBoostService(createFakeDataSource());

    await service.ingestYieldBoostApplied({
      invoiceId: "invoice-1",
      wallet: "GWALLET6",
      tier: LoyaltyTier.SILVER,
    });
    const first = await service.getBoost("invoice-1", "GWALLET6");
    expect(first.boostBps).toBe(25);

    await service.ingestYieldBoostApplied({
      invoiceId: "invoice-1",
      wallet: "GWALLET6",
      tier: LoyaltyTier.PLATINUM,
    });
    const second = await service.getBoost("invoice-1", "GWALLET6");
    expect(second.boostBps).toBe(100);
  });

  it("404s for a missing invoice", async () => {
    const service = new YieldBoostService(createFakeDataSource());

    await expect(service.getBoost("missing", "GWALLET1")).rejects.toMatchObject({
      code: "INVOICE_NOT_FOUND",
      statusCode: 404,
    });
  });
});
