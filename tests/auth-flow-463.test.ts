import crypto from "crypto";
import jwt from "jsonwebtoken";
import request from "supertest";
import { Keypair, Networks } from "stellar-sdk";
import { createApp } from "../src/app";
import { AuthService } from "../src/services/auth.service";
import type {
  ChallengeRepositoryContract,
  UserRepositoryContract,
} from "../src/services/auth.service";
import { User } from "../src/models/User.model";
import { KYCStatus, UserType } from "../src/types/enums";

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
    return [...this.users.values()].find((u) => u.stellarAddress === stellarAddress) ?? null;
  }

  async findByEmail(email: string) {
    return [...this.users.values()].find((u) => u.email === email) ?? null;
  }

  async findAll(options?: {
    skip?: number;
    take?: number;
    cursor?: string;
    order?: "ASC" | "DESC";
  }): Promise<InMemoryUser[]> {
    let results = [...this.users.values()].filter((u) => !u.deletedAt);
    if (options?.cursor) {
      const cursorIndex = results.findIndex((u) => u.id === options.cursor);
      if (cursorIndex >= 0) {
        results = results.slice(cursorIndex + 1);
      }
    }
    if (options?.skip) {
      results = results.slice(options.skip);
    }
    if (options?.take) {
      results = results.slice(0, options.take);
    }
    return results;
  }

  async count(options?: { cursor?: string }): Promise<number> {
    let results = [...this.users.values()].filter((u) => !u.deletedAt);
    if (options?.cursor) {
      const cursorIndex = results.findIndex((u) => u.id === options.cursor);
      if (cursorIndex >= 0) {
        results = results.slice(0, cursorIndex);
      }
    }
    return results.length;
  }

  async save(user: Partial<InMemoryUser>): Promise<InMemoryUser> {
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
}

class InMemoryChallengeRepository implements ChallengeRepositoryContract {
  readonly challenges = new Map<string, InMemoryChallenge>();

  async create(input: {
    stellarAddress: string;
    nonceHash: string;
    message: string;
    network: string;
    issuedAt: Date;
    expiresAt: Date;
  }) {
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

  async consume(id: string, consumedAt: Date): Promise<boolean> {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.consumedAt) {
      return false;
    }
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

const TEST_SECRET = "test-secret-key-32-bytes-long!";

function createTestHarness(options: {
  clockNow?: number;
  serverKeypair?: Keypair;
  challengeTtlMs?: number;
  jwtSecret?: string;
  jwtPublicKey?: string;
} = {}) {
  let currentTime = options.clockNow ?? Date.now();
  const userRepository = new InMemoryUserRepository();
  const challengeRepository = new InMemoryChallengeRepository();

  const authService = new AuthService({
    userRepository,
    challengeRepository,
    config: {
      jwt: {
        secret: options.jwtSecret ?? TEST_SECRET,
        publicKey: options.jwtPublicKey,
        expiresIn: "1h",
      },
      auth: {
        challengeTtlMs: options.challengeTtlMs ?? 60_000,
      },
      stellar: {
        network: "testnet",
        networkPassphrase: Networks.TESTNET,
      },
      serverKeypair: options.serverKeypair,
    },
    now: () => currentTime,
  });

  const app = createApp({ authService });

  return {
    app,
    authService,
    userRepository,
    challengeRepository,
    advanceTime: (ms: number) => {
      currentTime += ms;
    },
    getTime: () => currentTime,
  };
}

describe("Issue #463: Stellar wallet challenge signing JWT auth flow", () => {
  it("GET /auth/challenge returns a unique challenge for a given public key with 60-second expiry", async () => {
    const { app } = createTestHarness();
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();

    const res = await request(app)
      .get(`/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    const challenge = res.body.challenge ?? res.body;
    expect(challenge.publicKey).toBe(publicKey);
    expect(challenge.nonce).toBeDefined();
    expect(typeof challenge.nonce).toBe("string");
    expect(challenge.message).toBeDefined();
    expect(challenge.network).toBe("testnet");

    // Verify 60-second expiration window
    const issuedAt = new Date(challenge.issuedAt).getTime();
    const expiresAt = new Date(challenge.expiresAt).getTime();
    expect(expiresAt - issuedAt).toBe(60_000);

    // Calling again returns a different unique challenge
    const res2 = await request(app)
      .get(`/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    const challenge2 = res2.body.challenge ?? res2.body;
    expect(challenge2.nonce).not.toBe(challenge.nonce);
    expect(challenge2.message).not.toBe(challenge.message);
  });

  it("GET /api/v1/auth/challenge alias returns challenge with 200", async () => {
    const { app } = createTestHarness();
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();

    const res = await request(app)
      .get(`/api/v1/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    expect(res.body.publicKey || res.body.challenge?.publicKey).toBe(publicKey);
  });

  it("POST /auth/challenge still works and returns 201", async () => {
    const { app } = createTestHarness();
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();

    const res = await request(app)
      .post("/auth/challenge")
      .send({ publicKey })
      .expect(201);

    expect(res.body.challenge?.publicKey).toBe(publicKey);
  });

  it("returns 400 when publicKey is missing or invalid on GET /auth/challenge", async () => {
    const { app } = createTestHarness();

    await request(app)
      .get("/auth/challenge")
      .expect(400);

    await request(app)
      .get("/auth/challenge?publicKey=invalid-key")
      .expect(400);
  });

  it("completes full flow: challenge -> sign -> POST /auth/verify -> returns signed JWT with wallet address and expiry", async () => {
    const { app } = createTestHarness();
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();

    // 1. Get challenge
    const challengeRes = await request(app)
      .get(`/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    const challenge = challengeRes.body.challenge ?? challengeRes.body;
    const { nonce, message } = challenge;

    // 2. Sign challenge message with wallet keypair
    const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    // 3. Verify signed challenge
    const verifyRes = await request(app)
      .post("/auth/verify")
      .send({
        publicKey,
        nonce,
        signature,
      })
      .expect(200);

    expect(verifyRes.body.token).toBeDefined();
    expect(verifyRes.body.tokenType).toBe("Bearer");
    expect(verifyRes.body.user).toBeDefined();
    expect(verifyRes.body.user.stellarAddress).toBe(publicKey);

    // 4. Inspect JWT payload
    const token = verifyRes.body.token;
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded).not.toBeNull();
    expect(decoded.sub).toBe(publicKey);
    expect(decoded.stellarAddress).toBe(publicKey);
    expect(decoded.walletAddress).toBe(publicKey);
    expect(decoded.exp).toBeDefined();
    expect(typeof decoded.exp).toBe("number");

    // 5. Verify token with server secret
    const verified = jwt.verify(token, TEST_SECRET) as jwt.JwtPayload;
    expect(verified.sub).toBe(publicKey);
    expect(verified.walletAddress).toBe(publicKey);

    // 6. Access protected endpoint with issued JWT
    const meRes = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(meRes.body.user.stellarAddress).toBe(publicKey);
  });

  it("POST /api/v1/auth/verify alias works identically", async () => {
    const { app } = createTestHarness();
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();

    const challengeRes = await request(app)
      .get(`/api/v1/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    const challenge = challengeRes.body.challenge ?? challengeRes.body;
    const signature = keypair.sign(Buffer.from(challenge.message, "utf8")).toString("base64");

    const verifyRes = await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey,
        nonce: challenge.nonce,
        signature,
      })
      .expect(200);

    expect(verifyRes.body.token).toBeDefined();
  });

  it("rejects challenge verification when challenge is expired (>60 seconds)", async () => {
    const { app, advanceTime } = createTestHarness();
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();

    const challengeRes = await request(app)
      .get(`/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    const challenge = challengeRes.body.challenge ?? challengeRes.body;
    const signature = keypair.sign(Buffer.from(challenge.message, "utf8")).toString("base64");

    // Advance clock past 60s expiration window (e.g. 61 seconds)
    advanceTime(61_000);

    const verifyRes = await request(app)
      .post("/auth/verify")
      .send({
        publicKey,
        nonce: challenge.nonce,
        signature,
      })
      .expect(401);

    expect(verifyRes.body.error.message).toMatch(/expired/i);
  });

  it("rejects invalid signature with 401", async () => {
    const { app } = createTestHarness();
    const keypair = Keypair.random();
    const otherKeypair = Keypair.random();
    const publicKey = keypair.publicKey();

    const challengeRes = await request(app)
      .get(`/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    const challenge = challengeRes.body.challenge ?? challengeRes.body;

    // Sign with WRONG keypair
    const wrongSignature = otherKeypair.sign(Buffer.from(challenge.message, "utf8")).toString("base64");

    await request(app)
      .post("/auth/verify")
      .send({
        publicKey,
        nonce: challenge.nonce,
        signature: wrongSignature,
      })
      .expect(401);

    // Corrupted signature bytes
    const corruptSignature = Buffer.alloc(64, 0xaa).toString("base64");
    await request(app)
      .post("/auth/verify")
      .send({
        publicKey,
        nonce: challenge.nonce,
        signature: corruptSignature,
      })
      .expect(401);

    // Malformed signature string
    await request(app)
      .post("/auth/verify")
      .send({
        publicKey,
        nonce: challenge.nonce,
        signature: "invalid!@#$not-valid",
      })
      .expect(401);
  });

  it("rejects replaying a consumed challenge (one-time use)", async () => {
    const { app } = createTestHarness();
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();

    const challengeRes = await request(app)
      .get(`/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    const challenge = challengeRes.body.challenge ?? challengeRes.body;
    const signature = keypair.sign(Buffer.from(challenge.message, "utf8")).toString("base64");

    // First verify succeeds
    await request(app)
      .post("/auth/verify")
      .send({
        publicKey,
        nonce: challenge.nonce,
        signature,
      })
      .expect(200);

    // Replay should fail with 401
    const replayRes = await request(app)
      .post("/auth/verify")
      .send({
        publicKey,
        nonce: challenge.nonce,
        signature,
      })
      .expect(401);

    expect(replayRes.body.error.message).toMatch(/already used/i);
  });

  it("returns signed transaction challenge when serverKeypair is configured", async () => {
    const serverKeypair = Keypair.random();
    const { app } = createTestHarness({ serverKeypair });
    const walletKeypair = Keypair.random();
    const publicKey = walletKeypair.publicKey();

    const res = await request(app)
      .get(`/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    const challenge = res.body.challenge ?? res.body;
    expect(challenge.transaction).toBeDefined();
    expect(typeof challenge.transaction).toBe("string");
  });

  it("verifies JWT with asymmetric RSA keypair if configured", async () => {
    const { publicKey: rsaPublicKey, privateKey: rsaPrivateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    const { app, authService } = createTestHarness({
      jwtSecret: rsaPrivateKey,
      jwtPublicKey: rsaPublicKey,
    });

    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();

    const challengeRes = await request(app)
      .get(`/auth/challenge?publicKey=${publicKey}`)
      .expect(200);

    const challenge = challengeRes.body.challenge ?? challengeRes.body;
    const signature = keypair.sign(Buffer.from(challenge.message, "utf8")).toString("base64");

    const verifyRes = await request(app)
      .post("/auth/verify")
      .send({
        publicKey,
        nonce: challenge.nonce,
        signature,
      })
      .expect(200);

    const token = verifyRes.body.token;

    // Verify token using server's RSA public key directly
    const verified = jwt.verify(token, rsaPublicKey) as jwt.JwtPayload;
    expect(verified.sub).toBe(publicKey);
    expect(verified.walletAddress).toBe(publicKey);

    // Verify token using authService helper
    const serviceVerified = authService.verifyToken(token, rsaPublicKey);
    expect(serviceVerified.sub).toBe(publicKey);

    // Access protected endpoint with RSA-signed token
    const meRes = await request(app)
      .get("/auth/me")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    expect(meRes.body.user.stellarAddress).toBe(publicKey);
  });
});
