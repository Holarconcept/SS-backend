import crypto from "crypto";
import { Keypair, Networks } from "stellar-sdk";
import { AuthService } from "@/services/auth.service";
import type {
  ChallengeRepositoryContract,
  UserRepositoryContract,
} from "@/services/auth.service";
import type { AppLogger, LogMetadata } from "@/observability/logger";
import { KYCStatus, UserType } from "@/types/enums";
import { User } from "@/models/User.model";

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

type InMemoryUser = User;

class InMemoryUserRepository implements UserRepositoryContract {
  private readonly users = new Map<string, InMemoryUser>();

  async findById(id: string) {
    return this.users.get(id) ?? null;
  }

  async findByStellarAddress(stellarAddress: string) {
    return (
      [...this.users.values()].find((u) => u.stellarAddress === stellarAddress) ?? null
    );
  }

  async findByEmail(email: string) {
    return (
      [...this.users.values()].find((u) => u.email === email) ?? null
    );
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
  public saveCount = 0;

  async create(input: InMemoryChallenge): Promise<InMemoryChallenge> {
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
        (c) => c.stellarAddress === stellarAddress && c.nonceHash === nonceHash,
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

interface TestHarness {
  service: AuthService;
  userRepository: InMemoryUserRepository;
  challengeRepository: InMemoryChallengeRepository;
  logger: CaptureLogger;
}

function createHarness(overrides: Partial<{ now: () => number }> = {}): TestHarness {
  const userRepository = new InMemoryUserRepository();
  const challengeRepository = new InMemoryChallengeRepository();
  const logger = new CaptureLogger();
  const service = new AuthService({
    userRepository,
    challengeRepository,
    config: {
      jwt: { secret: "test-secret-hardening", expiresIn: "15m" },
      auth: { challengeTtlMs: 60_000 },
      stellar: { network: "testnet", networkPassphrase: Networks.TESTNET },
    },
    logger,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
  return { service, userRepository, challengeRepository, logger };
}

async function completeAuthFlow(
  service: AuthService,
  keypair: Keypair,
  logger?: CaptureLogger,
): Promise<{ token: string; user: { stellarAddress: string } }> {
  const challenge = await service.createChallenge(keypair.publicKey());
  const signature = keypair.sign(Buffer.from(challenge.message, "utf8")).toString("base64");
  const verified = await service.verifyChallenge({
    publicKey: keypair.publicKey(),
    nonce: challenge.nonce,
    signature,
    ipAddress: "198.51.100.7",
  });
  // Mark logger as used so the parameter stays in the signature for future
  // debugging hookups without triggering an unused-var lint error.
  void logger;
  return verified;
}

describe("AuthService - hardening", () => {
  describe("createChallenge input sanitization", () => {
    it("rejects non-string publicKey without throwing a TypeError", async () => {
      const { service, logger } = createHarness();
      // Casting via `any` is intentional: we are exercising the runtime safety
      // net that catches non-string input before it reaches `assertValidPublicKey`.
      const unsafe = service as unknown as { createChallenge(input: unknown): Promise<unknown> };
      await expect(unsafe.createChallenge(undefined)).rejects.toMatchObject({
        statusCode: 400,
        message: "Invalid Stellar public key.",
      });
      const invalidKeyLogs = logger.entries.filter((e) => e.message === "auth.invalid_public_key");
      expect(invalidKeyLogs.length).toBeGreaterThan(0);
    });

    it("rejects non-string publicKey even when it's an empty string after coercion", async () => {
      const { service } = createHarness();
      const unsafe = service as unknown as { createChallenge(input: unknown): Promise<unknown> };
      await expect(unsafe.createChallenge(123)).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("trims surrounding whitespace before validation", async () => {
      const { service, challengeRepository } = createHarness();
      const keypair = Keypair.random();
      const challenge = await service.createChallenge(`  ${keypair.publicKey()}  `);
      expect(challenge.publicKey).toBe(keypair.publicKey());
      expect(challenge.publicKey).not.toMatch(/^\s|\s$/);
      const stored = [...challengeRepository.challenges.values()][0];
      expect(stored.stellarAddress).toBe(keypair.publicKey());
    });
  });

  describe("createChallenge structured logging", () => {
    it("emits an auth.challenge_created info log on success", async () => {
      const { service, logger } = createHarness();
      const keypair = Keypair.random();
      await service.createChallenge(keypair.publicKey());

      const createdLog = logger.entries.find(
        (e) => e.level === "info" && e.message === "auth.challenge_created",
      );
      expect(createdLog).toBeDefined();
      expect(createdLog!.metadata.wallet).toBe(keypair.publicKey());
      expect(createdLog!.metadata.network).toBe("testnet");
      expect(typeof createdLog!.metadata.issued_at).toBe("string");
      expect(typeof createdLog!.metadata.expires_at).toBe("string");
    });
  });

  describe("verifyChallenge structured logging", () => {
    it("emits an auth.user_upserted info log on first-time login", async () => {
      const { service, logger } = createHarness();
      const keypair = Keypair.random();
      await completeAuthFlow(service, keypair, logger);
      const upsertLog = logger.entries.find(
        (e) => e.level === "info" && e.message === "auth.user_upserted",
      );
      expect(upsertLog).toBeDefined();
      expect(upsertLog!.metadata.wallet).toBe(keypair.publicKey());
    });

    it("does NOT emit auth.user_upserted on repeat login for an existing user", async () => {
      const { service, logger } = createHarness();
      const keypair = Keypair.random();
      await completeAuthFlow(service, keypair, logger);
      const upsertCountAfterFirst = logger.entries.filter(
        (e) => e.message === "auth.user_upserted",
      ).length;
      expect(upsertCountAfterFirst).toBe(1);

      await completeAuthFlow(service, keypair, logger);
      const upsertCountAfterSecond = logger.entries.filter(
        (e) => e.message === "auth.user_upserted",
      ).length;
      expect(upsertCountAfterSecond).toBe(1);
    });

    it("emits auth.verify_failed with a truncated wallet on bad signature", async () => {
      const { service, logger } = createHarness();
      const keypair = Keypair.random();
      await service.createChallenge(keypair.publicKey());

      await expect(
        service.verifyChallenge({
          publicKey: keypair.publicKey(),
          nonce: "a".repeat(32),
          signature: "aW52YWxpZA==",
        }),
      ).rejects.toMatchObject({ statusCode: 401 });

      const failed = logger.entries.find(
        (e) => e.level === "info" && e.message === "auth.verify_failed",
      );
      expect(failed).toBeDefined();
      expect(failed!.metadata.wallet).toMatch(/^.{4}\.{3}.{4}$/);
    });

    it("never logs the raw signature or nonce on failure paths", async () => {
      const { service, logger } = createHarness();
      const keypair = Keypair.random();
      await service.createChallenge(keypair.publicKey());

      const rawNonce = "abcdef0123456789abcdef0123456789";
      const rawSignature = "aW52YWxpZA==";

      await expect(
        service.verifyChallenge({
          publicKey: keypair.publicKey(),
          nonce: rawNonce,
          signature: rawSignature,
        }),
      ).rejects.toBeDefined();

      for (const entry of logger.entries) {
        const serialized = JSON.stringify(entry);
        expect(serialized).not.toContain(rawSignature);
        expect(serialized).not.toContain(rawNonce);
      }
    });
  });

  describe("verifyChallenge single-flight user upsert", () => {
    it("coalesces concurrent first-time logins for the same wallet into a single repository save", async () => {
      const { service, userRepository, challengeRepository } = createHarness();

      // Pre-create two distinct challenges so both verify paths run.
      const keypair = Keypair.random();
      const [c1, c2] = await Promise.all([
        service.createChallenge(keypair.publicKey()),
        service.createChallenge(keypair.publicKey()),
      ]);

      const sig1 = keypair.sign(Buffer.from(c1.message, "utf8")).toString("base64");
      const sig2 = keypair.sign(Buffer.from(c2.message, "utf8")).toString("base64");

      const [r1, r2] = await Promise.all([
        service.verifyChallenge({ publicKey: keypair.publicKey(), nonce: c1.nonce, signature: sig1 }),
        service.verifyChallenge({ publicKey: keypair.publicKey(), nonce: c2.nonce, signature: sig2 }),
      ]);

      // Both calls succeed (different challenges).
      expect(r1.token).toBeDefined();
      expect(r2.token).toBeDefined();

      // Only one user row exists in the repository (single-flight coalesced
      // the two upserts onto a single `save` call).
      const users = [...userRepository["users"].values()] as User[];
      expect(users).toHaveLength(1);
      expect(users[0].stellarAddress).toBe(keypair.publicKey());

      // Both challenges were consumed.
      const consumed = [...challengeRepository.challenges.values()].filter(
        (c) => c.consumedAt !== null,
      );
      expect(consumed).toHaveLength(2);
    });
  });

  describe("verifyChallenge input sanitization", () => {
    it("rejects non-string publicKey, nonce, and signature", async () => {
      const { service } = createHarness();
      const keypair = Keypair.random();
      const unsafe = service as unknown as {
        verifyChallenge(input: { publicKey: unknown; nonce: unknown; signature: unknown }): Promise<unknown>;
      };

      await expect(
        unsafe.verifyChallenge({ publicKey: null, nonce: "a".repeat(32), signature: "sig" }),
      ).rejects.toMatchObject({ statusCode: 400 });

      await expect(
        unsafe.verifyChallenge({ publicKey: keypair.publicKey(), nonce: undefined, signature: "sig" }),
      ).rejects.toMatchObject({ statusCode: 400 });

      await expect(
        unsafe.verifyChallenge({ publicKey: keypair.publicKey(), nonce: "a".repeat(32), signature: undefined }),
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe("getCurrentUser hardening", () => {
    it("rejects a non-string token without throwing a TypeError", async () => {
      const { service } = createHarness();
      const unsafe = service as unknown as { getCurrentUser(input: unknown): Promise<unknown> };
      await expect(unsafe.getCurrentUser(undefined)).rejects.toMatchObject({ statusCode: 401 });
      await expect(unsafe.getCurrentUser(null)).rejects.toMatchObject({ statusCode: 401 });
      await expect(unsafe.getCurrentUser(123)).rejects.toMatchObject({ statusCode: 401 });
    });

    it("wraps unexpected errors in HttpError(500) without leaking internals", async () => {
      const { service, userRepository } = createHarness();
      const keypair = Keypair.random();
      // Sign a token with the same secret the service uses.
      const crypto = await import("crypto");
      const jwt = await import("jsonwebtoken");
      const token = jwt.default.sign(
        { sub: keypair.publicKey() },
        "test-secret-hardening",
        { expiresIn: "1h" },
      );

      const original = userRepository.findByStellarAddress.bind(userRepository);
      userRepository.findByStellarAddress = async () => {
        throw new Error(`internal db boom ${crypto.randomUUID()}`);
      };
      try {
        await expect(service.getCurrentUser(token)).rejects.toMatchObject({ statusCode: 500 });
      } finally {
        userRepository.findByStellarAddress = original;
      }
    });
  });
});
