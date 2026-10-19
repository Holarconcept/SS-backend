import crypto from "crypto";
import request from "supertest";
import { Keypair, Networks } from "stellar-sdk";
import { createApp } from "../src/app";
import { User } from "../src/models/User.model";
import { AuthService } from "../src/services/auth.service";
import type {
  ChallengeRepositoryContract,
  UserRepositoryContract,
} from "../src/services/auth.service";
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
    return [...this.users.values()].find((user) => user.stellarAddress === stellarAddress) ?? null;
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
        (challenge) =>
          challenge.stellarAddress === stellarAddress && challenge.nonceHash === nonceHash
      ) ?? null
    );
  }

  async consume(id: string, consumedAt: Date) {
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

function createTestServer(challengeTtlMs = 60_000) {
  const userRepository = new InMemoryUserRepository();
  const challengeRepository = new InMemoryChallengeRepository();
  const authService = new AuthService({
    userRepository,
    challengeRepository,
    config: {
      jwt: {
        secret: "test-secret",
        expiresIn: "15m",
      },
      auth: {
        challengeTtlMs,
      },
      stellar: {
        network: "testnet",
        networkPassphrase: Networks.TESTNET,
      },
    },
  });

  return {
    app: createApp({ authService }),
    challengeRepository,
  };
}

afterEach(() => {
  jest.useRealTimers();
});

describe("Auth routes", () => {
  it("creates unique challenges with a minimum length", async () => {
    const { app } = createTestServer();
    const keypair = Keypair.random();

    const firstResponse = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    const secondResponse = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    expect(firstResponse.body.challenge.nonce).not.toBe(secondResponse.body.challenge.nonce);
    expect(firstResponse.body.challenge.nonce).toHaveLength(64);
    expect(secondResponse.body.challenge.nonce).toHaveLength(64);
    expect(firstResponse.body.challenge.nonce.length).toBeGreaterThanOrEqual(32);
    expect(secondResponse.body.challenge.nonce.length).toBeGreaterThanOrEqual(32);
  });

  it("accepts a fresh challenge and rejects it after the TTL expires", async () => {
    jest.useFakeTimers();
    const issuedAt = new Date("2026-07-28T00:00:00.000Z");
    jest.setSystemTime(issuedAt);

    const { app } = createTestServer(1_000);
    const keypair = Keypair.random();

    const challengeResponse = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    const { nonce, message } = challengeResponse.body.challenge;
    const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature,
      })
      .expect(200);

    jest.setSystemTime(new Date(issuedAt.getTime() + 1_001));

    const expiredChallengeResponse = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    const expiredSignature = keypair
      .sign(Buffer.from(expiredChallengeResponse.body.challenge.message, "utf8"))
      .toString("base64");

    jest.setSystemTime(new Date(issuedAt.getTime() + 2_002));

    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce: expiredChallengeResponse.body.challenge.nonce,
        signature: expiredSignature,
      })
      .expect(401);
  });

  it("creates a JWT session and resolves /me for a valid Stellar signature", async () => {
    const { app } = createTestServer();
    const keypair = Keypair.random();

    const challengeResponse = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    const { nonce, message, network } = challengeResponse.body.challenge;

    expect(nonce).toEqual(expect.any(String));
    expect(message).toContain(keypair.publicKey());
    expect(network).toBe("testnet");

    const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    const verifyResponse = await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature,
      })
      .expect(200);

    expect(verifyResponse.body.token).toEqual(expect.any(String));
    expect(verifyResponse.body.user.stellarAddress).toBe(keypair.publicKey());
    expect(verifyResponse.body.expiresIn).toBe("15m");

    const meResponse = await request(app)
      .get("/api/v1/auth/me")
      .set("Authorization", `Bearer ${verifyResponse.body.token}`)
      .expect(200);

    expect(meResponse.body.user.stellarAddress).toBe(keypair.publicKey());
  });

  it("rejects invalid signatures and reused nonces", async () => {
    const { app, challengeRepository } = createTestServer();
    const keypair = Keypair.random();

    const challengeResponse = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    const { nonce, message } = challengeResponse.body.challenge;
    const validSignature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature: "not-a-valid-signature",
      })
      .expect(401);

    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature: validSignature,
      })
      .expect(200);

    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature: validSignature,
      })
      .expect(401);

    expect(
      [...challengeRepository.challenges.values()].some(
        (challenge) => challenge.consumedAt !== null
      )
    ).toBe(true);
  });

  it("returns 401 rather than crashing when the signature is the wrong byte length", async () => {
    const { app } = createTestServer();
    const keypair = Keypair.random();

    const challengeResponse = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    const { nonce } = challengeResponse.body.challenge;

    // Valid hex encoding, but far short of the 64 raw bytes a real Ed25519
    // signature decodes to — the underlying verify call throws for this
    // rather than returning false.
    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce,
        signature: "00",
      })
      .expect(401);
  });

  it("rate limits repeated /challenge attempts from the same caller", async () => {
    const { app } = createTestServer();
    const keypair = Keypair.random();

    // The auth rate limiter (createAuthRateLimitMiddleware) allows 10
    // requests per window; it previously existed but was never wired into
    // any router, so /challenge and /verify had no abuse protection at all.
    for (let i = 0; i < 10; i += 1) {
      await request(app)
        .post("/api/v1/auth/challenge")
        .send({ publicKey: keypair.publicKey() })
        .expect(201);
    }

    await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(429);
  });

  it("returns 401 from /me when the bearer token is missing", async () => {
    const { app } = createTestServer();

    const response = await request(app).get("/api/v1/auth/me").expect(401);

    expect(response.body).toMatchObject({
      success: false,
      error: {
        message: "Authorization token is required.",
      },
    });
  });
});
