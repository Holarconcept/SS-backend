import request from "supertest";
import express from "express";
import { createBenchmarkRouter, createInvoiceBenchmarkRouter } from "../src/routes/benchmark.routes";
import { createReferralTierRouter } from "../src/routes/referral-tier.routes";
import { createYieldBoostRouter } from "../src/routes/yield-boost.routes";
import {
  createSecondaryAuctionRouter,
  createInvoiceAuctionRouter,
} from "../src/routes/secondary-auction.routes";
import { createErrorMiddleware } from "../src/middleware/error.middleware";
import { logger } from "../src/observability/logger";
import { ReferralTierLevel, LoyaltyTier, AuctionStatus } from "../src/types/enums";

function buildApp(services: {
  benchmarkService: any;
  referralTierService: any;
  yieldBoostService: any;
  secondaryAuctionService: any;
}): express.Application {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/benchmarks", createBenchmarkRouter(services));
  app.use("/api/v1/invoices", createInvoiceBenchmarkRouter(services));
  app.use("/api/v1/invoices", createYieldBoostRouter(services));
  app.use("/api/v1/invoices", createInvoiceAuctionRouter(services));
  app.use("/api/v1/referrals", createReferralTierRouter(services));
  app.use("/api/v1/auctions", createSecondaryAuctionRouter(services));
  app.use(createErrorMiddleware(logger));
  return app;
}

describe("Contract event index REST routes (#676-#679)", () => {
  let app: express.Application;
  let benchmarkService: any;
  let referralTierService: any;
  let yieldBoostService: any;
  let secondaryAuctionService: any;

  beforeEach(() => {
    benchmarkService = {
      getSectorBenchmark: jest.fn(),
      getInvoiceBenchmark: jest.fn(),
    };
    referralTierService = {
      getTier: jest.fn(),
      getTierHistory: jest.fn(),
    };
    yieldBoostService = {
      getBoost: jest.fn(),
    };
    secondaryAuctionService = {
      getAuction: jest.fn(),
      getBids: jest.fn(),
      getAuctionsForInvoice: jest.fn(),
    };
    app = buildApp({
      benchmarkService,
      referralTierService,
      yieldBoostService,
      secondaryAuctionService,
    });
  });

  it("GET /api/v1/benchmarks/:sector returns sector averages", async () => {
    benchmarkService.getSectorBenchmark.mockResolvedValue({
      sector: "logistics",
      avgYield: "6.50",
      avgDaysToSettle: "45.00",
      defaultRate: "2.10",
      sampleCount: 12,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const res = await request(app).get("/api/v1/benchmarks/logistics");

    expect(res.status).toBe(200);
    expect(res.body.data.avgYield).toBe("6.50");
  });

  it("GET /api/v1/benchmarks/:sector returns 404 with no data", async () => {
    const err: any = new Error("No benchmark data");
    err.code = "BENCHMARK_NOT_FOUND";
    err.statusCode = 404;
    benchmarkService.getSectorBenchmark.mockRejectedValue(err);

    const res = await request(app).get("/api/v1/benchmarks/unknown");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("BENCHMARK_NOT_FOUND");
  });

  it("GET /api/v1/invoices/:invoiceId/benchmark returns the comparison", async () => {
    benchmarkService.getInvoiceBenchmark.mockResolvedValue({
      invoiceId: "inv-1",
      sector: "logistics",
      invoice: { yield: "5.00", daysToSettle: 31, amount: "1000.0000", status: "published" },
      benchmark: { sector: "logistics", avgYield: "6.50" },
    });

    const res = await request(app).get("/api/v1/invoices/inv-1/benchmark");

    expect(res.status).toBe(200);
    expect(res.body.data.invoice.yield).toBe("5.00");
  });

  it("GET /api/v1/referrals/:wallet/tier returns tier and commission", async () => {
    referralTierService.getTier.mockResolvedValue({
      wallet: "GWALLET",
      tier: ReferralTierLevel.SILVER,
      commissionRateBps: 200,
      cumulativeReferredVolume: "60000.0000",
      nextTierThreshold: "200000.0000",
      nextTier: ReferralTierLevel.GOLD,
      isDefault: false,
      upgradedAt: null,
    });

    const res = await request(app).get("/api/v1/referrals/GWALLET/tier");

    expect(res.status).toBe(200);
    expect(res.body.data.commissionRateBps).toBe(200);
    expect(res.body.data.tier).toBe("silver");
  });

  it("GET /api/v1/referrals/:wallet/tier/history returns paginated log", async () => {
    referralTierService.getTierHistory.mockResolvedValue({
      data: [
        {
          tier: ReferralTierLevel.SILVER,
          commissionRateBps: 200,
          cumulativeReferredVolume: "60000.0000",
          upgradedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
      meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    const res = await request(app).get("/api/v1/referrals/GWALLET/tier/history");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.meta.total).toBe(1);
  });

  it("GET /api/v1/invoices/:invoiceId/boost/:wallet returns eligibility", async () => {
    yieldBoostService.getBoost.mockResolvedValue({
      invoiceId: "inv-1",
      wallet: "GWALLET",
      isEligible: true,
      tier: LoyaltyTier.GOLD,
      boostBps: 50,
      baseYield: "5.00",
      boostedYield: "5.50",
    });

    const res = await request(app).get("/api/v1/invoices/inv-1/boost/GWALLET");

    expect(res.status).toBe(200);
    expect(res.body.data.isEligible).toBe(true);
    expect(res.body.data.boostedYield).toBe("5.50");
  });

  it("GET /api/v1/auctions/:auctionId returns status and countdown", async () => {
    secondaryAuctionService.getAuction.mockResolvedValue({
      auctionId: "auc-1",
      status: AuctionStatus.ACTIVE,
      seller: "GSELLER",
      invoiceId: "inv-1",
      highestBid: "150.0000",
      highestBidder: "GBIDDER",
      reservePrice: "100.0000",
      reserveMet: true,
      bidCount: 1,
      countdownSeconds: 3600,
    });

    const res = await request(app).get("/api/v1/auctions/auc-1");

    expect(res.status).toBe(200);
    expect(res.body.data.reserveMet).toBe(true);
    expect(res.body.data.countdownSeconds).toBe(3600);
  });

  it("GET /api/v1/auctions/:auctionId/bids returns paginated bids", async () => {
    secondaryAuctionService.getBids.mockResolvedValue({
      data: [{ bidder: "GBIDDER2", amount: "120.0000", placedAt: null }],
      meta: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    const res = await request(app).get("/api/v1/auctions/auc-1/bids");

    expect(res.status).toBe(200);
    expect(res.body.data[0].bidder).toBe("GBIDDER2");
    expect(res.body.meta.total).toBe(1);
  });

  it("GET /api/v1/invoices/:invoiceId/auctions returns active and settled records", async () => {
    secondaryAuctionService.getAuctionsForInvoice.mockResolvedValue([
      { auctionId: "auc-1", status: AuctionStatus.ACTIVE },
      { auctionId: "auc-2", status: AuctionStatus.SETTLED },
    ]);

    const res = await request(app).get("/api/v1/invoices/inv-1/auctions");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });
});
