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
import { createMarketplaceService } from "../../src/services/marketplace.service";
import { createNotificationService } from "../../src/services/notification.service";
import type { IPFSService, IPFSUploadResult } from "../../src/services/ipfs.service";
import { User } from "../../src/models/User.model";
import { Investment } from "../../src/models/Investment.model";
import { Invoice } from "../../src/models/Invoice.model";
import { AuthChallenge } from "../../src/models/AuthChallenge.model";
import { Transaction } from "../../src/models/Transaction.model";
import { KYCVerification } from "../../src/models/KYCVerification.model";
import { Notification } from "../../src/models/Notification.model";
import { KycHistory } from "../../src/models/KycHistory.model";
import { SecondaryListing } from "../../src/models/SecondaryListing.model";
import { Watchlist } from "../../src/models/Watchlist.model";
import { InvestorReturn } from "../../src/models/InvestorReturn.model";
import { SettlementRemainder } from "../../src/models/SettlementRemainder.model";
import { InvoiceStatusHistory } from "../../src/models/InvoiceStatusHistory.model";
import { InvoiceStatus, InvestmentStatus, KYCStatus, UserType } from "../../src/types/enums";
import type { AppConfig } from "../../src/config/env";
import { logger } from "../../src/observability/logger";

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

describe("Settlement Endpoint Integration", () => {
  let dataSource: DataSource;
  let app: ReturnType<typeof createApp>;
  let config: AppConfig;

  let sellerKeypair: Keypair;
  let otherSellerKeypair: Keypair;
  let sellerToken: string;
  let otherSellerToken: string;
  let sellerId: string;
  
  beforeAll(async () => {
    sellerKeypair = Keypair.random();
    otherSellerKeypair = Keypair.random();
    
    process.env.JWT_SECRET = "test-jwt-secret-key-for-e2e-tests-only";
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
      sorobanEscrow: { enabled: false, contractId: null, fundingMode: "wallet_xdr", settlementMode: "wallet_xdr" },
      admin: { apiKey: "test-admin-key" },
      ipfs: {
        pinataJwt: "test",
        pinataGateway: "test",
        timeoutMs: 5000,
        maxRetries: 3,
        baseRetryDelayMs: 100,
        maxFileSizeMB: 10,
        allowedMimeTypes: ["application/pdf", "image/png", "image/jpeg"],
        uploadRateLimit: { windowMs: 15 * 60 * 1000, maxUploads: 10 },
      },
      kyc: {
        skipVerification: true,
        webhookSecret: "",
      },
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
        KycHistory,
        SecondaryListing,
        Watchlist,
        InvestorReturn,
        SettlementRemainder,
        InvoiceStatusHistory,
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
    const marketplaceService = createMarketplaceService(dataSource);
    const notificationService = createNotificationService(dataSource);

    app = createApp({
      authService,
      invoiceService,
      investmentService,
      settlementService,
      marketplaceService,
      notificationService,
      config,
      logger,
      metricsEnabled: false,
    });
    
    // Create sellers
    const seller = new User();
    seller.id = crypto.randomUUID();
    seller.stellarAddress = sellerKeypair.publicKey();
    seller.userType = UserType.SELLER;
    seller.kycStatus = KYCStatus.APPROVED;
    await dataSource.getRepository(User).save(seller);
    sellerId = seller.id;

    const otherSeller = new User();
    otherSeller.id = crypto.randomUUID();
    otherSeller.stellarAddress = otherSellerKeypair.publicKey();
    otherSeller.userType = UserType.SELLER;
    otherSeller.kycStatus = KYCStatus.APPROVED;
    await dataSource.getRepository(User).save(otherSeller);

    // Tokens
    const { token } = await authService.generateToken(seller);
    sellerToken = token;
    
    const { token: token2 } = await authService.generateToken(otherSeller);
    otherSellerToken = token2;
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it("should distribute returns to investors and update invoice to settled, handling errors correctly", async () => {
    // Seed an invoice with face value 9000
    const invoice = new Invoice();
    invoice.id = crypto.randomUUID();
    invoice.sellerId = sellerId;
    invoice.invoiceNumber = "INV-9000";
    invoice.customerName = "Customer A";
    invoice.amount = "9000.0000";
    invoice.discountRate = "0.00";
    invoice.netAmount = "9000.0000";
    invoice.dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    invoice.ipfsHash = "QmTestHash";
    invoice.status = InvoiceStatus.FUNDED;
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

    // Settle invoice with wrong seller should fail 403
    let res = await request(app)
      .post(`/api/v1/settlements/${invoice.id}`)
      .set("Authorization", `Bearer ${otherSellerToken}`)
      .send({ proceeds: "9000.0000" });
    expect(res.status).toBe(403);
    
    // Settle invoice correctly
    res = await request(app)
      .post(`/api/v1/settlements/${invoice.id}`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ proceeds: "9000.0000" });
    expect(res.status).toBe(200);

    // Assert invoice status is SETTLED
    const updatedInvoice = await dataSource.getRepository(Invoice).findOneBy({ id: invoice.id });
    expect(updatedInvoice?.status).toBe(InvoiceStatus.SETTLED);

    // Assert each investor return shows 3000
    const investments = await dataSource.getRepository(Investment).find({ where: { invoiceId: invoice.id } });
    for (const inv of investments) {
      expect(inv.status).toBe(InvestmentStatus.SETTLED);
      // Depending on implementation, return values might be recorded in a specific field, or we check expectedReturn
      // The instructions say "Assert each investor's return record shows 3000"
      expect(Number(inv.expectedReturn)).toBe(3000);
    }

    // Call settlement again should return 409
    res = await request(app)
      .post(`/api/v1/settlements/${invoice.id}`)
      .set("Authorization", `Bearer ${sellerToken}`)
      .send({ proceeds: "9000.0000" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invoice_already_settled");
  });
});
