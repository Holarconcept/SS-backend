import crypto from "crypto";
import express from "express";
import request from "supertest";
import { QueryFailedError, type DataSource } from "typeorm";
import { Keypair } from "stellar-sdk";

import { createInvoiceStateMachine } from "../../src/lib/invoice-state-machine";
import { createErrorMiddleware } from "../../src/middleware/error.middleware";
import { resetRateLimitStores } from "../../src/middleware/rate-limit-wallet.middleware";
import { Investment } from "../../src/models/Investment.model";
import { InvestorAcknowledgement } from "../../src/models/InvestorAcknowledgement.model";
import { Invoice } from "../../src/models/Invoice.model";
import { InvoiceStatusHistory } from "../../src/models/InvoiceStatusHistory.model";
import type { AppLogger } from "../../src/observability/logger";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";
import type { AuthService } from "../../src/services/auth.service";
import {
  FUNDING_WINDOW_MS,
  InvestmentService,
  type InvestInInvoiceInput,
} from "../../src/services/investment.service";
import type { InvoiceService } from "../../src/services/invoice.service";
import { InvestmentStatus, InvoiceStatus, KYCStatus, UserType } from "../../src/types/enums";
import { ServiceError } from "../../src/utils/service-error";

const SELLER_ID = "seller-1";

function createMockLogger(): jest.Mocked<AppLogger> {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  } as unknown as jest.Mocked<AppLogger>;
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: crypto.randomUUID(),
    sellerId: SELLER_ID,
    invoiceNumber: "INV-465",
    customerName: "Acme Ltd",
    amount: "1000.0000",
    discountRate: "5.00",
    netAmount: "950.0000",
    fundedAmount: "0.0000",
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ipfsHash: "QmDoc",
    riskScore: null,
    status: InvoiceStatus.PUBLISHED,
    smartContractId: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    version: 1,
    ...overrides,
  } as unknown as Invoice;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * In-memory stand-in for Postgres, modelling what the endpoint relies on:
 *  - the conditional UPDATE is evaluated atomically against committed state
 *    (version, status and capacity in its WHERE clause);
 *  - the unique index on (invoice_id, investor_wallet, funding_block);
 *  - every write in a transaction is undone if the transaction fails.
 * Reads yield to the event loop so concurrent requests really interleave
 * between their read and their write.
 */
function createFakeDatabase(initial: Invoice, { interfere = false } = {}) {
  const invoices = new Map<string, Invoice>([[initial.id, { ...initial } as unknown as Invoice]]);
  const investments: Investment[] = [];
  const history: InvoiceStatusHistory[] = [];
  let transactions = 0;
  let conditionalUpdates = 0;

  function uniqueViolation(): QueryFailedError {
    return new QueryFailedError("INSERT INTO investments", [], {
      code: "23505",
      message: "duplicate key value violates unique constraint",
    } as unknown as Error);
  }

  function createManager(undo: Array<() => void>) {
    return {
      findOne: async (entity: unknown, { where }: { where: Record<string, unknown> }) => {
        await tick();
        if (entity === Invoice) {
          const row = invoices.get(where.id as string);
          const snapshot = row ? { ...row } : null;
          if (row && interfere) row.version += 1;
          return snapshot;
        }
        if (entity === Investment) {
          return (
            investments.find((row) =>
              Object.entries(where).every(
                ([key, value]) => (row as unknown as Record<string, unknown>)[key] === value
              )
            ) ?? null
          );
        }
        return null;
      },
      createQueryBuilder: () => {
        const params: Record<string, unknown> = {};
        const builder = {
          update: () => builder,
          set: () => builder,
          where: (_sql: string, p: Record<string, unknown> = {}) => (
            Object.assign(params, p),
            builder
          ),
          andWhere: (_sql: string, p: Record<string, unknown> = {}) => (
            Object.assign(params, p),
            builder
          ),
          setParameter: (key: string, value: unknown) => ((params[key] = value), builder),
          execute: async () => {
            conditionalUpdates++;
            const row = invoices.get(params.id as string);
            const amount = Number(params.amount);
            const fits =
              row &&
              row.version === params.version &&
              row.status === params.status &&
              Number(row.fundedAmount) + amount <= Number(row.netAmount) + 1e-9;
            if (!row || !fits) return { affected: 0 };
            const before = { fundedAmount: row.fundedAmount, version: row.version };
            row.fundedAmount = (Number(row.fundedAmount) + amount).toFixed(4);
            row.version += 1;
            undo.push(() => Object.assign(row, before));
            return { affected: 1 };
          },
        };
        return builder;
      },
      create: (_entity: unknown, data: Partial<Investment>) =>
        ({ id: crypto.randomUUID(), createdAt: new Date(), ...data }) as Investment,
      save: async (entity: unknown, value: unknown) => {
        if (entity === Investment) {
          const row = value as Investment;
          const clash = investments.some(
            (existing) =>
              existing.invoiceId === row.invoiceId &&
              existing.investorWallet === row.investorWallet &&
              existing.fundingBlock === row.fundingBlock
          );
          if (clash) throw uniqueViolation();
          investments.push(row);
          undo.push(() => investments.splice(investments.indexOf(row), 1));
        } else if (entity === Invoice) {
          const row = invoices.get((value as Invoice).id)!;
          const before = { ...row };
          Object.assign(row, value);
          undo.push(() => Object.assign(row, before));
        } else if (entity === InvoiceStatusHistory) {
          history.push(value as InvoiceStatusHistory);
          undo.push(() => history.pop());
        }
        return value;
      },
    };
  }

  const dataSource = {
    transaction: async (work: (manager: ReturnType<typeof createManager>) => Promise<unknown>) => {
      transactions++;
      const undo: Array<() => void> = [];
      try {
        return await work(createManager(undo));
      } catch (error) {
        undo.reverse().forEach((fn) => fn());
        throw error;
      }
    },
    // Issue #473 — the accreditation gate looks the investor's terms
    // acknowledgement up before creating the investment.
    getRepository: (entity: unknown) =>
      entity === InvestorAcknowledgement
        ? { findOne: async () => ({ acknowledgedAt: new Date() }) }
        : { find: async () => [] },
  } as unknown as DataSource;

  return {
    dataSource,
    invoice: () => invoices.get(initial.id)!,
    investments,
    history,
    stats: () => ({ transactions, conditionalUpdates }),
  };
}

function createService(db: ReturnType<typeof createFakeDatabase>) {
  return new InvestmentService(
    db.dataSource,
    createInvoiceStateMachine({ logger: createMockLogger() })
  );
}

const newWallet = () => Keypair.random().publicKey();

function investInput(invoice: Invoice, overrides: Partial<InvestInInvoiceInput> = {}) {
  return {
    invoiceId: invoice.id,
    investorId: crypto.randomUUID(),
    walletAddress: newWallet(),
    amount: "100",
    ledgerSequence: 1000,
    ...overrides,
  };
}

describe("POST /invoices/:id/invest (#465)", () => {
  describe("service", () => {
    it("records the investment and returns the updated funding state", async () => {
      const invoice = makeInvoice();
      const db = createFakeDatabase(invoice);

      const result = await createService(db).investInInvoice(
        investInput(invoice, { amount: "237.5" })
      );

      expect(result.investment).toMatchObject({
        invoiceId: invoice.id,
        investmentAmount: "237.5000",
        expectedReturn: "250.0000",
        status: InvestmentStatus.PENDING,
        fundingBlock: "1000",
      });
      expect(result.funding).toEqual({
        invoiceId: invoice.id,
        status: InvoiceStatus.PUBLISHED,
        targetAmount: "950.0000",
        fundedAmount: "237.5000",
        remainingCapacity: "712.5000",
        fundedPercent: "25.00",
        version: 2,
      });
      expect(db.invoice().fundedAmount).toBe("237.5000");
    });

    it("updates funded_amount and inserts the investment in a single transaction", async () => {
      const invoice = makeInvoice();
      const db = createFakeDatabase(invoice);

      await createService(db).investInInvoice(investInput(invoice));

      expect(db.stats()).toEqual({ transactions: 1, conditionalUpdates: 1 });
      expect(db.investments).toHaveLength(1);
    });

    it("rejects an investment that would exceed the invoice target", async () => {
      const invoice = makeInvoice({ fundedAmount: "900.0000" });
      const db = createFakeDatabase(invoice);

      await expect(
        createService(db).investInInvoice(investInput(invoice, { amount: "50.0001" }))
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_CAPACITY",
        statusCode: 422,
        details: { remainingCapacity: "50.0000" },
      });
      expect(db.invoice().fundedAmount).toBe("900.0000");
      expect(db.investments).toHaveLength(0);
    });

    it("accepts an investment that exactly fills the invoice and marks it funded", async () => {
      const invoice = makeInvoice({ fundedAmount: "900.0000" });
      const db = createFakeDatabase(invoice);

      const result = await createService(db).investInInvoice(
        investInput(invoice, { amount: "50" })
      );

      expect(result.funding).toMatchObject({
        status: InvoiceStatus.FUNDED,
        fundedAmount: "950.0000",
        remainingCapacity: "0.0000",
        fundedPercent: "100.00",
      });
      expect(db.invoice().status).toBe(InvoiceStatus.FUNDED);
      expect(db.invoice().fundedAmount).toBe("950.0000");
      expect(db.history).toEqual([
        expect.objectContaining({
          fromStatus: InvoiceStatus.PUBLISHED,
          toStatus: InvoiceStatus.FUNDED,
        }),
      ]);
    });

    it("never over-funds under concurrent investments", async () => {
      const invoice = makeInvoice();
      const db = createFakeDatabase(invoice);
      const service = createService(db);

      const results = await Promise.allSettled(
        Array.from({ length: 12 }, () =>
          service.investInInvoice(investInput(invoice, { amount: "200" }))
        )
      );

      const succeeded = results.filter((r) => r.status === "fulfilled");
      const failures = results
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason as ServiceError).code);

      const committed = db.investments.reduce((sum, row) => sum + Number(row.investmentAmount), 0);
      expect(committed).toBeLessThanOrEqual(950);
      expect(Number(db.invoice().fundedAmount)).toBe(committed);
      expect(succeeded.length).toBe(db.investments.length);
      expect(succeeded.length).toBeLessThanOrEqual(4);
      expect(new Set(failures)).toEqual(
        new Set(
          failures.filter((code) =>
            ["INSUFFICIENT_CAPACITY", "CONCURRENT_INVESTMENT_CONFLICT"].includes(code)
          )
        )
      );
    });

    it("lets exactly one of two racing investments through when only one fits", async () => {
      const invoice = makeInvoice();
      const db = createFakeDatabase(invoice);
      const service = createService(db);

      const results = await Promise.allSettled([
        service.investInInvoice(investInput(invoice, { amount: "600" })),
        service.investInInvoice(investInput(invoice, { amount: "600" })),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const [rejected] = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      // The loser's first update lost the race, so it re-read the invoice
      // and found too little capacity left.
      expect(rejected.reason).toMatchObject({ code: "INSUFFICIENT_CAPACITY", statusCode: 422 });
      expect(db.invoice().fundedAmount).toBe("600.0000");
    });

    it("retries a lost race and succeeds when capacity remains", async () => {
      const invoice = makeInvoice();
      const db = createFakeDatabase(invoice);
      const service = createService(db);

      const results = await Promise.all([
        service.investInInvoice(investInput(invoice, { amount: "300" })),
        service.investInInvoice(investInput(invoice, { amount: "300" })),
      ]);

      expect(results.map((r) => r.funding.fundedAmount).sort()).toEqual(["300.0000", "600.0000"]);
      expect(db.invoice().fundedAmount).toBe("600.0000");
      expect(db.stats().conditionalUpdates).toBe(3);
    });

    it("gives up with a 409 after repeated conflicts", async () => {
      const invoice = makeInvoice();
      // A competing writer bumps the version between every read and update.
      const db = createFakeDatabase(invoice, { interfere: true });
      await expect(createService(db).investInInvoice(investInput(invoice))).rejects.toMatchObject({
        code: "CONCURRENT_INVESTMENT_CONFLICT",
        statusCode: 409,
      });
      expect(db.stats().conditionalUpdates).toBe(3);
      expect(db.invoice().fundedAmount).toBe("0.0000");
    });

    describe("duplicate investments", () => {
      it("rejects a second investment from the same wallet in the same block", async () => {
        const invoice = makeInvoice();
        const db = createFakeDatabase(invoice);
        const service = createService(db);
        const walletAddress = newWallet();

        await service.investInInvoice(investInput(invoice, { walletAddress, ledgerSequence: 77 }));
        await expect(
          service.investInInvoice(investInput(invoice, { walletAddress, ledgerSequence: 77 }))
        ).rejects.toMatchObject({ code: "DUPLICATE_INVESTMENT", statusCode: 409 });

        expect(db.investments).toHaveLength(1);
        expect(db.invoice().fundedAmount).toBe("100.0000");
      });

      it("allows the same wallet to invest again in a later block", async () => {
        const invoice = makeInvoice();
        const db = createFakeDatabase(invoice);
        const service = createService(db);
        const walletAddress = newWallet();

        await service.investInInvoice(investInput(invoice, { walletAddress, ledgerSequence: 77 }));
        await service.investInInvoice(investInput(invoice, { walletAddress, ledgerSequence: 78 }));

        expect(db.invoice().fundedAmount).toBe("200.0000");
      });

      it("buckets requests without a ledger into the current funding window", async () => {
        const invoice = makeInvoice();
        const db = createFakeDatabase(invoice);
        const service = createService(db);
        const walletAddress = newWallet();
        const now = jest.spyOn(Date, "now").mockReturnValue(FUNDING_WINDOW_MS * 1000 + 10);

        try {
          const first = await service.investInInvoice(
            investInput(invoice, { walletAddress, ledgerSequence: undefined })
          );
          expect(first.investment.fundingBlock).toBe("1000");

          await expect(
            service.investInInvoice(
              investInput(invoice, { walletAddress, ledgerSequence: undefined })
            )
          ).rejects.toMatchObject({ code: "DUPLICATE_INVESTMENT" });

          now.mockReturnValue(FUNDING_WINDOW_MS * 1001);
          await expect(
            service.investInInvoice(
              investInput(invoice, { walletAddress, ledgerSequence: undefined })
            )
          ).resolves.toBeDefined();
        } finally {
          now.mockRestore();
        }
      });

      it("rolls back funded_amount when concurrent duplicates race past the pre-check", async () => {
        const invoice = makeInvoice();
        const db = createFakeDatabase(invoice);
        const service = createService(db);
        const walletAddress = newWallet();

        const results = await Promise.allSettled([
          service.investInInvoice(investInput(invoice, { walletAddress, amount: "100" })),
          service.investInInvoice(investInput(invoice, { walletAddress, amount: "100" })),
        ]);

        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const [rejected] = results.filter(
          (r): r is PromiseRejectedResult => r.status === "rejected"
        );
        expect(rejected.reason).toMatchObject({ code: "DUPLICATE_INVESTMENT", statusCode: 409 });
        expect(db.investments).toHaveLength(1);
        expect(db.invoice().fundedAmount).toBe("100.0000");
      });
    });

    it.each([
      ["0", "INVALID_AMOUNT", 400],
      ["-5", "INVALID_AMOUNT", 400],
      ["1.00001", "INVALID_AMOUNT", 400],
      ["abc", "INVALID_AMOUNT", 400],
    ])("rejects amount %s", async (amount, code, statusCode) => {
      const invoice = makeInvoice();
      await expect(
        createService(createFakeDatabase(invoice)).investInInvoice(investInput(invoice, { amount }))
      ).rejects.toMatchObject({ code, statusCode });
    });

    it.each([
      ["not published", { status: InvoiceStatus.DRAFT }, "INVOICE_NOT_OPEN_FOR_INVESTMENT", 422],
      ["already funded", { status: InvoiceStatus.FUNDED }, "INVOICE_NOT_OPEN_FOR_INVESTMENT", 422],
      ["past due", { dueDate: new Date(Date.now() - 1000) }, "invoice_expired", 422],
    ])("rejects an invoice that is %s", async (_label, overrides, code, statusCode) => {
      const invoice = makeInvoice(overrides as Partial<Invoice>);
      await expect(
        createService(createFakeDatabase(invoice)).investInInvoice(investInput(invoice))
      ).rejects.toMatchObject({ code, statusCode });
    });

    it("accepts an investment on a date-only due date before that day has fully elapsed", async () => {
      // Postgres `date` columns come back from TypeORM as a bare "YYYY-MM-DD"
      // string, which `new Date(...)` parses as that day's midnight UTC.
      // Comparing against "now" directly would mark the invoice expired as
      // soon as the due date arrives, hours before the day is actually over.
      const todayUTC = new Date().toISOString().slice(0, 10);
      const invoice = makeInvoice({ dueDate: todayUTC as unknown as Date });

      await expect(
        createService(createFakeDatabase(invoice)).investInInvoice(investInput(invoice))
      ).resolves.toBeDefined();
    });

    it("rejects an investment once a date-only due date's day has fully elapsed", async () => {
      const yesterdayUTC = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const invoice = makeInvoice({ dueDate: yesterdayUTC as unknown as Date });

      await expect(
        createService(createFakeDatabase(invoice)).investInInvoice(investInput(invoice))
      ).rejects.toMatchObject({ code: "invoice_expired", statusCode: 422 });
    });

    it("rejects an investment once the funding deadline has passed, even with a future due date", async () => {
      // dueDate (repayment) is still a week out, but the funding campaign's
      // own deadline already closed - investInInvoice only checked dueDate,
      // letting investors buy into a campaign that should have been closed.
      const invoice = makeInvoice({
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        fundingDeadline: new Date(Date.now() - 1000),
      });

      await expect(
        createService(createFakeDatabase(invoice)).investInInvoice(investInput(invoice))
      ).rejects.toMatchObject({ code: "funding_deadline_passed", statusCode: 422 });
    });

    it("accepts an investment when the funding deadline is still open", async () => {
      const invoice = makeInvoice({
        dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        fundingDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      await expect(
        createService(createFakeDatabase(invoice)).investInInvoice(investInput(invoice))
      ).resolves.toBeDefined();
    });

    it("rejects the seller investing in their own invoice", async () => {
      const invoice = makeInvoice();
      await expect(
        createService(createFakeDatabase(invoice)).investInInvoice(
          investInput(invoice, { investorId: SELLER_ID })
        )
      ).rejects.toMatchObject({ code: "SELF_DEALING", statusCode: 403 });
    });

    it("returns 404 for an unknown invoice", async () => {
      const invoice = makeInvoice();
      await expect(
        createService(createFakeDatabase(invoice)).investInInvoice(
          investInput(invoice, { invoiceId: crypto.randomUUID() })
        )
      ).rejects.toMatchObject({ code: "INVOICE_NOT_FOUND", statusCode: 404 });
    });
  });

  describe("HTTP", () => {
    const investorKeypair = Keypair.random();
    const investorWallet = investorKeypair.publicKey();

    // The per-wallet rate limit is shared process-wide; each test starts clean.
    beforeEach(() => resetRateLimitStores());

    function buildApp(invoice: Invoice, kycStatus = KYCStatus.APPROVED) {
      const db = createFakeDatabase(invoice);
      const authService = {
        getCurrentUser: async (token: string) => {
          if (token !== "valid") throw new Error("bad token");
          return {
            id: "investor-1",
            stellarAddress: investorWallet,
            email: null,
            userType: UserType.INVESTOR,
            kycStatus,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        },
      } as unknown as AuthService;
      const config = {
        ipfs: {
          apiUrl: "https://api.pinata.cloud",
          jwt: "test",
          maxFileSizeMB: 10,
          allowedMimeTypes: ["application/pdf"],
          uploadRateLimit: { windowMs: 60_000, maxUploads: 10 },
        },
        kyc: { skipVerification: false },
      };

      const app = express();
      app.use(express.json());
      app.use(
        "/api/v1/invoices",
        createInvoiceRouter({
          invoiceService: {} as InvoiceService,
          config: config as never,
          investmentService: createService(db),
          authService,
        })
      );
      app.use(createErrorMiddleware(createMockLogger()));
      return { app, db };
    }

    const invest = (app: express.Express, invoiceId: string, body: object, token = "valid") =>
      request(app)
        .post(`/api/v1/invoices/${invoiceId}/invest`)
        .set("Authorization", `Bearer ${token}`)
        .send(body);

    it("returns 201 with the investment and the remaining capacity", async () => {
      const invoice = makeInvoice();
      const { app } = buildApp(invoice);

      const response = await invest(app, invoice.id, {
        walletAddress: investorWallet,
        amount: "150.25",
        ledgerSequence: 42,
      }).expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.data.investment).toMatchObject({
        invoiceId: invoice.id,
        investorWallet,
        investmentAmount: "150.2500",
        fundingBlock: "42",
        status: InvestmentStatus.PENDING,
      });
      expect(response.body.data.funding).toMatchObject({
        fundedAmount: "150.2500",
        remainingCapacity: "799.7500",
        targetAmount: "950.0000",
      });
    });

    it("returns a structured 422 when the investment exceeds capacity", async () => {
      const invoice = makeInvoice({ fundedAmount: "900.0000" });
      const { app } = buildApp(invoice);

      const response = await invest(app, invoice.id, {
        walletAddress: investorWallet,
        amount: "100",
      }).expect(422);

      expect(response.body.error).toEqual({
        code: "INSUFFICIENT_CAPACITY",
        message: "Investment amount 100.0000 exceeds remaining capacity 50.0000",
        details: { remainingCapacity: "50.0000" },
      });
    });

    it("returns 409 for a duplicate from the same wallet in the same block", async () => {
      const invoice = makeInvoice();
      const { app } = buildApp(invoice);
      const body = { walletAddress: investorWallet, amount: "10", ledgerSequence: 5 };

      await invest(app, invoice.id, body).expect(201);
      const response = await invest(app, invoice.id, body).expect(409);

      expect(response.body.error.code).toBe("DUPLICATE_INVESTMENT");
    });

    it("refuses to invest from someone else's wallet", async () => {
      const invoice = makeInvoice();
      const { app, db } = buildApp(invoice);

      const response = await invest(app, invoice.id, {
        walletAddress: newWallet(),
        amount: "10",
      }).expect(403);

      expect(response.body.error.code).toBe("WALLET_MISMATCH");
      expect(db.investments).toHaveLength(0);
    });

    it("requires approved KYC", async () => {
      const invoice = makeInvoice();
      const { app } = buildApp(invoice, KYCStatus.PENDING);

      const response = await invest(app, invoice.id, {
        walletAddress: investorWallet,
        amount: "10",
      }).expect(403);

      expect(response.body.error.code).toBe("KYC_NOT_APPROVED");
    });

    it("applies the per-wallet investment rate limit", async () => {
      const invoice = makeInvoice();
      const { app } = buildApp(invoice);

      for (let ledgerSequence = 1; ledgerSequence <= 10; ledgerSequence++) {
        await invest(app, invoice.id, {
          walletAddress: investorWallet,
          amount: "1",
          ledgerSequence,
        }).expect(201);
      }
      await invest(app, invoice.id, {
        walletAddress: investorWallet,
        amount: "1",
        ledgerSequence: 11,
      }).expect(429);
    });

    it("requires authentication", async () => {
      const invoice = makeInvoice();
      const { app } = buildApp(invoice);

      await request(app)
        .post(`/api/v1/invoices/${invoice.id}/invest`)
        .send({ walletAddress: investorWallet, amount: "10" })
        .expect(401);
    });

    it.each([
      [{ walletAddress: "not-a-wallet", amount: "10" }],
      [{ walletAddress: investorWallet }],
      [{ walletAddress: investorWallet, amount: "1.23456" }],
      [{ walletAddress: investorWallet, amount: "10", ledgerSequence: 0 }],
    ])("validates the body %j", async (body) => {
      const invoice = makeInvoice();
      const { app } = buildApp(invoice);

      await invest(app, invoice.id, body).expect(400);
    });
  });
});
