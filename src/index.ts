import type { Server } from "http";

import { createApp } from "./app";

import dataSource from "./config/database";
import { getConfig } from "./config/env";
import { logger } from "./observability/logger";
import { MetricsRegistry } from "./observability/metrics";

import { createAuthService } from "./services/auth.service";
import {
  createDedupedNotificationStore,
  createNotificationService,
} from "./services/notification.service";
import { InvoiceService } from "./services/invoice.service";
import {
  createInvoiceStateMachine,
  createSellerNotificationEffect,
} from "./lib/invoice-state-machine";
import {
  createNotificationDispatchEffect,
  InMemoryDeadLetterSink,
  NotificationDispatcher,
  unlessDispatched,
} from "./lib/notification-dispatcher";
import { createInvestmentNotifier, createInvestorDirectory } from "./lib/invoice-notifications";
import { Invoice } from "./models/Invoice.model";
import { createIPFSService } from "./services/ipfs.service";
import { createInvestmentService } from "./services/investment.service";
import { createSettlementService } from "./services/settlement.service";
import { createAdminSettlementService } from "./services/admin-settlement.service";
import { createMarketplaceService } from "./services/marketplace.service";
import { createInvoiceSearchService } from "./services/invoice-search.service";
import { createAdminUserService } from "./services/admin-user.service";
import { KycService } from "./services/kyc.service";
import { PaymentDistributorContractService } from "./services/stellar/payment-distributor-contract.service";
import { createOnchainProjections } from "./services/onchain-projections.service";
import { InvoiceEscrowContractService } from "./services/stellar/invoice-escrow-contract.service";
import { getSorobanConfig } from "./config/stellar";
import { EventIndexerService } from "./services/stellar/event-indexer.service";
import { createInvoiceMaturityWorker, SettlementEventBus } from "./workers/invoice-maturity.worker";
import { createRatingsLeaderboardService } from "./services/ratings-leaderboard.service";
import { createDividendCycleService } from "./services/dividend-cycle.service";
import { createOnboardingService } from "./services/onboarding.service";
import { createSubscriptionStatusService } from "./services/subscription-status.service";
import { createSorobanSubscriptionReader } from "./services/stellar/soroban-subscription-reader";
import { createSecondaryMarketService } from "./services/secondary-market.service";
import { createWatchlistService } from "./services/watchlist.service";
import { createSettlementWorker } from "./workers/settlement.worker";
import { scheduleAnalyticsSnapshotJob } from "./workers/analytics-snapshot.worker";
import {
  scheduleSubscriptionExpiryJob,
  buildSubscriptionExpiryNotifier,
} from "./workers/subscription-expiry.worker";
import { createFeeScheduleService } from "./services/fee-schedule.service";
import { getRedisClient } from "./config/redis";
import { createIssuerReputationService } from "./services/issuer-reputation.service";
import { createInvestorRiskProfileService } from "./services/investor-risk-profile.service";
import { createInvoiceDraftService } from "./services/invoice-draft.service";
import { createWaitlistService } from "./services/waitlist.service";
import { createBenchmarkService } from "./services/benchmark.service";
import { createReferralTierService } from "./services/referral-tier.service";
import { createYieldBoostService } from "./services/yield-boost.service";
import { createSecondaryAuctionService } from "./services/secondary-auction.service";

export async function bootstrap(): Promise<{
  server: Server;
  settlementEvents: SettlementEventBus;
}> {
  const config = getConfig();

  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }

  const metricsRegistry = new MetricsRegistry();

  const authService = createAuthService(dataSource, config, logger, metricsRegistry);
  const notificationService = createNotificationService(dataSource);
  const ipfsService = createIPFSService(config.ipfs, logger);
  // One state machine shared by every service that changes invoice status,
  // so transitions are validated, recorded and notified the same way.
  // Funded, settled, rejected and approved events fan out through the queued
  // dispatcher; the seller effect still covers every other status change.
  const notificationDispatcher = new NotificationDispatcher({
    store: createDedupedNotificationStore(dataSource),
    investors: createInvestorDirectory(dataSource),
    deadLetters: new InMemoryDeadLetterSink(),
    logger,
  });
  const invoiceStateMachine = createInvoiceStateMachine({
    effects: [
      unlessDispatched(createSellerNotificationEffect(notificationService)),
      createNotificationDispatchEffect(notificationDispatcher),
    ],
  });
  const invoiceService = new InvoiceService({
    invoiceRepository: dataSource.getRepository(Invoice),
    ipfsService,
    dataSource,
    stateMachine: invoiceStateMachine,
  });
  // ---- Feature: Issuer Reputation (issue #593) ----
  const issuerReputationService = createIssuerReputationService(dataSource);

  // ---- Feature: Investor Risk Profile (issue #595) ----
  const investorRiskProfileService = createInvestorRiskProfileService(dataSource);

  const investmentService = createInvestmentService(
    dataSource,
    invoiceStateMachine,
    createInvestmentNotifier(notificationService, logger),
    investorRiskProfileService
  );

  // ---- Feature: Invoice Draft Autosave (issue #594) ----
  const draftService = createInvoiceDraftService(dataSource);

  const sorobanConfig = getSorobanConfig();

  const distributor =
    sorobanConfig.paymentDistributorContractId && sorobanConfig.platformSecretKey
      ? new PaymentDistributorContractService(
          { ...sorobanConfig, contractId: sorobanConfig.paymentDistributorContractId },
          logger
        )
      : undefined;
  const distributorConfig =
    distributor && sorobanConfig.platformFeeRecipient
      ? { feeRecipient: sorobanConfig.platformFeeRecipient, feeBps: sorobanConfig.platformFeeBps }
      : undefined;

  const invoiceEscrowContract =
    sorobanConfig.escrowContractId && sorobanConfig.rpcUrl && sorobanConfig.platformSecretKey
      ? new InvoiceEscrowContractService(
          {
            ...sorobanConfig,
            contractId: sorobanConfig.escrowContractId,
            networkPassphrase: sorobanConfig.networkPassphrase,
          },
          logger
        )
      : undefined;

  const settlementService = createSettlementService(
    dataSource,
    distributor,
    distributorConfig,
    invoiceStateMachine,
    undefined,
    notificationService,
    issuerReputationService
  );

  const adminSettlementService =
    invoiceEscrowContract && notificationService
      ? createAdminSettlementService(
          dataSource,
          invoiceEscrowContract,
          notificationService,
          invoiceStateMachine
        )
      : undefined;

  const marketplaceService = createMarketplaceService(dataSource);
  const kycService = new KycService(dataSource, config.kyc.webhookSecret ?? "", logger, notificationService);

  // Keep process.env.TERMS_VERSION aligned with resolved config for services
  // that read the env directly (acknowledgement gate in InvestmentService).
  if (!process.env.TERMS_VERSION) {
    process.env.TERMS_VERSION = config.termsVersion;
  }

  // ---- Feature: Ratings Leaderboard ----
  const ratingsLeaderboardService = createRatingsLeaderboardService(dataSource, {
    redisUrl: config.cache.redisUrl,
  });

  // ---- Feature: Dividend Cycle Config ----
  const dividendCycleService = createDividendCycleService(dataSource);

  // ---- Feature: Onboarding Tour Completion ----
  const onboardingService = createOnboardingService(dataSource);

  // Read models projected from Soroban contract events: creator key buy
  // limits, the integration ACL, curve migrations, atomic swap history, creator
  // royalty earnings and holder dividend cycles.
  const projections = createOnchainProjections({ dataSource, logger });

  // Issue #539 — gated-content access is answered by reading the holder's
  // on-chain key balance, so the status service reads through Soroban rather
  // than a projected table. Without a configured contract there is nothing to
  // read, so the route stays unmounted rather than failing every request.
  const subscriptionStatusService = sorobanConfig.subscriptionContractId
    ? createSubscriptionStatusService({
        holdingReader: createSorobanSubscriptionReader({
          contractId: sorobanConfig.subscriptionContractId,
          rpcUrl: sorobanConfig.rpcUrl,
          logger,
        }),
        logger,
      })
    : undefined;

  // ---- Feature: Secondary Market ----
  const secondaryMarketService = createSecondaryMarketService(dataSource, notificationService);

  // ---- Feature: Watchlist ----
  const watchlistService = createWatchlistService(dataSource);

  // ---- Feature: Settlement Worker ----
  const settlementWorker = createSettlementWorker(dataSource, settlementService);

  // ---- Feature: Fee Schedule Management (issue #592) ----
  const feeScheduleService = createFeeScheduleService(dataSource, getRedisClient());

  // ---- Feature: Waitlist Management (issue #599) ----
  const waitlistService = createWaitlistService(dataSource, logger);

  // Contract event indexes (#676-#679)
  const benchmarkService = createBenchmarkService(dataSource);
  const referralTierService = createReferralTierService(dataSource);
  const yieldBoostService = createYieldBoostService(dataSource);
  const secondaryAuctionService = createSecondaryAuctionService(dataSource);

  const app = createApp({
    authService,
    notificationService,
    invoiceService,
    investmentService,
    settlementService,
    adminSettlementService,
    marketplaceService,
    kycService,
    invoiceSearchService: createInvoiceSearchService(dataSource),
    adminUserService: createAdminUserService(dataSource, logger),
    ratingsLeaderboardService,
    dividendCycleService,
    dividendDistributionService: projections.dividendDistributionService,
    royaltyEarningsService: projections.royaltyEarningsService,
    subscriptionStatusService,
    onboardingService,
    swapService: projections.swapService,
    aclService: projections.aclService,
    creatorKeyService: projections.creatorKeyService,
    curveMigrationService: projections.curveMigrationService,
    keyMergeProposalService: projections.keyMergeProposalService,
    secondaryMarketService,
    watchlistService,
    settlementWorker,
    invoiceEscrowContractService: invoiceEscrowContract,
    feeScheduleService,
    issuerReputationService,
    investorRiskProfileService,
    draftService,
    waitlistService,
    benchmarkService,
    referralTierService,
    yieldBoostService,
    secondaryAuctionService,
    config,
    logger,
    metricsEnabled: config.observability.metricsEnabled,
  });

  const server = app.listen(config.port, () => {
    logger.info("Server running", { port: config.port });
  });

  // Settlement outcomes for notification dispatch; the state machine effects
  // above already notify sellers and investors of each status change.
  const settlementEvents = new SettlementEventBus();
  const maturityWorker = createInvoiceMaturityWorker(
    dataSource,
    settlementService,
    invoiceStateMachine,
    settlementEvents,
    config.maturity,
    logger
  );
  maturityWorker.start();

  // ---- Start daily analytics snapshot cron (midnight UTC) ----
  const snapshotScheduler = scheduleAnalyticsSnapshotJob(dataSource);

  // ---- Start daily subscription expiry notification check (midnight UTC) ----
  const subscriptionExpiryNotifier = buildSubscriptionExpiryNotifier(
    dataSource,
    createNotificationService(dataSource),
    logger
  );
  const subscriptionExpiryScheduler = scheduleSubscriptionExpiryJob(subscriptionExpiryNotifier, logger);

  // ---- Start settlement worker cron (hourly) ----
  settlementWorker.start("0 * * * *");

  // All deployed Soroban contracts whose events feed the indexer. The
  // read-model projections (creator key, ACL, curve migration, atomic swap,
  // royalty, dividend) dispatch by event topic rather than contract id, so
  // their events are only ever seen if the contract that emits them is
  // actually polled here.
  const sorobanEventContractIds = Array.from(
    new Set(
      [
        config.sorobanEscrow.contractId,
        sorobanConfig.escrowContractId,
        sorobanConfig.paymentDistributorContractId,
        sorobanConfig.subscriptionContractId,
        sorobanConfig.tokenContractId,
      ].filter((id): id is string => Boolean(id))
    )
  );

  const eventIndexer =
    config.sorobanIndexer.enabled &&
    sorobanEventContractIds.length > 0 &&
    config.sorobanEscrow.rpcUrl
      ? new EventIndexerService({
          contractIds: sorobanEventContractIds,
          rpcUrl: config.sorobanEscrow.rpcUrl,
          dataSource,
          logger,
          lagAlertThresholdLedgers: config.sorobanIndexer.lagAlertThresholdLedgers,
          eventBus: projections.eventBus,
        })
      : undefined;

  if (eventIndexer) {
    eventIndexer.start(config.sorobanIndexer.intervalMs);
  }

  server.on("close", () => {
    if (eventIndexer) {
      eventIndexer.stop();
    }
    void maturityWorker.stop();
    snapshotScheduler.stop();
    subscriptionExpiryScheduler.stop();
    settlementWorker.stop();
  });

  return { server, settlementEvents };
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error("Startup failed", { error: err });
    process.exit(1);
  });
}
