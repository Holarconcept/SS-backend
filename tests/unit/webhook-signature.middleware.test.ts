import express, { Response } from "express";
import request from "supertest";
import crypto from "crypto";
import {
  createHmacWebhookMiddleware,
  RequestWithRawBody,
} from "../../src/middleware/webhook-signature.middleware";

describe("HMAC-SHA256 Webhook Signature Verification Middleware (#464)", () => {
  const SECRET = "super-secret-test-key-123";
  const TEST_ENV_VAR = "TEST_WEBHOOK_SECRET";

  beforeAll(() => {
    process.env[TEST_ENV_VAR] = SECRET;
  });

  afterAll(() => {
    delete process.env[TEST_ENV_VAR];
  });

  function createTestApp(options: Parameters<typeof createHmacWebhookMiddleware>[0] = {}) {
    const app = express();
    const middleware = createHmacWebhookMiddleware({
      secretEnvVar: TEST_ENV_VAR,
      ...options,
    });

    // Mount middleware BEFORE any JSON body parsing
    app.post("/webhook", middleware, (req: RequestWithRawBody, res: Response) => {
      res.status(200).json({
        success: true,
        receivedBody: req.body,
        hasRawBody: Buffer.isBuffer(req.rawBody),
        rawBodyString: req.rawBody?.toString("utf8"),
      });
    });

    return app;
  }

  function signPayload(payload: string, secret: string = SECRET): string {
    return crypto.createHmac("sha256", secret).update(payload).digest("hex");
  }

  it("rejects requests with missing signature header with 401", async () => {
    const app = createTestApp();
    const payload = JSON.stringify({ event: "kyc.verified", userId: "usr_1" });

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("MISSING_SIGNATURE_HEADER");
  });

  it("rejects requests with invalid signature with 401", async () => {
    const app = createTestApp();
    const payload = JSON.stringify({ event: "kyc.verified", userId: "usr_1" });
    const wrongSignature = signPayload(payload, "wrong-secret-key");

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", wrongSignature)
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_WEBHOOK_SIGNATURE");
  });

  it("passes requests with valid signature to route handler and preserves raw body", async () => {
    const app = createTestApp();
    const payload = JSON.stringify({ event: "invoice.funded", invoiceId: "inv_123" });
    const signature = signPayload(payload);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.hasRawBody).toBe(true);
    expect(res.body.rawBodyString).toBe(payload);
    expect(res.body.receivedBody).toEqual({ event: "invoice.funded", invoiceId: "inv_123" });
  });

  it("supports configurable header name per webhook source", async () => {
    const customHeader = "x-provider-signature";
    const app = createTestApp({ headerName: customHeader });
    const payload = JSON.stringify({ event: "payment.settled" });
    const signature = signPayload(payload);

    // Missing custom header
    const failRes = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", signature)
      .send(payload);

    expect(failRes.status).toBe(401);
    expect(failRes.body.error.message).toContain(customHeader);

    // With custom header
    const successRes = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set(customHeader, signature)
      .send(payload);

    expect(successRes.status).toBe(200);
    expect(successRes.body.success).toBe(true);
  });

  it("accepts signatures with 'sha256=' prefix", async () => {
    const app = createTestApp();
    const payload = JSON.stringify({ event: "partner.sync" });
    const signature = `sha256=${signPayload(payload)}`;

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("rejects with 401 when shared secret is not configured", async () => {
    const app = createTestApp({ secretEnvVar: "NON_EXISTENT_VAR", secret: undefined });
    const payload = JSON.stringify({ event: "test" });
    const signature = signPayload(payload);

    const res = await request(app)
      .post("/webhook")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", signature)
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("MISSING_WEBHOOK_SECRET");
  });

  it("works seamlessly when express.raw() is placed upstream", async () => {
    const app = express();
    app.post(
      "/webhook-raw",
      express.raw({ type: "application/json" }),
      createHmacWebhookMiddleware({ secret: SECRET }),
      (req: RequestWithRawBody, res: Response) => {
        res.status(200).json({
          success: true,
          rawBodyString: req.rawBody?.toString("utf8"),
        });
      }
    );

    const payload = JSON.stringify({ from: "raw" });
    const signature = signPayload(payload);

    const res = await request(app)
      .post("/webhook-raw")
      .set("Content-Type", "application/json")
      .set("x-webhook-signature", signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.rawBodyString).toBe(payload);
  });
});
