import { DataSource } from "typeorm";
import { ReferralTierService } from "../src/services/referral-tier.service";
import { ReferralTier } from "../src/models/ReferralTier.model";
import { ReferralTierHistory } from "../src/models/ReferralTierHistory.model";
import { ReferralTierLevel } from "../src/types/enums";

function createFakeDataSource(
  tiers: ReferralTier[] = [],
  history: ReferralTierHistory[] = [],
) {
  const tierRows = [...tiers];
  const historyRows = [...history];

  return {
    getRepository: (entity: unknown) => {
      if (entity === ReferralTier) {
        return {
          findOneBy: async (where: { wallet: string }) =>
            tierRows.find((t) => t.wallet === where.wallet) ?? null,
          create: (data: Partial<ReferralTier>) => ({ ...data }) as ReferralTier,
          save: async (row: ReferralTier) => {
            const idx = tierRows.findIndex((t) => t.wallet === row.wallet);
            const full = {
              id: row.id ?? `tier-${tierRows.length + 1}`,
              lastEventId: null,
              createdAt: new Date(),
              ...row,
            } as ReferralTier;
            if (idx >= 0) tierRows[idx] = full;
            else tierRows.push(full);
            return full;
          },
        };
      }
      if (entity === ReferralTierHistory) {
        return {
          create: (data: Partial<ReferralTierHistory>) => ({ ...data }) as ReferralTierHistory,
          save: async (row: ReferralTierHistory) => {
            const full = {
              id: `hist-${historyRows.length + 1}`,
              createdAt: new Date(),
              ...row,
            } as ReferralTierHistory;
            historyRows.push(full);
            return full;
          },
          findAndCount: async (options: {
            where: { wallet: string };
            order: Record<string, string>;
            skip: number;
            take: number;
          }) => {
            const matched = historyRows
              .filter((h) => h.wallet === options.where.wallet)
              .sort((a, b) => {
                const aT = a.upgradedAt?.getTime() ?? 0;
                const bT = b.upgradedAt?.getTime() ?? 0;
                return options.order.upgradedAt === "DESC" ? bT - aT : aT - bT;
              });
            return [matched.slice(options.skip, options.skip + options.take), matched.length];
          },
        };
      }
      throw new Error(`Unexpected entity in test fake: ${String(entity)}`);
    },
  } as unknown as DataSource;
}

describe("ReferralTierService", () => {
  it("returns Standard tier defaults for wallets with no referral history", async () => {
    const service = new ReferralTierService(createFakeDataSource());

    const result = await service.getTier("GWALLETNEW");

    expect(result.tier).toBe(ReferralTierLevel.STANDARD);
    expect(result.commissionRateBps).toBe(100);
    expect(result.cumulativeReferredVolume).toBe("0.0000");
    expect(result.isDefault).toBe(true);
    expect(result.nextTierThreshold).toBe("10000.0000");
    expect(result.nextTier).toBe(ReferralTierLevel.BRONZE);
  });

  it("indexes ReferralTierUpgraded events and returns accurate tier + commission", async () => {
    const service = new ReferralTierService(createFakeDataSource());

    await service.ingestReferralTierUpgraded({
      wallet: "GWALLET1",
      tier: ReferralTierLevel.SILVER,
      cumulativeReferredVolume: "60000.0000",
      eventId: "evt-1",
      occurredAt: new Date("2026-01-15T00:00:00Z"),
    });

    const result = await service.getTier("GWALLET1");

    expect(result.tier).toBe(ReferralTierLevel.SILVER);
    expect(result.commissionRateBps).toBe(200);
    expect(result.cumulativeReferredVolume).toBe("60000.0000");
    expect(result.isDefault).toBe(false);
  });

  it("computes next_tier_threshold correctly for each tier", async () => {
    const service = new ReferralTierService(createFakeDataSource());

    await service.ingestReferralTierUpgraded({
      wallet: "GWALLET2",
      tier: ReferralTierLevel.GOLD,
    });
    const gold = await service.getTier("GWALLET2");
    expect(gold.nextTierThreshold).toBeNull();
    expect(gold.nextTier).toBeNull();

    await service.ingestReferralTierUpgraded({
      wallet: "GWALLET3",
      tier: ReferralTierLevel.BRONZE,
    });
    const bronze = await service.getTier("GWALLET3");
    expect(bronze.nextTierThreshold).toBe("50000.0000");
    expect(bronze.nextTier).toBe(ReferralTierLevel.SILVER);
  });

  it("returns tier upgrade history in descending order", async () => {
    const service = new ReferralTierService(createFakeDataSource());

    await service.ingestReferralTierUpgraded({
      wallet: "GWALLET4",
      tier: ReferralTierLevel.STANDARD,
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    await service.ingestReferralTierUpgraded({
      wallet: "GWALLET4",
      tier: ReferralTierLevel.BRONZE,
      occurredAt: new Date("2026-02-01T00:00:00Z"),
    });
    await service.ingestReferralTierUpgraded({
      wallet: "GWALLET4",
      tier: ReferralTierLevel.SILVER,
      occurredAt: new Date("2026-03-01T00:00:00Z"),
    });

    const history = await service.getTierHistory("GWALLET4");

    expect(history.data).toHaveLength(3);
    expect(history.data[0].tier).toBe(ReferralTierLevel.SILVER);
    expect(history.data[1].tier).toBe(ReferralTierLevel.BRONZE);
    expect(history.data[2].tier).toBe(ReferralTierLevel.STANDARD);
    expect(history.meta.total).toBe(3);
  });

  it("invalidates the cached tier when a new upgrade event arrives", async () => {
    const service = new ReferralTierService(createFakeDataSource());

    await service.ingestReferralTierUpgraded({
      wallet: "GWALLET5",
      tier: ReferralTierLevel.STANDARD,
    });
    await service.getTier("GWALLET5");

    await service.ingestReferralTierUpgraded({
      wallet: "GWALLET5",
      tier: ReferralTierLevel.GOLD,
    });
    const updated = await service.getTier("GWALLET5");
    expect(updated.tier).toBe(ReferralTierLevel.GOLD);
    expect(updated.commissionRateBps).toBe(250);
  });
});
