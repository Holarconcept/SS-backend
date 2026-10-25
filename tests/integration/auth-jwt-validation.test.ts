import crypto from "crypto";
import { createHmac } from "crypto";
import jwt from "jsonwebtoken";
import { Networks } from "@stellar/stellar-sdk";
import request from "supertest";

import { createApp } from "../../src/app";
import { AuthService } from "../../src/services/auth.service";
import type {
  ChallengeRepositoryContract,
  UserRepositoryContract,
} from "../../src/services/auth.service";
import { User } from "../../src/models/User.model";
import { KYCStatus, UserType } from "../../src/types/enums";

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_JWT_SECRET = "valid-test-secret";

/**
 * A syntactically valid Stellar address used as a stand-in wherever we need
 * a real-looking address that is NOT registered in the repository.
 */
const UNREGISTERED_ADDRESS = "GNONEXISTENTUSERADDRESS000000000000000000000000000000000";

// ── In-memory repositories ────────────────────────────────────────────────────

type InMemoryUser = User;

interface InMemoryChallenge {
  id: string;
  stellarAddress: string;
  nonceHash: string;
  message: string;
  network: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

class InMemoryUserRepository implements UserRepositoryContract {
  private readonly users = new Map<string, InMemoryUser>();

  async findById(id: string) {
    return this.users.get(id) ?? null;
  }

  async findByStellarAddress(stellarAddress: string) {
    return (
      [...this.users.values()].find((user) => user.stellarAddress === stellarAddress) ?? null
    );
  }

  async findByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async findAll(options?: {
    skip?: number;
    take?: number;
    cursor?: string;
    order?: "ASC" | "DESC";
  }) {
    let results = [...this.users.values()].filter((u) => !u.deletedAt);
    results.sort((a, b) =>
      options?.order === "ASC" ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)
    );
    if (options?.cursor) {
      const cursorIndex = results.findIndex((u) => u.id === options.cursor);
      if (cursorIndex >= 0) results = results.slice(cursorIndex + 1);
    }
    if (options?.skip) results = results.slice(options.skip);
    if (options?.take) results = results.slice(0, options.take);
    return results;
  }

  async count(options?: { cursor?: string }): Promise<number> {
    let results = [...this.users.values()].filter((u) => !u.deletedAt);
    if (options?.cursor) {
      const cursorIndex = results.findIndex((u) => u.id === options.cursor);
      if (cursorIndex >= 0) results = results.slice(0, cursorIndex);
    }
    return results.length;
  }

  async save(user: Partial<InMemoryUser>) {
    const now = new Date();
    const entity: InMemoryUser = {
      id: crypto.randomUUID(),
      stellarAddress: user.stellarAddress ?? "",
      email: user.email ?? null,
      userType: user.userType ?? UserType.INVESTOR,
      kycStatus: user.kycStatus ?? KYCStatus.PENDING,
      isKycVerified: user.isKycVerified ?? false,
      isSuspended: user.isSuspended ?? false,
      suspendedAt: user.suspendedAt ?? null,
      suspensionReason: user.suspensionReason ?? null,
      createdAt: user.createdAt ?? now,
      updatedAt: user.updatedAt ?? now,
      deletedAt: user.deletedAt ?? null,
      invoices: user.invoices ?? [],
      investments: user.investments ?? [],
      transactions: user.transactions ?? [],
      kycVerifications: user.kycVerifications ?? [],
      notifications: user.notifications ?? [],
      kycHistory: user.kycHistory ?? [],
      secondaryListings: user.secondaryListings ?? [],
      watchlistEntries: user.watchlistEntries ?? [],
    };
    this.users.set(entity.id, entity);
    return entity;
  }

  /** Test helper: seed a user directly. */
  seed(user: Partial<InMemoryUser>) {
    return this.save(user);
  }
}

class InMemoryChallengeRepository implements ChallengeRepositoryContract {
  readonly challenges = new Map<string, InMemoryChallenge>();

  async create(input: InMemoryChallenge) {
    const challenge: InMemoryChallenge = {
      id: crypto.randomUUID(),
      stellarAddress: input.stellarAddress,
      nonceHash: input.nonceHash,
      message: input.message,
      network: input.network,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
    };
    this.challenges.set(challenge.id, challenge);
    return challenge;
  }

  async findByAddressAndNonceHash(stellarAddress: string, nonceHash: string) {
    return (
      [...this.challenges.values()].find(
        (c) => c.stellarAddress === stellarAddress && c.nonceHash === nonceHash
      ) ?? null
    );
  }

  async consume(id: string, consumedAt: Date) {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.consumedAt) return false;
    challenge.consumedAt = consumedAt;
    return true;
  }

  async deleteExpired(before: Date): Promise<number> {
    let count = 0;
    for (const [id, challenge] of this.challenges.entries()) {
      if (challenge.expiresAt < before || (challenge.consumedAt && challenge.consumedAt < before)) {
        this.challenges.delete(id);
        count++;
      }
    }
    return count;
  }

  async countByStatus(status: "active" | "consumed" | "expired"): Promise<number> {
    const now = new Date();
    let count = 0;
    for (const challenge of this.challenges.values()) {
      if (status === "active" && !challenge.consumedAt && challenge.expiresAt > now) count++;
      if (status === "consumed" && challenge.consumedAt) count++;
      if (status === "expired" && !challenge.consumedAt && challenge.expiresAt <= now) count++;
    }
    return count;
  }
}

// ── Test helpers ──────────────────────────────────────────────────────────────

interface TestContext {
  app: ReturnType<typeof createApp>;
  userRepo: InMemoryUserRepository;
}

/**
 * Creates a fully wired test app together with the repositories so individual
 * tests can pre-seed users when they need the happy path.
 */
function createTestContext(): TestContext {
  const userRepo = new InMemoryUserRepository();
  const challengeRepo = new InMemoryChallengeRepository();

  const authService = new AuthService({
    userRepository: userRepo,
    challengeRepository: challengeRepo,
    config: {
      jwt: { secret: VALID_JWT_SECRET, expiresIn: "15m" },
      auth: { challengeTtlMs: 60_000 },
      stellar: { network: "testnet", networkPassphrase: Networks.TESTNET },
    },
  });

  return { app: createApp({ authService }), userRepo };
}

/** Build a signed JWT with the VALID_JWT_SECRET (signed HS256). */
function signedToken(
  claims: Record<string, unknown>,
  opts: jwt.SignOptions = { expiresIn: "15m" }
): string {
  return jwt.sign(claims, VALID_JWT_SECRET, opts);
}

/** Build a raw JWT manually (header + payload + custom signature). */
function rawJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  signingSecret: string
): string {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", signingSecret)
    .update(`${h}.${p}`)
    .digest("base64url");
  return `${h}.${p}.${sig}`;
}

/** Expected error envelope shape for all 401 responses. */
const AUTH_ERROR_ENVELOPE = {
  success: false,
  error: { message: expect.any(String) },
};

// ══════════════════════════════════════════════════════════════════════════════
// Basic JWT authentication
// ══════════════════════════════════════════════════════════════════════════════

describe("JWT authentication validation", () => {
  let ctx: TestContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createTestContext();
  });

  it("rejects GET /api/v1/auth/me when the JWT is signed with an invalid secret key", async () => {
    const forgedToken = jwt.sign(
      { sub: "GFORGED_STELLAR_ADDRESS", stellarAddress: "GFORGED_STELLAR_ADDRESS" },
      "invalid-secret-key",
      { expiresIn: "15m" }
    );

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${forgedToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects GET /api/v1/auth/me with expired JWT token", async () => {
    const expiredToken = jwt.sign(
      { sub: "GEXPIRED_STELLAR_ADDRESS", stellarAddress: "GEXPIRED_STELLAR_ADDRESS" },
      VALID_JWT_SECRET,
      { expiresIn: "-5m" }
    );

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${expiredToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("returns 401 from /me when the bearer token is missing", async () => {
    const response = await request(ctx.app).get("/api/v1/auth/me").expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Authorization token is required." },
    });
  });

  it("returns 200 with user data for a valid token belonging to a registered user", async () => {
    const stellarAddress = "GREGISTERED0000000000000000000000000000000000000000000000";
    const userId = crypto.randomUUID();

    // Seed the user so getCurrentUser finds them.
    await ctx.userRepo.seed({ id: userId, stellarAddress });

    const token = signedToken({ sub: stellarAddress, stellarAddress, userId });

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({
      user: { stellarAddress },
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Malformed tokens
// ══════════════════════════════════════════════════════════════════════════════

describe("JWT validation: malformed tokens", () => {
  let ctx: TestContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createTestContext();
  });

  it("rejects a completely random non-JWT string", async () => {
    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer not-a-jwt-at-all")
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects a token with only two parts (missing signature)", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "GTESTADDRESS", stellarAddress: "GTESTADDRESS" })
    ).toString("base64url");
    const twoPartToken = `${header}.${payload}`;

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${twoPartToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects an empty string as token", async () => {
    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer ")
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Authorization token is required." },
    });
  });

  it("rejects a token with invalid base64url encoding in payload", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const badToken = `${header}.!!!invalid-base64!!!.signature`;

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${badToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects a token that is only whitespace after Bearer", async () => {
    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Bearer    ")
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Authorization token is required." },
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Algorithm and signing attacks
// ══════════════════════════════════════════════════════════════════════════════

describe("JWT validation: algorithm and signing attacks", () => {
  let ctx: TestContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createTestContext();
  });

  it("rejects a token signed with 'none' algorithm", async () => {
    const unsignedToken = jwt.sign(
      { sub: "GNONEALGADDRESS", stellarAddress: "GNONEALGADDRESS", userId: crypto.randomUUID() },
      "",
      { algorithm: "none", expiresIn: "15m" }
    );

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${unsignedToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects a token signed with a different HS256 secret", async () => {
    const token = jwt.sign(
      { sub: "GDIFFERENT_SECRET_ADDR", stellarAddress: "GDIFFERENT_SECRET_ADDR" },
      "completely-different-secret",
      { algorithm: "HS256", expiresIn: "15m" }
    );

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects a manually constructed token signed with a wrong secret", async () => {
    const tamperedToken = rawJwt(
      { alg: "HS256", typ: "JWT" },
      {
        sub: "GTAMPEREDADDR",
        stellarAddress: "GTAMPEREDADDR",
        userId: crypto.randomUUID(),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      },
      "wrong-secret"
    );

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${tamperedToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects a token where only the signature segment is replaced", async () => {
    // Build a valid-structure token but replace the signature with one from
    // a different key so the header/payload pair look legitimate.
    const legitimate = signedToken({ sub: "GADDR", stellarAddress: "GADDR" });
    const [header, payload] = legitimate.split(".");
    const fakeSignature = createHmac("sha256", "attacker-key")
      .update(`${header}.${payload}`)
      .digest("base64url");
    const spliced = `${header}.${payload}.${fakeSignature}`;

    await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${spliced}`)
      .expect(401);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Missing or invalid claims
// ══════════════════════════════════════════════════════════════════════════════

describe("JWT validation: missing or invalid claims", () => {
  let ctx: TestContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createTestContext();
  });

  it("rejects a token with no sub claim", async () => {
    const token = signedToken({ stellarAddress: "GNOSUBCLAIM", userId: crypto.randomUUID() });

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects a token with an empty sub claim", async () => {
    const token = signedToken({ sub: "", stellarAddress: "" });

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects a token with sub set to a whitespace-only string", async () => {
    const token = signedToken({ sub: "   ", stellarAddress: "   " });

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({ success: false });
  });

  it("rejects a valid JWT for a user that does not exist in the repository", async () => {
    const token = signedToken({
      sub: UNREGISTERED_ADDRESS,
      stellarAddress: UNREGISTERED_ADDRESS,
      userId: crypto.randomUUID(),
    });

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("Invalid or expired token.") },
    });
  });

  it("rejects a token with sub set to a non-string value", async () => {
    // jwt.sign accepts number for sub via type cast
    const token = jwt.sign(
      { sub: 12345 as unknown as string, stellarAddress: "GNOTASTRING" },
      VALID_JWT_SECRET,
      { expiresIn: "15m" }
    );

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Authorization header edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe("JWT validation: Authorization header edge cases", () => {
  let ctx: TestContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createTestContext();
  });

  it("rejects request with lowercase 'bearer' prefix", async () => {
    const token = signedToken({ sub: "GLOWERCASEBEARER", stellarAddress: "GLOWERCASEBEARER" });

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `bearer ${token}`)
      .expect(401);

    // The auth middleware accepts case-insensitive "bearer" — it will strip the
    // token and pass it to getCurrentUser, which then rejects it because no
    // matching user exists. Either "Authorization token is required." OR
    // "Invalid or expired token." is acceptable.
    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: expect.stringMatching(
          /Authorization token is required\.|Invalid or expired token\./
        ),
      },
    });
  });

  it("rejects a Bearer value padded with surrounding whitespace", async () => {
    const token = signedToken({ sub: "GPADDEDWHITESPACE", stellarAddress: "GPADDEDWHITESPACE" });

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer   ${token}   `);

    expect(response.status).toBe(401);
    expect(response.body.success).toBe(false);
  });

  it("rejects a request using Basic auth scheme instead of Bearer", async () => {
    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Authorization token is required." },
    });
  });

  it("rejects a request with no Authorization header at all", async () => {
    const response = await request(ctx.app).get("/api/v1/auth/me").expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Authorization token is required." },
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Error response structure
// ══════════════════════════════════════════════════════════════════════════════

describe("JWT validation: error response structure", () => {
  let ctx: TestContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createTestContext();
  });

  it("returns consistent error envelope on forged token", async () => {
    const forgedToken = jwt.sign({ sub: "GSTRUCTTEST1" }, "wrong-secret", { expiresIn: "15m" });

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${forgedToken}`)
      .expect(401);

    expect(response.body).toHaveProperty("success", false);
    expect(response.body).toHaveProperty("error");
    expect(response.body.error).toHaveProperty("message");
    expect(typeof response.body.error.message).toBe("string");
  });

  it("uses the same envelope when no Authorization header is sent", async () => {
    const response = await request(ctx.app).get("/api/v1/auth/me").expect(401);

    expect(response.body).toHaveProperty("success", false);
    expect(response.body).toHaveProperty("error");
    expect(response.body.error).toHaveProperty("message");
  });

  it("always answers 401 (never 403 or 500) across a sample of invalid tokens", async () => {
    const tokens = [
      jwt.sign({ sub: "GUSER1" }, "wrong-secret", { expiresIn: "15m" }),
      jwt.sign({ sub: "GUSER1" }, VALID_JWT_SECRET, { expiresIn: "-1m" }),
      "not-a-jwt",
    ];

    for (const token of tokens) {
      const response = await request(ctx.app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(401);
      expect(response.body.success).toBe(false);
    }
  });

  it("never leaks the raw token value in the error response body", async () => {
    const secret = "leak-test-secret";
    const sensitiveToken = jwt.sign({ sub: "GLEAKTEST" }, secret, { expiresIn: "15m" });

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${sensitiveToken}`)
      .expect(401);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(sensitiveToken);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Token timing edge cases
// ══════════════════════════════════════════════════════════════════════════════

describe("JWT validation: token timing edge cases", () => {
  let ctx: TestContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createTestContext();
  });

  it("rejects a token with nbf set far in the future", async () => {
    const futureToken = signedToken(
      { sub: "GFUTURETOKEN", stellarAddress: "GFUTURETOKEN", userId: crypto.randomUUID() },
      { expiresIn: "15m", notBefore: "1h" }
    );

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${futureToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: "Invalid or expired token." },
    });
  });

  it("rejects a structurally valid long-lived token for an unregistered user", async () => {
    const validToken = signedToken(
      { sub: UNREGISTERED_ADDRESS, stellarAddress: UNREGISTERED_ADDRESS, userId: crypto.randomUUID() },
      { expiresIn: "365d" }
    );

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${validToken}`)
      .expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("Invalid or expired token.") },
    });
  });

  it("accepts a long-lived token when the user IS registered", async () => {
    const stellarAddress = "GLONGLIVEDUSER0000000000000000000000000000000000000000000";
    const userId = crypto.randomUUID();
    await ctx.userRepo.seed({ id: userId, stellarAddress });

    const token = signedToken(
      { sub: stellarAddress, stellarAddress, userId },
      { expiresIn: "365d" }
    );

    const response = await request(ctx.app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(response.body).toMatchObject({ user: { stellarAddress } });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Concurrent request validation
// ══════════════════════════════════════════════════════════════════════════════

describe("JWT validation: concurrent requests", () => {
  let ctx: TestContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = createTestContext();
  });

  it("handles multiple simultaneous invalid token requests without cross-contamination", async () => {
    const tokens = Array.from({ length: 5 }, (_, i) =>
      jwt.sign({ sub: `GCONCURRENT${i}` }, "wrong-secret-" + i, { expiresIn: "15m" })
    );

    const responses = await Promise.all(
      tokens.map((token) =>
        request(ctx.app)
          .get("/api/v1/auth/me")
          .set("Authorization", `Bearer ${token}`)
      )
    );

    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject(AUTH_ERROR_ENVELOPE);
    }
  });

  it("handles mix of valid and invalid tokens concurrently without bleed-over", async () => {
    const stellarAddress = "GCONCURRENTVALID000000000000000000000000000000000000000";
    const userId = crypto.randomUUID();
    await ctx.userRepo.seed({ id: userId, stellarAddress });

    const validToken = signedToken({ sub: stellarAddress, stellarAddress, userId });
    const invalidToken = jwt.sign({ sub: "GBAD" }, "bad-secret", { expiresIn: "15m" });

    const [validResponse, invalidResponse] = await Promise.all([
      request(ctx.app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${validToken}`),
      request(ctx.app)
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${invalidToken}`),
    ]);

    expect(validResponse.status).toBe(200);
    expect(validResponse.body).toMatchObject({ user: { stellarAddress } });

    expect(invalidResponse.status).toBe(401);
    expect(invalidResponse.body).toMatchObject(AUTH_ERROR_ENVELOPE);
  });
});
