import "reflect-metadata";
import request from "supertest";
import { DataSource, getMetadataArgsStorage } from "typeorm";
import { Keypair } from "@stellar/stellar-sdk";
import crypto from "crypto";
import { createApp } from "../../src/app";
import { createAuthService } from "../../src/services/auth.service";
import { createInvoiceService } from "../../src/services/invoice.service";
import { createInvestmentService } from "../../src/services/investment.service";
import { createSettlementService } from "../../src/services/settlement.service";
import { createAdminSettlementService } from "../../src/services/admin-settlement.service";
import { createMarketplaceService } from "../../src/services/marketplace.service";
import jwt from "jsonwebtoken";
import { createNotificationService } from "../../src/services/notification.service";
import type { IPFSService } from "../../src/services/ipfs.service";
import { User } from "../../src/models/User.model";
import { Investment } from "../../src/models/Investment.model";
import { Invoice } from "../../src/models/Invoice.model";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { InvestorPayout } from "../../src/models/InvestorPayout.model";
import { InvoiceStatus, InvestmentStatus, KYCStatus, UserType, NotificationType } from "../../src/types/enums";
import { InvestorPayoutStatus } from "../../src/models/InvestorPayout.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { InvoiceStatusHistory } from "../../src/models/InvoiceStatusHistory.model";
import { InvestorReturn } from "../../src/models/InvestorReturn.model";
import { InvestorAcknowledgement } from "../../src/models/InvestorAcknowledgement.model";
import type { AppConfig } from "../../src/config/env";
import { logger } from "../../src/observability/logger";
import { InvoiceEscrowContractService } from "../../src/services/stellar/invoice-escrow-contract.service";

function patchEntityMetadataForSQLite(): void {
  const columns = getMetadataArgsStorage().columns;
  for (const col of columns) {
    if (col.options.type === "timestamptz") {
      col.options.type = "datetime" as any;
    }
    if (col.options.type === "jsonb") {
      col.options.type = "text" as any;
    }
    if (col.options.type === "enum") {
      col.options.type = "varchar" as any;
    }
  }
}

function createMockInvoiceEscrowContract(): InvoiceEscrowContractService {
  // Create a mock that simulates successful on-chain settlement
  const mockRpcServer = {
    getAccount: jest.fn().mockResolvedValue({ 
      accountId: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      sequenceNumber: "1",
      balances: [],
      flags: 0,
      thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
      signers: [],
      data: {},
      numSubEntries: 0,
    }),
    prepareTransaction: jest.fn().mockImplementation(async (tx) => tx),
    sendTransaction: jest.fn().mockResolvedValue({ status: "PENDING", hash: "mock-tx-hash-" + crypto.randomUUID() }),
    getTransaction: jest.fn().mockResolvedValue({ status: "SUCCESS", ledger: 12345 }),
  } as any;

  return new InvoiceEscrowContractService({
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    server: mockRpcServer,
    networkPassphrase: "Test SDF Network ; September 2015",
    platformSecretKey: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    confirmationPollMs: 0,
    confirmationAttempts: 1,
  }, logger);
}

/**
 * The on-chain call is not what this suite exercises, so stub it rather than
 * relying on a real signer and RPC round trip.
 */
function stubSuccessfulOnChainSettlement(service: InvoiceEscrowContractService): void {
  jest
    .spyOn(service, "settleEscrowOnChain")
    .mockResolvedValue({ transactionHash: `mock-settle-${crypto.randomUUID()}`, ledger: 12345 });
}

describe("Admin Settlement Endpoint Integration", () => {
  // Bootstrapping the schema and seeding three investors is slower than the
  // default 5s, which is fine in CI but flaky on a loaded machine.
  jest.setTimeout(30_000);

  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let config: AppConfig;

  let sellerKeypair: Keypair;
  let adminKeypair: Keypair;
  let sellerToken: string;
  let adminToken: string;
  let sellerId: string;

  beforeAll(async () => {
    sellerKeypair = Keypair.random();
    adminKeypair = Keypair.random();

    process.env.JWT_SECRET = "test-jwt-secret-key-for-e2e-tests-only";
    process.env.ADMIN_JWT_SECRET = "test-admin-jwt-secret-key-for-e2e-tests-only";
    process.env.ADMIN_API_KEY = "test-admin-key";
    process.env.SKIP_KYC_VERIFICATION = "true";

    config = {
      port: 3000,
      nodeEnv: "test",
      jwt: { secret: "test-jwt-secret-key-for-e2e-tests-only", expiresIn: "1h" },
      auth: { challengeTtlMs: 5 * 60 * 1000 },
      observability: { metricsEnabled: false },
      http: {
        trustProxy: false,
        corsAllowedOrigins: [],
        corsAllowCredentials: false,
        bodySizeLimit: "1mb",
        shutdownTimeoutMs: 15000,
        rateLimit: { enabled: false, windowMs: 60000, max: 1000 },
      },
      reconciliation: { enabled: false, intervalMs: 30000, batchSize: 25, gracePeriodMs: 60000, maxRuntimeMs: 10000 },
      stellar: { network: "testnet", networkPassphrase: "Test SDF Network ; September 2015" },
      sorobanEscrow: { 
        enabled: true, 
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM", 
        fundingMode: "wallet_xdr", 
        settlementMode: "wallet_xdr",
        rpcUrl: "https://soroban-testnet.stellar.org"
      },
      ipfs: {
        apiUrl: "https://ipfs.example.com",
        jwt: "test-ipfs-jwt",
        maxFileSizeMB: 10,
        allowedMimeTypes: ["application/pdf", "image/jpeg"],
        uploadRateLimit: { windowMs: 15 * 60 * 1000, maxUploads: 10 }
      },
      kyc: {
        skipVerification: true,
        webhookSecret: "test-kyc-webhook"
      },
      admin: { apiKey: "test-admin-key", ipWhitelist: ["127.0.0.1", "::1"] },
      cache: {
        redisUrl: undefined,
        invoicesListTtlSeconds: 30,
        invoiceDetailTtlSeconds: 60,
        enabled: true
      }
    } as unknown as AppConfig;

    patchEntityMetadataForSQLite();

    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      dropSchema: true,
      entities: [
        User,
        Investment,
        Invoice,
        AuthChallenge,
        Transaction,
        KYCVerification,
        Notification,
        InvestorPayout,
        KycHistory,
        SecondaryListing,
        Watchlist,
        InvoiceStatusHistory,
        InvestorReturn,
        InvestorAcknowledgement,
      ],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();

    const authService = createAuthService(dataSource, config);
    
    const mockIPFSService = {
      async uploadFile() { return { hash: "QmMockHash", size: 1024, timestamp: new Date().toISOString() }; }
    } as unknown as IPFSService;

    const invoiceService = createInvoiceService(dataSource, mockIPFSService);
    const investmentService = createInvestmentService(dataSource);
    const settlementService = createSettlementService(dataSource);
    const notificationService = createNotificationService(dataSource);
    const invoiceEscrowContract = createMockInvoiceEscrowContract();
    stubSuccessfulOnChainSettlement(invoiceEscrowContract);
    const adminSettlementService = createAdminSettlementService(
      dataSource,
      invoiceEscrowContract,
      notificationService
    );
    const marketplaceService = createMarketplaceService(dataSource);

    app = createApp({
      authService,
      invoiceService,
      investmentService,
      settlementService,
      adminSettlementService,
      marketplaceService,
      notificationService,
      config,
      logger,
      metricsEnabled: false,
    });
    
    // Create seller
    const seller = new User();
    seller.id = crypto.randomUUID();
    seller.stellarAddress = sellerKeypair.publicKey();
    seller.userType = UserType.SELLER;
    seller.kycStatus = KYCStatus.APPROVED;
    await dataSource.getRepository(User).save(seller);
    sellerId = seller.id;

    // Create admin user
    const admin = new User();
    admin.id = crypto.randomUUID();
    admin.stellarAddress = adminKeypair.publicKey();
    admin.userType = UserType.SELLER;
    admin.kycStatus = KYCStatus.APPROVED;
    await dataSource.getRepository(User).save(admin);

    // Generate tokens
    sellerToken = jwt.sign(
      {
        stellarAddress: sellerKeypair.publicKey(),
        userId: seller.id,
        userType: UserType.SELLER,
      },
      config.jwt.secret,
      { subject: sellerKeypair.publicKey(), expiresIn: "1h" }
    );
    
    // Generate admin token with admin role. authenticateAdminJWT verifies with
    // ADMIN_JWT_SECRET, so the token must be signed with that secret.
    adminToken = jwt.sign(
      { stellarAddress: adminKeypair.publicKey(), userId: admin.id, role: "admin" },
      process.env.ADMIN_JWT_SECRET!,
      { subject: adminKeypair.publicKey(), expiresIn: "1h" }
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("should settle a funded invoice via admin endpoint, record payouts, and notify investors", async () => {
    // Seed an invoice with face value 9000
    const invoice = new Invoice();
    invoice.id = crypto.randomUUID();
    invoice.sellerId = sellerId;
    invoice.invoiceNumber = "INV-ADMIN-9000";
    invoice.customerName = "Customer A";
    invoice.amount = "9000.0000";
    invoice.discountRate = "0.00";
    invoice.netAmount = "9000.0000";
    invoice.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    invoice.ipfsHash = "QmTestHash";
    invoice.status = InvoiceStatus.FUNDED;
    invoice.smartContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    await dataSource.getRepository(Invoice).save(invoice);

    // Create 3 investors
    const investors: User[] = [];
    for (let i = 0; i < 3; i++) {
      const investor = new User();
      investor.id = crypto.randomUUID();
      investor.stellarAddress = Keypair.random().publicKey();
      investor.userType = UserType.INVESTOR;
      investor.kycStatus = KYCStatus.APPROVED;
      await dataSource.getRepository(User).save(investor);
      investors.push(investor);
    }

    // Create 3 equal investments of 3000
    for (let i = 0; i < 3; i++) {
      const inv = new Investment();
      inv.id = crypto.randomUUID();
      inv.invoiceId = invoice.id;
      inv.investorId = investors[i].id;
      inv.investmentAmount = "3000.0000";
      inv.expectedReturn = "3000.0000";
      inv.status = InvestmentStatus.CONFIRMED;
      await dataSource.getRepository(Investment).save(inv);
    }

    // Settle invoice with admin token
    const res = await request(app)
      .post(`/api/v1/admin/invoices/${invoice.id}/settle`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-admin-key", "test-admin-key")
      .send({ repaymentAmount: "9000.0000" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.invoiceId).toBe(invoice.id);
    expect(res.body.data.status).toBe(InvoiceStatus.SETTLED);
    expect(res.body.data.repaymentAmount).toBe("9000.0000");
    expect(res.body.data.payouts).toHaveLength(3);
    expect(res.body.data.distributionTransactionHash).toBeDefined();

    // Assert invoice status is SETTLED
    const updatedInvoice = await dataSource.getRepository(Invoice).findOneBy({ id: invoice.id });
    expect(updatedInvoice?.status).toBe(InvoiceStatus.SETTLED);

    // Assert investor payouts were recorded
    const payouts = await dataSource.getRepository(InvestorPayout).find({ where: { invoiceId: invoice.id } });
    expect(payouts.length).toBe(3);
    for (const payout of payouts) {
      expect(payout.status).toBe(InvestorPayoutStatus.COMPLETED);
      expect(Number(payout.amount)).toBe(3000);
      expect(payout.stellarTxHash).toBeDefined();
    }

    // Assert investments updated
    const investments = await dataSource.getRepository(Investment).find({ where: { invoiceId: invoice.id } });
    for (const inv of investments) {
      expect(inv.status).toBe(InvestmentStatus.SETTLED);
      expect(Number(inv.actualReturn)).toBe(3000);
    }

    // Assert notifications created
    const notifications = await dataSource.getRepository(Notification).find({ where: { type: NotificationType.PAYMENT } });
    expect(notifications.length).toBe(3);
  });

  it("should return 400 for non-FUNDED invoice", async () => {
    // Create a PUBLISHED invoice (not FUNDED)
    const invoice = new Invoice();
    invoice.id = crypto.randomUUID();
    invoice.sellerId = sellerId;
    invoice.invoiceNumber = "INV-ADMIN-PUBLISHED";
    invoice.customerName = "Customer B";
    invoice.amount = "5000.0000";
    invoice.discountRate = "0.00";
    invoice.netAmount = "5000.0000";
    invoice.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    invoice.ipfsHash = "QmTestHash";
    invoice.status = InvoiceStatus.PUBLISHED;
    invoice.smartContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    await dataSource.getRepository(Invoice).save(invoice);

    const res = await request(app)
      .post(`/api/v1/admin/invoices/${invoice.id}/settle`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-admin-key", "test-admin-key")
      .send({ repaymentAmount: "5000.0000" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INVOICE_STATUS");
    expect(res.body.error.message).toContain("Cannot settle an invoice with status published");

    // Invoice should remain PUBLISHED
    const updatedInvoice = await dataSource.getRepository(Invoice).findOneBy({ id: invoice.id });
    expect(updatedInvoice?.status).toBe(InvoiceStatus.PUBLISHED);
  });

  it("should return 401 without admin token", async () => {
    const invoice = new Invoice();
    invoice.id = crypto.randomUUID();
    invoice.sellerId = sellerId;
    invoice.invoiceNumber = "INV-ADMIN-NO-TOKEN";
    invoice.customerName = "Customer C";
    invoice.amount = "5000.0000";
    invoice.discountRate = "0.00";
    invoice.netAmount = "5000.0000";
    invoice.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    invoice.ipfsHash = "QmTestHash";
    invoice.status = InvoiceStatus.FUNDED;
    invoice.smartContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    await dataSource.getRepository(Invoice).save(invoice);

    const res = await request(app)
      .post(`/api/v1/admin/invoices/${invoice.id}/settle`)
      .send({ repaymentAmount: "5000.0000" });

    expect(res.status).toBe(401);
  });

  it("should return 403 with seller token (not admin)", async () => {
    const invoice = new Invoice();
    invoice.id = crypto.randomUUID();
    invoice.sellerId = sellerId;
    invoice.invoiceNumber = "INV-ADMIN-SELLER-TOKEN";
    invoice.customerName = "Customer D";
    invoice.amount = "5000.0000";
    invoice.discountRate = "0.00";
    invoice.netAmount = "5000.0000";
    invoice.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    invoice.ipfsHash = "QmTestHash";
    invoice.status = InvoiceStatus.FUNDED;
    invoice.smartContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    await dataSource.getRepository(Invoice).save(invoice);

    const res = await request(app)
      .post(`/api/v1/admin/invoices/${invoice.id}/settle`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ repaymentAmount: "5000.0000" });

    expect(res.status).toBe(403);
  });

  it("should return 400 for missing repaymentAmount", async () => {
    const invoice = new Invoice();
    invoice.id = crypto.randomUUID();
    invoice.sellerId = sellerId;
    invoice.invoiceNumber = "INV-ADMIN-MISSING-AMT";
    invoice.customerName = "Customer E";
    invoice.amount = "5000.0000";
    invoice.discountRate = "0.00";
    invoice.netAmount = "5000.0000";
    invoice.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    invoice.ipfsHash = "QmTestHash";
    invoice.status = InvoiceStatus.FUNDED;
    invoice.smartContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    await dataSource.getRepository(Invoice).save(invoice);

    const res = await request(app)
      .post(`/api/v1/admin/invoices/${invoice.id}/settle`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-admin-key", "test-admin-key")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MISSING_FIELDS");
  });

  it("should return 404 for non-existent invoice", async () => {
    const res = await request(app)
      .post(`/api/v1/admin/invoices/${crypto.randomUUID()}/settle`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-admin-key", "test-admin-key")
      .send({ repaymentAmount: "5000.0000" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("INVOICE_NOT_FOUND");
  });

  it("should return 400 for zero repaymentAmount", async () => {
    const invoice = new Invoice();
    invoice.id = crypto.randomUUID();
    invoice.sellerId = sellerId;
    invoice.invoiceNumber = "INV-ADMIN-ZERO-AMT";
    invoice.customerName = "Customer F";
    invoice.amount = "5000.0000";
    invoice.discountRate = "0.00";
    invoice.netAmount = "5000.0000";
    invoice.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    invoice.ipfsHash = "QmTestHash";
    invoice.status = InvoiceStatus.FUNDED;
    invoice.smartContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    await dataSource.getRepository(Invoice).save(invoice);

    const res = await request(app)
      .post(`/api/v1/admin/invoices/${invoice.id}/settle`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-admin-key", "test-admin-key")
      .send({ repaymentAmount: "0.0000" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REPAYMENT_AMOUNT");
  });

  it("should return 400 for negative repaymentAmount", async () => {
    const invoice = new Invoice();
    invoice.id = crypto.randomUUID();
    invoice.sellerId = sellerId;
    invoice.invoiceNumber = "INV-ADMIN-NEG-AMT";
    invoice.customerName = "Customer G";
    invoice.amount = "5000.0000";
    invoice.discountRate = "0.00";
    invoice.netAmount = "5000.0000";
    invoice.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    invoice.ipfsHash = "QmTestHash";
    invoice.status = InvoiceStatus.FUNDED;
    invoice.smartContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    await dataSource.getRepository(Invoice).save(invoice);

    const res = await request(app)
      .post(`/api/v1/admin/invoices/${invoice.id}/settle`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-admin-key", "test-admin-key")
      .send({ repaymentAmount: "-100.0000" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_REPAYMENT_AMOUNT");
  });

  it("should return 502 when on-chain settlement fails", async () => {
    // Create a new mock that simulates on-chain failure
    const mockRpcServerFail = {
      getAccount: jest.fn().mockResolvedValue({ 
        accountId: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        sequenceNumber: "1",
        balances: [],
        flags: 0,
        thresholds: { lowThreshold: 0, medThreshold: 0, highThreshold: 0 },
        signers: [],
        data: {},
        numSubEntries: 0,
      }),
      prepareTransaction: jest.fn().mockImplementation(async (tx) => tx),
      sendTransaction: jest.fn().mockResolvedValue({ status: "ERROR", hash: "mock-tx-hash-fail", errorResult: "tx_failed" }),
      getTransaction: jest.fn().mockResolvedValue({ status: "FAILED", ledger: 12345 }),
    } as any;

    const failingInvoiceEscrowContract = new InvoiceEscrowContractService({
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      server: mockRpcServerFail,
      networkPassphrase: "Test SDF Network ; September 2015",
      platformSecretKey: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      confirmationPollMs: 0,
      confirmationAttempts: 1,
    }, logger);

    const notificationService = createNotificationService(dataSource);
    const failingAdminSettlementService = createAdminSettlementService(
      dataSource,
      failingInvoiceEscrowContract,
      notificationService
    );

    const failingApp = createApp({
      authService: createAuthService(dataSource, config),
      invoiceService: createInvoiceService(dataSource, {
        async uploadFile() { return { hash: "QmMockHash", size: 1024, timestamp: new Date().toISOString() }; }
      } as unknown as IPFSService),
      investmentService: createInvestmentService(dataSource),
      settlementService: createSettlementService(dataSource),
      adminSettlementService: failingAdminSettlementService,
      marketplaceService: createMarketplaceService(dataSource),
      notificationService,
      config,
      logger,
      metricsEnabled: false,
    });

    const invoice = new Invoice();
    invoice.id = crypto.randomUUID();
    invoice.sellerId = sellerId;
    invoice.invoiceNumber = "INV-ADMIN-FAIL";
    invoice.customerName = "Customer H";
    invoice.amount = "5000.0000";
    invoice.discountRate = "0.00";
    invoice.netAmount = "5000.0000";
    invoice.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    invoice.ipfsHash = "QmTestHash";
    invoice.status = InvoiceStatus.FUNDED;
    invoice.smartContractId = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    await dataSource.getRepository(Invoice).save(invoice);

    const res = await request(failingApp)
      .post(`/api/v1/admin/invoices/${invoice.id}/settle`)
      .set("Authorization", `Bearer ${adminToken}`)
      .set("x-admin-key", "test-admin-key")
      .send({ repaymentAmount: "5000.0000" });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("ON_CHAIN_SETTLEMENT_ERROR");

    // Invoice should remain FUNDED (no status change on failure)
    const updatedInvoice = await dataSource.getRepository(Invoice).findOneBy({ id: invoice.id });
    expect(updatedInvoice?.status).toBe(InvoiceStatus.FUNDED);

    // No investor payouts should be recorded
    const payouts = await dataSource.getRepository(InvestorPayout).find({ where: { invoiceId: invoice.id } });
    expect(payouts.length).toBe(0);
  });
});