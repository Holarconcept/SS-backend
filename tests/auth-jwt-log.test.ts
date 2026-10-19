import crypto from "crypto";
import request from "supertest";
import { Keypair, Networks } from "stellar-sdk";
import { createApp } from "../src/app";
import { AuthService } from "../src/services/auth.service";
import type {
  ChallengeRepositoryContract,
  UserRepositoryContract,
} from "../src/services/auth.service";
import type { AppLogger, LogMetadata } from "../src/observability/logger";
import { KYCStatus, UserType } from "../src/types/enums";
import { User } from "../src/models/User.model";

// ── In-memory repositories ──

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
      ...input,
      id: crypto.randomUUID(),
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

// ── CaptureLogger ──

interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  metadata: LogMetadata;
}

class CaptureLogger implements AppLogger {
  constructor(readonly entries: LogEntry[] = []) {}

  debug(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "debug", message, metadata });
  }
  info(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "info", message, metadata });
  }
  warn(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "warn", message, metadata });
  }
  error(message: string, metadata: LogMetadata = {}): void {
    this.entries.push({ level: "error", message, metadata });
  }
  child(_metadata: LogMetadata): AppLogger {
    return new CaptureLogger(this.entries);
  }
}

// ── Test factory ──

function createTestServer(logger?: AppLogger) {
  const userRepository = new InMemoryUserRepository();
  const challengeRepository = new InMemoryChallengeRepository();
  const authService = new AuthService({
    userRepository,
    challengeRepository,
    config: {
      jwt: { secret: "test-secret-jwt-log", expiresIn: "15m" },
      auth: { challengeTtlMs: 60_000 },
      stellar: { network: "testnet", networkPassphrase: Networks.TESTNET },
    },
    logger,
  });

  return {
    app: createApp({ authService, logger }),
    challengeRepository,
  };
}

async function completeAuthFlow(
  app: ReturnType<typeof createApp>,
  keypair: Keypair,
  extraHeaders: Record<string, string> = {}
) {
  const challengeRes = await request(app)
    .post("/api/v1/auth/challenge")
    .send({ publicKey: keypair.publicKey() })
    .expect(201);

  const { nonce, message } = challengeRes.body.challenge;
  const signature = keypair.sign(Buffer.from(message, "utf8")).toString("base64");

  return request(app)
    .post("/api/v1/auth/verify")
    .set(extraHeaders)
    .send({ publicKey: keypair.publicKey(), nonce, signature });
}

// ── Tests ──

describe("JWT issuance structured log (issue #111)", () => {
  it("emits an info log with all four required fields on successful issuance", async () => {
    const captureLogger = new CaptureLogger();
    const { app } = createTestServer(captureLogger);
    const keypair = Keypair.random();

    const res = await completeAuthFlow(app, keypair);
    expect(res.status).toBe(200);

    const jwtLog = captureLogger.entries.find(
      (e) => e.level === "info" && e.message === "jwt.issued"
    );

    expect(jwtLog).toBeDefined();
    expect(jwtLog!.metadata.wallet).toBe(keypair.publicKey());
    expect(typeof jwtLog!.metadata.issued_at).toBe("string");
    expect(typeof jwtLog!.metadata.expires_at).toBe("string");
    expect("ip_address" in jwtLog!.metadata).toBe(true);
  });

  it("records the full Stellar address without truncation", async () => {
    const captureLogger = new CaptureLogger();
    const { app } = createTestServer(captureLogger);
    const keypair = Keypair.random();

    await completeAuthFlow(app, keypair);

    const jwtLog = captureLogger.entries.find((e) => e.message === "jwt.issued");
    expect(jwtLog!.metadata.wallet).toBe(keypair.publicKey());
    // Stellar addresses are 56 chars; ensure it's not been truncated
    expect((jwtLog!.metadata.wallet as string).length).toBe(56);
  });

  it("resolves ip_address from X-Forwarded-For when present", async () => {
    const captureLogger = new CaptureLogger();
    const { app } = createTestServer(captureLogger);
    const keypair = Keypair.random();

    await completeAuthFlow(app, keypair, { "X-Forwarded-For": "203.0.113.42, 10.0.0.1" });

    const jwtLog = captureLogger.entries.find((e) => e.message === "jwt.issued");
    expect(jwtLog!.metadata.ip_address).toBe("203.0.113.42");
  });

  it("does NOT emit jwt.issued when authentication fails (bad signature)", async () => {
    const captureLogger = new CaptureLogger();
    const { app } = createTestServer(captureLogger);
    const keypair = Keypair.random();

    const challengeRes = await request(app)
      .post("/api/v1/auth/challenge")
      .send({ publicKey: keypair.publicKey() })
      .expect(201);

    await request(app)
      .post("/api/v1/auth/verify")
      .send({
        publicKey: keypair.publicKey(),
        nonce: challengeRes.body.challenge.nonce,
        signature: "aW52YWxpZA==", // invalid signature
      })
      .expect(401);

    const jwtLogs = captureLogger.entries.filter((e) => e.message === "jwt.issued");
    expect(jwtLogs).toHaveLength(0);
  });
});
