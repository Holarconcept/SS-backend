import "reflect-metadata";
import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { Keypair } from "stellar-sdk";

import { createRoyaltiesRouter } from "../../src/routes/royalties.routes";
import { createSubscriptionsRouter } from "../../src/routes/subscriptions.routes";
import { createDividendsRouter } from "../../src/routes/dividends.routes";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { logger } from "../../src/observability/logger";
import {
  createRoyaltyEarningsService,
  type RoyaltyEarningsRepositoryContract,
} from "../../src/services/royalty-earnings.service";
import {
  createDividendDistributionService,
  type DividendRepositoryContract,
} from "../../src/services/dividend-distribution.service";
import { createSubscriptionStatusService } from "../../src/services/subscription-status.service";
import type { DividendCycleService } from "../../src/services/dividend-cycle.service";
import type { AuthService } from "../../src/services/auth.service";
import { UserType } from "../../src/types/enums";

const JWT_SECRET = "test-jwt-secret-key-32-chars-minimum-length";
// Real strkey values, so the route's own address validation is exercised.
const CREATOR = Keypair.random().publicKey();
const HOLDER = Keypair.random().publicKey();
const KEY_ID = "CAYKOY4J6Q6FBJC55JGI5NYOXDFAYTZNCWVRR5W7E4K3JVFTQQINESG6XA";

/** Minimal auth service stub: the middleware only needs `getCurrentUser`. */
function fakeAuthService(): AuthService {
  return {
    async getCurrentUser(token: string) {
      const payload = jwt.verify(token, JWT_SECRET) as { wallet?: string; userType?: UserType };
      return {
        id: payload.wallet,
        stellarAddress: payload.wallet,
        email: null,
        userType: payload.userType,
        kycStatus: null,
        isKycVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  } as unknown as AuthService;
}

function tokenFor(wallet: string, userType: UserType): string {
  return jwt.sign({ sub: wallet, wallet, stellarAddress: wallet, userType, role: userType }, JWT_SECRET, {
    expiresIn: "1h",
  });
}

function fakeRoyaltyRepository(): RoyaltyEarningsRepositoryContract {
  return {
    async totalsByCreator() {
      return { totalEarned: "12.5000", transferCount: 1 };
    },
    async listTransfers() {
      return [
        {
          id: "t1",
          keyAddress: "CKEY1",
          creatorWallet: CREATOR,
          buyerWallet: HOLDER,
          amount: "12.5000",
          txHash: "tx-paid",
          ledgerSequence: "1000",
          paidAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ] as never;
    },
    async claimTotalsByCreator() {
      return { totalClaimed: "5.0000", claimCount: 1 };
    },
    async listClaims() {
      return [
        {
          id: "c1",
          claimId: "claim-1",
          keyAddress: "CKEY1",
          creatorWallet: CREATOR,
          amount: "5.0000",
          txHash: "tx-claimed",
          ledgerSequence: "1100",
          claimedAt: new Date("2026-02-01T00:00:00.000Z"),
          createdAt: new Date("2026-02-01T00:00:00.000Z"),
        },
      ] as never;
    },
    async recordRoyaltyPaid() {},
    async recordRoyaltyClaim() {},
  };
}

function fakeDividendRepository(): DividendRepositoryContract {
  return {
    async recordDistribution() {},
    async recordAllocations() {},
    async recordClaim() {},
    async allocationsByWallet() {
      return [
        {
          id: "a1",
          allocationId: "alloc-1",
          distributionId: "cycle-1",
          issuerWallet: CREATOR,
          recipientWallet: HOLDER,
          amount: "40.0000",
          cycleFrequency: "monthly",
          txHash: "tx-dist",
          ledgerSequence: "500",
          distributedAt: new Date("2026-03-01T00:00:00.000Z"),
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
        },
      ] as never;
    },
    async claimsByWallet() {
      return [
        {
          id: "d1",
          claimId: "dclaim-1",
          distributionId: "cycle-1",
          issuerWallet: CREATOR,
          recipientWallet: HOLDER,
          amount: "15.0000",
          cycleFrequency: "monthly",
          txHash: "tx-dclaim",
          ledgerSequence: "600",
          claimedAt: new Date("2026-03-15T00:00:00.000Z"),
          createdAt: new Date("2026-03-15T00:00:00.000Z"),
        },
      ] as never;
    },
  };
}

describe("Routes: royalties, dividends and subscriptions (issues #537, #538, #539)", () => {
  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
  });

  /** Wraps a router so failures come back in the standard error envelope. */
  function withErrorHandling(app: express.Express): express.Express {
    app.use(createErrorMiddleware(logger));
    return app;
  }

  describe("GET /royalties", () => {
    function buildApp() {
      const app = express();
      app.use(
        "/api/v1/royalties",
        createRoyaltiesRouter({
          royaltyEarningsService: createRoyaltyEarningsService({
            royaltyRepository: fakeRoyaltyRepository(),
          }),
          authService: fakeAuthService(),
        })
      );
      return withErrorHandling(app);
    }

    it("requires authentication", async () => {
      const res = await request(buildApp()).get("/api/v1/royalties/earnings");
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("rejects an investor token with 403", async () => {
      const res = await request(buildApp())
        .get("/api/v1/royalties/earnings")
        .set("Authorization", `Bearer ${tokenFor(HOLDER, UserType.INVESTOR)}`);
      expect(res.status).toBe(403);
      expect(res.body.success).toBe(false);
    });

    it("returns total, pending and per-transfer breakdown to a creator", async () => {
      const res = await request(buildApp())
        .get("/api/v1/royalties/earnings")
        .set("Authorization", `Bearer ${tokenFor(CREATOR, UserType.SELLER)}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalEarned).toBe("12.5000");
      expect(res.body.data.totalClaimed).toBe("5.0000");
      expect(res.body.data.pending).toBe("7.5000");
      expect(res.body.data.transfers).toHaveLength(1);
      expect(res.body.data.transfers[0].txHash).toBe("tx-paid");
    });

    it("returns claim history with tx hashes to a creator", async () => {
      const res = await request(buildApp())
        .get("/api/v1/royalties/history")
        .set("Authorization", `Bearer ${tokenFor(CREATOR, UserType.BOTH)}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].txHash).toBe("tx-claimed");
      expect(res.body.data[0].amount).toBe("5.0000");
      expect(res.body.meta.hasMore).toBe(false);
    });
  });

  describe("GET /dividends", () => {
    function buildApp() {
      const app = express();
      app.use(
        "/api/v1/dividends",
        createDividendsRouter({
          dividendCycleService: {
            getDistributionHistory: async () => ({ data: [], hasMore: false, nextCursor: null }),
          } as unknown as DividendCycleService,
          authService: fakeAuthService(),
          dividendDistributionService: createDividendDistributionService({
            dividendRepository: fakeDividendRepository(),
          }),
        })
      );
      return withErrorHandling(app);
    }

    it("requires authentication for claimable and claim history", async () => {
      const app = buildApp();
      expect((await request(app).get("/api/v1/dividends/claimable")).status).toBe(401);
      expect((await request(app).get("/api/v1/dividends/claims")).status).toBe(401);
      expect((await request(app).get("/api/v1/dividends/summary")).status).toBe(401);
    });

    it("returns claimable amounts per cycle", async () => {
      const res = await request(buildApp())
        .get("/api/v1/dividends/claimable")
        .set("Authorization", `Bearer ${tokenFor(HOLDER, UserType.INVESTOR)}`);

      expect(res.status).toBe(200);
      expect(res.body.data.cycles).toHaveLength(1);
      expect(res.body.data.cycles[0].earned).toBe("40.0000");
      expect(res.body.data.cycles[0].claimed).toBe("15.0000");
      expect(res.body.data.cycles[0].claimable).toBe("25.0000");
    });

    it("returns claim history with tx hashes and amounts", async () => {
      const res = await request(buildApp())
        .get("/api/v1/dividends/claims")
        .set("Authorization", `Bearer ${tokenFor(HOLDER, UserType.INVESTOR)}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].txHash).toBe("tx-dclaim");
      expect(res.body.data[0].amount).toBe("15.0000");
    });

    it("aggregates totals in the summary endpoint", async () => {
      const res = await request(buildApp())
        .get("/api/v1/dividends/summary")
        .set("Authorization", `Bearer ${tokenFor(HOLDER, UserType.BOTH)}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totalEarned).toBe("40.0000");
      expect(res.body.data.totalClaimed).toBe("15.0000");
      expect(res.body.data.totalPending).toBe("25.0000");
      expect(res.body.data.cycleCount).toBe(1);
    });

    it("includes claimed dividends in the existing history response", async () => {
      const res = await request(buildApp())
        .get("/api/v1/dividends/history")
        .set("Authorization", `Bearer ${tokenFor(HOLDER, UserType.INVESTOR)}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.claims[0].txHash).toBe("tx-dclaim");
    });
  });

  describe("GET /subscriptions/status", () => {
    function buildApp(balance: string, minBalance: string, expiryLedger: number | null) {
      const app = express();
      const service = createSubscriptionStatusService({
        holdingReader: {
          async readHolding() {
            return { balance, minBalance, expiryLedger, ledger: 1_000_000 };
          },
        },
      });
      app.use("/api/v1/subscriptions", createSubscriptionsRouter({ subscriptionStatusService: service }));
      return withErrorHandling(app);
    }

    it("answers without authentication", async () => {
      const res = await request(buildApp("100", "10", 1_000_000 + 17_280 * 5)).get(
        `/api/v1/subscriptions/status?wallet=${HOLDER}&key_id=${KEY_ID}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.subscribed).toBe(true);
      expect(res.body.data.daysRemaining).toBe(5);
    });

    it("reports an unsubscribed wallet", async () => {
      const res = await request(buildApp("0", "10", null)).get(
        `/api/v1/subscriptions/status?wallet=${HOLDER}&key_id=${KEY_ID}`
      );

      expect(res.status).toBe(200);
      expect(res.body.data.subscribed).toBe(false);
    });

    it("rejects a request with no wallet or key_id", async () => {
      const app = buildApp("100", "10", null);
      expect((await request(app).get("/api/v1/subscriptions/status")).status).toBe(400);
      expect((await request(app).get(`/api/v1/subscriptions/status?wallet=${HOLDER}`)).status).toBe(400);
      expect(
        (await request(app).get("/api/v1/subscriptions/status?wallet=not-a-wallet&key_id=CKEY")).status
      ).toBe(400);
    });
  });
});
