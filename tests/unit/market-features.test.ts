import express from "express";
import request from "supertest";
import { createFxRouter } from "../../src/routes/fx.routes";
import { createInvoiceRouter } from "../../src/routes/invoice.routes";
import { createInvestorRouter } from "../../src/routes/investor.routes";
import type { InvoiceService } from "../../src/services/invoice.service";
import type { AuthService } from "../../src/services/auth.service";
import type { InvestorAcknowledgementService } from "../../src/services/investor-acknowledgement.service";

describe("Market Features (#660, #661, #663, #664)", () => {
  describe("Issue #663: FX Rates API", () => {
    const app = express();
    app.use("/fx", createFxRouter());

    it("GET /fx/rates returns all rates with staleness calculation", async () => {
      const res = await request(app).get("/fx/rates");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.rates)).toBe(true);
      expect(res.body.data.rates.length).toBeGreaterThan(0);
      expect(res.body.data.rates[0]).toHaveProperty("pair");
      expect(res.body.data.rates[0]).toHaveProperty("rate");
      expect(res.body.data.rates[0]).toHaveProperty("stale");
    });

    it("GET /fx/rates/:pair returns single pair rate", async () => {
      const res = await request(app).get("/fx/rates/XLM%2FUSD");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pair).toBe("XLM/USD");
      expect(res.body.data.rate).toBe("0.1250");
      expect(res.body.data.stale).toBe(false);
    });

    it("GET /fx/rates/:pair returns 404 for unsupported pair", async () => {
      const res = await request(app).get("/fx/rates/UNKNOWN%2FUSD");
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe("Issue #660: Investor Scoring API", () => {
    const app = express();
    const mockAuthService = {} as AuthService;
    const mockAcknowledgementService = {} as InvestorAcknowledgementService;

    app.use(
      "/investors",
      createInvestorRouter({
        authService: mockAuthService,
        acknowledgementService: mockAcknowledgementService,
      })
    );

    it("GET /investors/:wallet/score returns score and tier", async () => {
      const wallet = "GD5TQ4TESTWALLETADDRESS";
      const res = await request(app).get(`/investors/${wallet}/score`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.wallet).toBe(wallet);
      expect(res.body.data.tier).toBe("gold");
      expect(typeof res.body.data.score).toBe("number");
    });

    it("GET /investors/:wallet/score/history returns paginated history", async () => {
      const wallet = "GD5TQ4TESTWALLETADDRESS";
      const res = await request(app).get(`/investors/${wallet}/score/history`);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.history)).toBe(true);
    });
  });

  describe("Issue #664 & #661: Invoice Orderbook Depth and Announcements API", () => {
    const app = express();
    const mockInvoiceService = {
      getInvoiceById: jest.fn(),
    } as unknown as InvoiceService;

    const mockConfig = {
      ipfs: { maxFileSizeMB: 10, allowedMimeTypes: ["application/pdf"] },
      cache: { enabled: false },
    } as any;

    app.use(
      "/invoices",
      createInvoiceRouter({
        invoiceService: mockInvoiceService,
        config: mockConfig,
      })
    );

    it("GET /invoices/:id/orderbook returns bids and asks grouped by price level", async () => {
      const res = await request(app).get("/invoices/inv-123/orderbook");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invoice_id).toBe("inv-123");
      expect(Array.isArray(res.body.data.bids)).toBe(true);
      expect(Array.isArray(res.body.data.asks)).toBe(true);
      expect(res.headers["cache-control"]).toContain("max-age=15");
    });

    it("GET /invoices/:id/announcements returns invoice announcements feed", async () => {
      const res = await request(app).get("/invoices/inv-123/announcements");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invoice_id).toBe("inv-123");
      expect(Array.isArray(res.body.data.announcements)).toBe(true);
    });

    it("GET /invoices/announcements/:announcementId/content returns IPFS content", async () => {
      const res = await request(app).get("/invoices/announcements/ann-1/content");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe("ann-1");
      expect(res.body.data.retrieved_from_cache).toBe(true);
    });
  });
});
