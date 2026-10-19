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
import { createKycRouter, createKlcWebhookRouter } from "./routes/kyc.routes";
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
import { createReferralRouter } from "./routes/referral.routes";
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
import type { ReferralService } from "./services/referral.service";
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
  referralService?: ReferralService;
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
  referralService,
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

  // → FIX TRUST PROXY
  if (http?.trustProxy !== undefined) {
    app.set("trust proxy", http.trustProxy);
  }

  // Registered first so every request, including ones rejected by helmet,
  // CO
}
