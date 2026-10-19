import cors from "cors";
import helmet from "helmet";
import express, { Request } from "express";

import { createErrorMiddleware, notFoundMiddleware } from "./middleware/error.middleware";
import { applyRateLimiters } from "./middleware/rate-limit.middleware";
import { createRequestObservabilityMiddleware } from "./middleware/request-observability.middleware";
import { sanitizeInputMiddleware } from "./middleware/sanitize-input.middleware";

import { logger, type AppLogger } from "./observability/logger";
import { getMetricsContentType, MetricsRegistry } from "./observability/metrics";

import { randomUUID } from "crypto";

import { createAuthRouter } from "./routes/auth.routes";
import { createKycRouter, createKycWebhookRouter } from "./routes/kyc.routes";
import { createNotificationRouter } from "./routes/notification.routes";
import { createInvoiceRouter } from "./routes/invoice.routes";
import { createInvestmentRouter } from "./routes/investment.routes";
import { createSettlementRouter } from "./routes/settlement.routes";
import { createMarketplaceRouter } from "./routes/marketplace.routes";
import { createSellerRouter } from "./routes/seller.routes";
import { createAdminRouter } from "./routes/admin/admin.routes";
import {
  createDataSourceSuspensionLookup,
  createSuspendedWalletGuard,
  type SuspensionLookup,
} from "./middleware/suspended-wallet.middleware";
import type { AdminUserService } from "./services/admin-user.service";
import { createInvestorRouter } from "./routes/investor.routes";
import { createPortfolioRouter } from "./routes/portfolio.routes";
import { createContractGuardService } from "./services/stellar/contract-guard.service";
import { createKeysRouter } from "./routes/keys.routes";
import { createDividendsRouter } from "./routes/dividends.routes";
import { createSecondaryMarketRouter } from "./routes/secondary-market.routes";
import { createWatchlistRouter } from "./routes/watchlist.routes";
import type { RatingsLeaderboardService } from "./services/ratings-leaderboard.service";
import type { DividendCycleService } from "./services/dividend-cycle.service";
import type { DividendDistributionService } from "./services/dividend-distribution.service";
import type { RoyaltyEarningsService } from "./services/royalty-earnings.service";
import type { SubscriptionStatusService } from "./services/subscription-status.service";
import type { OnboardingService } from "./services/onboarding.service";
import type { AtomicSwapService } from "./services/atomic-swap.service";
import type { AclService } from "./services/acl.service";
import type { CreatorKeyService } from "./services/creator-key.service";
import type { CurveMigrationService } from "./services/curve-migration.service";
import type { KeyMergeProposalService } from "./services/key-merge-proposal.service";
import { createSwapRouter } from "./routes/swap.routes";
import { createRoyaltiesRouter } from "./routes/royalties.routes";
import { createSubscriptionsRouter } from "./routes/subscriptions.routes";
import { createOnboardingRouter } from "./routes/onboarding.routes";
import { createCommunityProgramsRouter } from "./routes/community-programs.routes";
import { createOnchainEventViewsRouter } from "./routes/onchain-event-views.routes";
import { createFxRouter } from "./routes/fx.routes";
import {
  createBenchmarkRouter,
  createInvoiceBenchmarkRouter,
} from "./routes/benchmark.routes";
import { createReferralTierRouter } from "./routes/referral-tier.routes";
import { createYieldBoostRouter } from "./routes/yield-boost.routes";
import {
  createSecondaryAuctionRouter,
  createInvoiceAuctionRouter,
} from "./routes/secondary-auction.routes";

import type { AuthService } from "./services/auth.service";
import type { WaitlistService } from "./services/waitlist.service";
import type { NotificationService } from "./services/notification.service";
import type { InvoiceService } from "./services/invoice.service";
import type { InvestmentService } from "./services/investment.service";
import type { SettlementService } from "./services/settlement.service";
import type { AdminSettlementService } from "./services/admin-settlement.service";
import type { MarketplaceService } from "./services/marketplace.service";
import type { SellerService } from "./services/seller.service";
import type { KycService } from "./services/kyc.service";
import type { InvoiceSearchService } from "./services/invoice-search.service";
import type { InvestorAcknowledgementService } from "./services/investor-acknowledgement.service";
import type { InvoiceExtensionService } from "./services/invoice-extension.service";
import type { AdminMetricsService } from "./services/admin-metrics.service";
import type { PortfolioService } from "./services/portfolio.service";
import type { SecondaryMarketService } from "./services/secondary-market.service";
import type { WatchlistService } from "./services/watchlist.service";
import type { SettlementWorker } from "./workers/settlement.worker";
import type { FeeScheduleService } from "./services/fee-schedule.service";
import type { IssuerReputationService } from "./services/issuer-reputation.service";
import type { InvestorRiskProfileService } from "./services/investor-risk-profile.service";
import type { InvoiceDraftService } from "./services/invoice-draft.service";
import type { BenchmarkService } from "./services/benchmark.service";
import type { ReferralTierService } from "./services/referral-tier.service";
import type { YieldBoostService } from "./services/yield-boost.service";
import type { SecondaryAuctionService } from "./services/secondary-auction.service";

import dataSource from "./config/database";
import { getRedisClient } from "./config/redis";
import packageInfo from "../package.json";

const READINESS_CHECK_TIMEOUT_MS = 80;

export interface ReadinessChecks {
  database: () => Promise<unknown>;
  redis: () => Promise<unknown>;
}

interface DependencyHealth {
  status: "ok" | "unhealthy";
  error?: string;
}

async function checkDependency(
  name: "database" | "redis",
  check: () => Promise<unknown>,
  appLogger: AppLogger
): Promise<DependencyHealth> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Health check timed out")),
          READINESS_CHECK_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
    return { status: "ok" };
  } catch (error) {
    appLogger.warn("Readiness dependency check failed.", {
      dependency: name,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return {
      status: "unhealthy",
      error: `${name} connectivity check failed`,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

//  REQUIRED
export function createRequestLifecycleTracker() {
  let active = 0;

  return {
    onRequestStart() {
      active++;
    },
    onRequestEnd() {
      active = Math.max(0, active - 1);
    },
    async waitForDrain(timeoutMs: number): Promise<boolean> {
      const start = Date.now();
      while (active > 0) {
        if (Date.now() - start > timeoutMs) return false;
        await new Promise((r) => setTimeout(r, 10));
      }
      return true;
    },
  };
}

interface RequestWithId extends Request {
  requestId?: string;
}

async function probeDatabase(): Promise<"ok" | "degraded"> {
  if (!dataSource.isInitialized) {
    return "ok";
  }

  try {
    await dataSource.query("SELECT 1");
    return "ok";
  } catch {
    return "degraded";
  }
}

async function probeHorizon(): Promise<"ok" | "degraded"> {
  const url = process.env.HORIZON_URL;
  if (!url) {
    return "ok";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok ? "ok" : "degraded";
  } catch {
    return "degraded";
  } finally {
    clearTimeout(timeout);
  }
}

export interface AppDependencies {
  authService: AuthService;
  notificationService?: NotificationService;
  invoiceService?: InvoiceService;
  investmentService?: InvestmentService;
  settlementService?: SettlementService;
  adminSettlementService?: AdminSettlementService;
  marketplaceService?: MarketplaceService;
  sellerService?: SellerService;
  kycService?: KycService;
  invoiceSearchService?: InvoiceSearchService;
  adminUserService?: AdminUserService;
  /** Defaults to reading users.is_suspended from the app data source. */
  suspensionLookup?: SuspensionLookup;
  ratingsLeaderboardService?: RatingsLeaderboardService;
  dividendCycleService?: DividendCycleService;
  dividendDistributionService?: DividendDistributionService;
  royaltyEarningsService?: RoyaltyEarningsService;
  subscriptionStatusService?: SubscriptionStatusService;
  onboardingService?: OnboardingService;
  swapService?: AtomicSwapService;
  aclService?: AclService;
  creatorKeyService?: CreatorKeyService;
  curveMigrationService?: CurveMigrationService;
  keyMergeProposalService?: KeyMergeProposalService;
  secondaryMarketService?: SecondaryMarketService;
  watchlistService?: WatchlistService;
  settlementWorker?: SettlementWorker;
  acknowledgementService?: InvestorAcknowledgementService;
  extensionService?: InvoiceExtensionService;
  portfolioService?: PortfolioService;
  adminMetricsService?: AdminMetricsService;
  feeScheduleService?: FeeScheduleService;
  issuerReputationService?: IssuerReputationService;
  investorRiskProfileService?: InvestorRiskProfileService;
  draftService?: InvoiceDraftService;
  invoiceEscrowContractService?: import("./services/stellar/invoice-escrow-contract.service").InvoiceEscrowContractService;
  benchmarkService?: BenchmarkService;
  referralTierService?: ReferralTierService;
  yieldBoostService?: YieldBoostService;
  secondaryAuctionService?: SecondaryAuctionService;
  logger?: AppLogger;
  metricsEnabled?: boolean;
  metricsRegistry?: MetricsRegistry;
  readinessChecks?: ReadinessChecks;
  config?: import("./config/env").AppConfig;
  /** Optional: enables waitlist management endpoints (issue #599) */
  waitlistService?: WaitlistService;

  http?: {
    trustProxy?: boolean | number | string;
    nodeEnv?: string;
    corsAllowedOrigins?: string[];
    corsAllowCredentials?: boolean;
    rateLimit?: {
      enabled?: boolean;
      windowMs?: number;
      max?: number;
    };
  };
}

export function createApp({
  authService,
  notificationService,
  invoiceService,
  investmentService,
  settlementService,
  adminSettlementService,
  marketplaceService,
  sellerService,
  kycService,
  invoiceSearchService,
  adminUserService,
  suspensionLookup,
  ratingsLeaderboardService,
  dividendCycleService,
  dividendDistributionService,
  royaltyEarningsService,
  subscriptionStatusService,
  onboardingService,
  swapService,
  aclService,
  creatorKeyService,
  curveMigrationService,
  keyMergeProposalService,
  secondaryMarketService,
  watchlistService,
  settlementWorker,
  acknowledgementService,
  portfolioService,
  extensionService,
  adminMetricsService,
  feeScheduleService,
  issuerReputationService,
  investorRiskProfileService,
  draftService,
  invoiceEscrowContractService,
  waitlistService,
  benchmarkService,
  referralTierService,
  yieldBoostService,
  secondaryAuctionService,
  logger: appLogger = logger,
  metricsEnabled = true,
  metricsRegistry = new MetricsRegistry(),
  readinessChecks,
  config,
  http,
}: AppDependencies) {
  const app = express();

  // ✅ FIX TRUST PROXY
  if (http?.trustProxy !== undefined) {
    app.set("trust proxy", http.trustProxy);
  }

  // Registered first so every request, including ones rejected by helmet,
  // CORS, the KYC webhook router or a rate limiter, is logged and carries a
  // correlation ID.
  app.use(
    createRequestObservabilityMiddleware({
      logger: appLogger,
      metricsEnabled,
      metricsRegistry,
    })
  );

  app.use(helmet());

  app.use(
    cors({
      origin: http?.corsAllowedOrigins && http.corsAllowedOrigins.length > 0
        ? http.corsAllowedOrigins
        : false,
      credentials: http?.corsAllowCredentials ?? false,
    })
  );

  if (kycService) {
    app.use("/api/v1/kyc", createKycWebhookRouter(kycService));
  }

  app.use(express.json());

  app.use(sanitizeInputMiddleware);

  // FORCE RATE LIMITER (tests depend on it)
  if (http?.rateLimit?.enabled !== false) {
    applyRateLimiters(app, appLogger, {
      global: http?.rateLimit
        ? {
            windowMs: http.rateLimit.windowMs ?? 60_000,
            max: http.rateLimit.max ?? 100,
          }
        : undefined,
    });
  }
  app.get("/health", async (_req, res) => {
    const requestId = (_req as RequestWithId).requestId ?? randomUUID();

    const database = await probeDatabase();
    const horizon = await probeHorizon();
    const healthy = database === "ok" && horizon === "ok";

    if (healthy) {
      appLogger?.info("Health check passed", { requestId, database, horizon });
    } else {
      appLogger?.warn("Health check degraded", { requestId, database, horizon });
    }

    res.status(healthy ? 200 : 503).json({
      success: healthy,
      requestId,
      data: {
        status: healthy ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        uptimeSeconds: Number(process.uptime().toFixed(3)),
        version: packageInfo.version,
        requestId,
        traceId: requestId,
        database,
        horizon,
      },
    });
  });

  app.get("/ready", async (_req, res) => {
    const checks: ReadinessChecks = readinessChecks ?? {
      database: async () => {
        if (!dataSource.isInitialized) {
          throw new Error("Database connection is not initialized");
        }
        await dataSource.query("SELECT 1");
      },
      redis: async () => {
        await getRedisClient().ping();
      },
    };
    const [database, redis] = await Promise.all([
      checkDependency("database", checks.database, appLogger),
      checkDependency("redis", checks.redis, appLogger),
    ]);
    const ready = database.status === "ok" && redis.status === "ok";

    res.status(ready ? 200 : 503).json({
      success: ready,
      data: {
        status: ready ? "ready" : "not_ready",
        dependencies: { database, redis },
      },
    });
  });

  app.get("/health/db", async (_req, res) => {
    if (!dataSource.isInitialized) {
      return res.status(503).json({
        success: false,
        error: {
          code: "DB_NOT_INITIALIZED",
          message: "Database connection is not initialized.",
        },
      });
    }

    res.status(200).json({ success: true });
  });

  if (metricsEnabled) {
    app.get("/metrics", (_req, res) => {
      res.setHeader("Content-Type", getMetricsContentType());
      res.send(metricsRegistry.renderPrometheusMetrics());
    });
  }

  // Every request with a bearer token for a suspended wallet gets a 403,
  // on all authenticated routes.
  app.use(
    "/api/v1",
    createSuspendedWalletGuard(
      suspensionLookup ?? createDataSourceSuspensionLookup(dataSource),
      appLogger
    )
  );

  app.use("/api/v1/auth", createAuthRouter(authService, appLogger));
  app.use("/auth", createAuthRouter(authService, appLogger));
  app.use("/api/v1", createCommunityProgramsRouter(dataSource, authService));
  // #672-#675 — minimal read views over already-indexed syndicate/risk/loyalty/pool events.
  app.use("/api/v1", createOnchainEventViewsRouter(dataSource));
  app.use("/", createOnchainEventViewsRouter(dataSource));

  if (kycService) {
    app.use("/api/v1/kyc", createKycRouter(kycService, authService));
  }

  if (notificationService) {
    app.use("/api/v1/notifications", createNotificationRouter(notificationService, authService));
    app.use("/notifications", createNotificationRouter(notificationService, authService));
  }

  // The emergency pause guard only has something to check when a Soroban
  // contract and an RPC endpoint are both configured; otherwise the routers
  // mount without it and behave exactly as before.
  const pauseGuardContractId = config?.sorobanEscrow.contractId ?? null;
  const pauseGuardRpcUrl = config?.sorobanEscrow.rpcUrl ?? null;
  const contractGuardService =
    pauseGuardRpcUrl && pauseGuardContractId
      ? createContractGuardService({ rpcUrl: pauseGuardRpcUrl })
      : undefined;

  if (invoiceService && config) {
    const invoiceRouter = createInvoiceRouter({
      invoiceService,
      config,
      investmentService,
      authService,
      contractGuardService,
      contractId: pauseGuardContractId,
      invoiceSearchService,
      extensionService,
      draftService,
    });
    app.use("/api/v1/invoices", invoiceRouter);
    app.use("/invoices", invoiceRouter);
  }

  if (investmentService) {
    app.use(
      "/api/v1/investments",
      createInvestmentRouter({
        investmentService,
        authService,
        contractGuardService,
        contractId: pauseGuardContractId,
      })
    );
  }

  // Issue #473 — accreditation acknowledgement
  if (acknowledgementService) {
    const investorRouter = createInvestorRouter({
      authService,
      acknowledgementService,
      riskProfileService: investorRiskProfileService,
    });
    app.use("/api/v1/investors", investorRouter);
    app.use("/investors", investorRouter);
  }

  // Issue #479 — portfolio summary with P&L
  if (portfolioService) {
    const portfolioRouter = createPortfolioRouter({ authService, portfolioService });
    app.use("/api/v1/portfolio", portfolioRouter);
    app.use("/portfolio", portfolioRouter);
  }

  if (settlementService) {
    app.use(
      "/api/v1/settlements",
      createSettlementRouter({
        settlementService,
        settlementWorker,
        contractGuardService,
        contractId: pauseGuardContractId,
      })
    );
  }

  if (marketplaceService) {
    app.use("/api/v1/marketplace", createMarketplaceRouter({ marketplaceService }));
    app.use("/marketplace", createMarketplaceRouter({ marketplaceService }));
  }

  if (sellerService) {
    app.use("/api/v1/seller", createSellerRouter({ sellerService, authService }));
    app.use("/seller", createSellerRouter({ sellerService, authService }));
  }

  if (secondaryMarketService && authService) {
    app.use(
      "/api/v1/secondary",
      createSecondaryMarketRouter({ secondaryMarketService, authService })
    );
  }

  if (watchlistService && authService) {
    app.use("/api/v1/watchlist", createWatchlistRouter({ watchlistService, authService }));
  }

  // Issue #663 — FX rate indexer & currency conversion
  app.use("/api/v1/fx", createFxRouter());
  app.use("/fx", createFxRouter());

  // ---- Keys: Ratings Leaderboard, Buy Limits, Curve Migrations, Merge Proposals ----
  if (
    ratingsLeaderboardService ||
    creatorKeyService ||
    curveMigrationService ||
    keyMergeProposalService
  ) {
    app.use(
      "/api/v1/keys",
      createKeysRouter({
        ratingsLeaderboardService,
        authService,
        creatorKeyService,
        curveMigrationService,
        keyMergeProposalService,
      })
    );
  }

  // ---- Dividends: Cycle Config & Distribution ----
  if (dividendCycleService) {
    app.use(
      "/api/v1/dividends",
      createDividendsRouter({ dividendCycleService, authService, dividendDistributionService })
    );
  }

  // ---- Royalties: creator earnings and claim history (issue #537) ----
  if (royaltyEarningsService) {
    app.use("/api/v1/royalties", createRoyaltiesRouter({ royaltyEarningsService, authService }));
  }

  // ---- Subscriptions: gated-content access check (issue #539) ----
  // Public read: a content gate has to answer before the visitor is known.
  if (subscriptionStatusService) {
    app.use("/api/v1/subscriptions", createSubscriptionsRouter({ subscriptionStatusService }));
  }

  // ---- Onboarding: tour completion state (issue #540) ----
  if (onboardingService) {
    app.use("/api/v1/onboarding", createOnboardingRouter({ onboardingService, authService }));
  }

  // ---- Issuer Reputation (issue #593) ----
  if (issuerReputationService && authService) {
    app.use(
      "/api/v1",
      createIssuerReputationRouter({
        issuerReputationService,
        authService,
        adminWallets: config?.admin?.wallets || [],
      })
    );
  }

  if (swapService) {
    const swapRouter = createSwapRouter({ swapService, authService });
    app.use("/api/v1/swaps", swapRouter);
    app.use("/swaps", swapRouter);
  }

  if (config?.admin?.ipWhitelist?.length) {
    app.use(
      "/api/v1/admin",
      createAdminRouter({
        dataSource,
        allowedCidrs: config.admin.ipWhitelist,
        authService,
        aclService,
        invoiceService,
        adminUserService,
        extensionService,
        metricsService: adminMetricsService,
        adminSettlementService,
        adminWallets: config.admin?.wallets || [],
        invoiceEscrowContractService,
        feeScheduleService,
        waitlistService,
        notificationService
      })
    );
  }

  // Contract event indexes (#676-#679)
  if (benchmarkService) {
    app.use("/api/v1/benchmarks", createBenchmarkRouter({ benchmarkService }));
    app.use("/api/v1/invoices", createInvoiceBenchmarkRouter({ benchmarkService }));
  }

  if (referralTierService) {
    app.use("/api/v1/referrals", createReferralTierRouter({ referralTierService }));
  }

  if (yieldBoostService) {
    app.use("/api/v1/invoices", createYieldBoostRouter({ yieldBoostService }));
  }

  if (secondaryAuctionService) {
    app.use("/api/v1/auctions", createSecondaryAuctionRouter({ secondaryAuctionService }));
    app.use("/api/v1/invoices", createInvoiceAuctionRouter({ secondaryAuctionService }));
  }

  app.use(notFoundMiddleware);
  app.use(createErrorMiddleware(appLogger));

  return app;
}
