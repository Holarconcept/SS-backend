import { AlertPreference } from "../src/models/AlertPreference.model";
import { Investment } from "../src/models/Investment.model";
import { OnboardingBonus } from "../src/models/OnboardingBonus.model";
import { YieldAdjustment } from "../src/models/YieldAdjustment.model";
import { InvestorInsightsService } from "../src/services/investor-insights.service";
import type { DecodedSorobanEvent } from "../src/types/soroban.types";
import type { DataSource } from "typeorm";

describe("InvestorInsightsService", () => {
  let bonusRows: OnboardingBonus[];
  let preferenceRows: AlertPreference[];
  let yieldRows: YieldAdjustment[];
  let repositories: Map<unknown, any>;
  let dataSource: DataSource;

  beforeEach(() => {
    bonusRows = [];
    preferenceRows = [];
    yieldRows = [];
    const repositoryFor = (rows: any[]) => ({
      create: (input: object) => ({ ...input }),
      save: jest.fn(async (input: any) => {
        const index = rows.findIndex((row) => row.id && row.id === input.id);
        if (index >= 0) rows[index] = input;
        else rows.push(input);
        return input;
      }),
      findOne: jest.fn(async ({ where }: any) => rows.find((row) =>
        Object.entries(where).some(([key, value]) => row[key] === value),
      ) ?? null),
      find: jest.fn(async ({ where }: any) => rows.filter((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value),
      )),
    });

    repositories = new Map<any, any>([
      [OnboardingBonus, repositoryFor(bonusRows)],
      [AlertPreference, repositoryFor(preferenceRows)],
      [YieldAdjustment, repositoryFor(yieldRows)],
      [Investment, repositoryFor([])],
    ]);
    dataSource = {
      getRepository: (model: unknown) => repositories.get(model),
    } as unknown as DataSource;
  });

  function event(
    topic: string,
    data: Record<string, unknown>,
    id = "event-1",
  ): DecodedSorobanEvent {
    return {
      id,
      contractId: "contract",
      ledger: 100,
      ledgerClosedAt: "2026-10-24T00:00:00.000Z",
      txHash: "tx-1",
      topic,
      topics: [topic],
      data,
      inSuccessfulContractCall: true,
    };
  }

  it("returns an unclaimed status instead of not-found for a wallet without a bonus", async () => {
    const service = new InvestorInsightsService(dataSource);

    await expect(service.getOnboardingBonus("G-wallet")).resolves.toEqual({
      is_claimed: false,
      bonus_amount: null,
      invoice_id: null,
      claimed_at: null,
    });
  });

  it("indexes onboarding claims and invalidates the 60-second wallet cache", async () => {
    const service = new InvestorInsightsService(dataSource);
    expect((await service.getOnboardingBonus("G-wallet")).is_claimed).toBe(false);

    await service.processEvent(event("OnboardingBonusClaimed", {
      wallet: "G-wallet",
      bonus_amount: "12.5000000",
      invoice_id: "invoice-1",
    }));

    await expect(service.getOnboardingBonus("G-wallet")).resolves.toMatchObject({
      is_claimed: true,
      bonus_amount: "12.5000000",
      invoice_id: "invoice-1",
    });
  });

  it("records a zero adjustment when rating data is present without a bps adjustment", async () => {
    const service = new InvestorInsightsService(dataSource);

    await service.processEvent(event("SettlementCompleted", {
      invoice_id: "invoice-1",
      basis_rating: "2.5",
    }));

    await expect(service.getYieldAdjustment("invoice-1")).resolves.toMatchObject({
      adjustment_bps: 0,
      basis_rating: "2.5",
    });
  });

  it("indexes preference updates while keeping omitted notification types enabled", async () => {
    const service = new InvestorInsightsService(dataSource);

    await service.processEvent(event("AlertPreferenceUpdated", {
      wallet: "G-wallet",
      preferences: { maturity: false },
    }));

    await expect(service.getAlertPreferences("G-wallet")).resolves.toEqual({
      settlement: true,
      kyc_expiry: true,
      watchlist_change: true,
      auto_invest: true,
      maturity: false,
    });
  });

  it("preserves negative adjustment basis points in the settlement history", async () => {
    const service = new InvestorInsightsService(dataSource);

    await service.processEvent(event("SettlementCompleted", {
      invoice_id: "invoice-1",
      adjustment_bps: -125,
      basis_rating: "2.1",
      adjusted_yield: "7.375",
    }));

    await expect(service.getYieldAdjustmentHistory("invoice-1")).resolves.toMatchObject([
      { invoice_id: "invoice-1", adjustment_bps: -125, adjusted_yield: "7.375" },
    ]);
  });

  it("dispatches maturity events to wallets with default all-enabled preferences", async () => {
    const request = jest.fn().mockResolvedValue({ ok: true });
    const service = new InvestorInsightsService(
      dataSource,
      { notificationServiceUrl: "https://notify.example.test" },
      undefined,
      request,
    );

    await service.processEvent(event("MaturityReached", { wallet: "G-wallet" }));

    expect(request).toHaveBeenCalledWith(
      "https://notify.example.test",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"event_type":"maturity"'),
      }),
    );
  });
});
