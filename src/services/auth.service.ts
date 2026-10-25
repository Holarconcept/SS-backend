import crypto from "crypto";
import jwt, { JwtPayload, type SignOptions } from "jsonwebtoken";
import { DataSource, IsNull, Repository } from "typeorm";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import type { AppConfig } from "../config/env";
import { AuthChallenge } from "../models/AuthChallenge.model";
import { User, USER_PROFILE_SELECT } from "../models/User.model";
import type { PublicUser } from "../types/auth";
import { AppError, HttpError } from "../utils/http-error";
import { buildAuthFailureDetails, classifyJwtError } from "../lib/auth-failure";
import type { AppLogger } from "../observability/logger";
import { buildWalletChallenge } from "../utils/stellar-challenge";
import { MetricsRegistry } from "../observability/metrics";

interface ChallengeRecord {
  id: string;
  stellarAddress: string;
  nonceHash: string;
  message: string;
  network: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface CreateChallengeRecordInput {
  stellarAddress: string;
  nonceHash: string;
  message: string;
  network: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface UserRepositoryContract {
  findById(id: string): Promise<User | null>;
  findByStellarAddress(stellarAddress: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findAll(options?: {
    skip?: number;
    take?: number;
    cursor?: string;
    order?: "ASC" | "DESC";
  }): Promise<User[]>;
  count(options?: { cursor?: string }): Promise<number>;
  save(user: Partial<User>): Promise<User>;
}

export interface ChallengeRepositoryContract {
  create(input: CreateChallengeRecordInput): Promise<ChallengeRecord>;
  findByAddressAndNonceHash(
    stellarAddress: string,
    nonceHash: string
  ): Promise<ChallengeRecord | null>;
  consume(id: string, consumedAt: Date): Promise<boolean>;
  deleteExpired(before: Date): Promise<number>;
  countByStatus(status: "active" | "consumed" | "expired"): Promise<number>;
}

interface AuthTokenPayload extends JwtPayload {
  sub: string;
  stellarAddress: string;
}

export interface AuthConfig extends Pick<AppConfig, "auth" | "stellar"> {
  jwt: AppConfig["jwt"] & { publicKey?: string };
  serverKeypair?: Keypair;
  serverPublicKey?: string;
  /**
   * Optional TTL (ms) for caching public user profile lookups.
   * Defaults to 0 (in-flight coalescing active, no stale cache across distinct turns unless configured).
   */
  userCacheTtlMs?: number;
  /**
   * Optional TTL (ms) for caching challenge status metrics.
   * Defaults to 5,000ms to throttle heavy metrics scraper requests.
   */
  metricsCacheTtlMs?: number;
}

export interface AuthServiceDependencies {
  userRepository: UserRepositoryContract;
  challengeRepository: ChallengeRepositoryContract;
  config: AuthConfig;
  logger?: AppLogger;
  /**
   * Override the clock used for challenge TTL checks. Mostly useful in tests;
   * leave unset in production.
   */
  now?: () => number;
  metrics?: MetricsRegistry;
}

export interface ChallengeResponse {
  publicKey: string;
  nonce: string;
  message: string;
  issuedAt: string;
  expiresAt: string;
  network: string;
  transaction?: string;
}

export interface VerifyChallengeInput {
  publicKey?: string;
  wallet?: string;
  nonce?: string;
  challenge?: string;
  signature: string;
  ipAddress?: string;
}

export interface VerifyChallengeResponse {
  token: string;
  tokenType: "Bearer";
  expiresIn: string;
  user: PublicUser;
}

/** Minimum nonce length (chars) accepted by verifyChallenge. */
const MIN_NONCE_LENGTH = 16;
/** Maximum nonce length (chars) accepted to prevent excessive payload DOS. */
const MAX_NONCE_LENGTH = 512;
/** Maximum signature length (chars) accepted. */
const MAX_SIGNATURE_LENGTH = 2048;
/** Maximum bearer token length to guard against parser CPU exhaustion. */
const MAX_TOKEN_LENGTH = 8192;

/**
 * Lightweight, bounded LRU cache with time-to-live (TTL) expiration.
 * Protects downstream databases from query exhaustion under high concurrent load.
 */
export class LRUCache<K, V> {
  private readonly map = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxSize: number = 1000,
    private readonly defaultTtlMs: number = 10_000
  ) {
    if (maxSize <= 0) {
      throw new Error("LRUCache maxSize must be greater than zero");
    }
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // Refresh LRU order by deleting and re-inserting
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs: number = this.defaultTtlMs): void {
    if (ttlMs <= 0) {
      return;
    }

    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      // Evict least-recently-used entry
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/**
 * Concurrently executes asynchronous tasks with resilient error handling.
 * Employs Promise.all for parallel processing, reducing sequential round-trip latency.
 */
export async function processEfficiently<T>(work: () => Promise<T>): Promise<T>;
export async function processEfficiently<T1, T2>(
  task1: () => Promise<T1>,
  task2: () => Promise<T2>
): Promise<[T1, T2]>;
export async function processEfficiently(...tasks: (() => Promise<unknown>)[]): Promise<unknown> {
  if (tasks.length === 1) {
    return tasks[0]();
  }
  return Promise.all(tasks.map((task) => task()));
}

export class AuthService {
  private readonly userRepository: UserRepositoryContract;
  private readonly challengeRepository: ChallengeRepositoryContract;
  private readonly config: AuthConfig;
  private readonly logger?: AppLogger;
  private readonly serverKeypair?: Keypair;
  private readonly now: () => number;
  private readonly metrics?: MetricsRegistry;

  /**
   * In-process single-flight cache for user upserts keyed by Stellar address.
   * Collapses concurrent `verifyChallenge` flows for the same wallet into a
   * single repository write — preventing the unique-index race where two
   * parallel "first login" attempts both try to `INSERT` the same row.
   */
  private readonly userUpsertInflight = new Map<string, Promise<User>>();

  /**
   * In-process single-flight cache for user lookups keyed by Stellar address.
   * Deduplicates concurrent read requests during peak authentication traffic.
   */
  private readonly userLookupInflight = new Map<string, Promise<User | null>>();

  /**
   * Bounded LRU cache for user profiles to mitigate database contention under heavy load.
   */
  private readonly userCache: LRUCache<string, PublicUser>;

  /**
   * Bounded cache for challenge metrics to prevent DB saturation from repeated metric scraping.
   */
  private readonly metricsCache: LRUCache<
    string,
    { active: number; consumed: number; expired: number }
  >;

  /**
   * In-flight single-flight coalescing for metrics calculation.
   */
  private metricsInflight: Promise<{ active: number; consumed: number; expired: number }> | null =
    null;

  constructor(dependencies: AuthServiceDependencies) {
    this.userRepository = dependencies.userRepository;
    this.challengeRepository = dependencies.challengeRepository;
    this.config = dependencies.config;
    this.logger = dependencies.logger;
    this.serverKeypair = dependencies.config.serverKeypair;
    this.now = dependencies.now ?? (() => Date.now());
    this.metrics = dependencies.metrics;

    const userCacheTtl = dependencies.config.userCacheTtlMs ?? 0;
    this.userCache = new LRUCache<string, PublicUser>(2000, userCacheTtl);

    const metricsCacheTtl = dependencies.config.metricsCacheTtlMs ?? 5_000;
    this.metricsCache = new LRUCache(10, metricsCacheTtl);
  }

  /**
   * Invalidate cached user profile(s). If stellarAddress is provided, clears
   * that entry; otherwise clears the entire user cache.
   */
  invalidateUserCache(stellarAddress?: string): void {
    if (stellarAddress) {
      this.userCache.delete(stellarAddress.trim());
    } else {
      this.userCache.clear();
    }
  }

  private recordChallengeMetric(
    status: "created" | "verified" | "expired" | "failed" | "reused",
    wallet: string
  ): void {
    this.metrics?.increment("auth_challenge_total", { status, wallet: wallet.slice(0, 8) + "..." });
  }

  async createChallenge(publicKey: string): Promise<ChallengeResponse> {
    try {
      const sanitizedKey = this.assertValidPublicKey(publicKey);
      const issuedAt = new Date(this.now());
      const challengeTtlMs =
        typeof this.config.auth?.challengeTtlMs === "number" && this.config.auth.challengeTtlMs > 0
          ? this.config.auth.challengeTtlMs
          : 60_000;
      const expiresAt = new Date(issuedAt.getTime() + challengeTtlMs);

      let nonce: string;
      let transactionXdr: string | undefined;
      if (this.serverKeypair) {
        const walletChallenge = buildWalletChallenge(
          sanitizedKey,
          this.config.stellar.networkPassphrase,
          this.serverKeypair
        );
        nonce = walletChallenge.nonce;
        transactionXdr = walletChallenge.transaction.toXDR();
      } else {
        nonce = crypto.randomBytes(32).toString("hex");
      }

      const message = buildChallengeMessage({
        publicKey: sanitizedKey,
        nonce,
        network: this.config.stellar.network,
        networkPassphrase: this.config.stellar.networkPassphrase,
        issuedAt,
        expiresAt,
      });

      try {
        await this.challengeRepository.create({
          stellarAddress: sanitizedKey,
          nonceHash: hashNonce(nonce),
          message,
          network: this.config.stellar.network,
          issuedAt,
          expiresAt,
        });
        this.recordChallengeMetric("created", sanitizedKey);
      } catch (error) {
        this.logger?.error("Failed to persist challenge", {
          error: error instanceof Error ? error.message : String(error),
          stellarAddress: sanitizedKey,
        });
        throw new HttpError(500, "Failed to create challenge.");
      }

      this.logger?.info("auth.challenge_created", {
        wallet: sanitizedKey,
        network: this.config.stellar.network,
        challenge_ttl_ms: challengeTtlMs,
        issued_at: issuedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      });

      return {
        publicKey: sanitizedKey,
        nonce,
        message,
        issuedAt: issuedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        network: this.config.stellar.network,
        ...(transactionXdr ? { transaction: transactionXdr } : {}),
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      this.logger?.error("Unhandled error in createChallenge", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(500, "Failed to create challenge.");
    }
  }

  async verifyChallenge(input: VerifyChallengeInput): Promise<VerifyChallengeResponse> {
    try {
      const rawKey = input?.publicKey ?? input?.wallet;
      if (!rawKey) {
        throw new HttpError(400, "publicKey or wallet is required.");
      }
      const sanitizedKey = this.assertValidPublicKey(rawKey);

      const rawNonce = input?.nonce ?? input?.challenge;
      if (!rawNonce) {
        throw new HttpError(400, "nonce or challenge is required.");
      }
      const sanitizedNonce = this.assertNonEmptyString(rawNonce, "nonce").trim();
      if (sanitizedNonce.length < MIN_NONCE_LENGTH || sanitizedNonce.length > MAX_NONCE_LENGTH) {
        throw new HttpError(400, "Invalid nonce.");
      }

      const rawSig = input?.signature;
      const sanitizedSig = this.assertNonEmptyString(rawSig, "signature").trim();
      if (sanitizedSig.length > MAX_SIGNATURE_LENGTH) {
        throw new HttpError(400, "Invalid signature.");
      }

      // Decode signature early to reject malformed payloads before database queries
      const signature = decodeSignature(sanitizedSig);
      const keypair = Keypair.fromPublicKey(sanitizedKey);

      let challenge: ChallengeRecord | null;
      try {
        challenge = await this.challengeRepository.findByAddressAndNonceHash(
          sanitizedKey,
          hashNonce(sanitizedNonce)
        );
      } catch (error) {
        this.logger?.error("Failed to fetch challenge", {
          error: error instanceof Error ? error.message : String(error),
          stellarAddress: sanitizedKey,
        });
        throw new HttpError(500, "Failed to verify challenge.");
      }

      if (!challenge) {
        throw new HttpError(401, "Invalid challenge.");
      }

      if (challenge.network !== this.config.stellar.network) {
        throw new HttpError(401, "Challenge network mismatch.");
      }

      if (challenge.consumedAt) {
        throw new HttpError(401, "Challenge already used.");
      }

      if (challenge.expiresAt.getTime() <= this.now()) {
        this.recordChallengeMetric("expired", sanitizedKey);
        throw new HttpError(401, "Challenge expired.");
      }

      // Verify signature with Keypair. Catch errors thrown by nacl verify for non-64-byte signatures
      let isValid: boolean;
      try {
        isValid = keypair.verify(Buffer.from(challenge.message, "utf8"), signature);
      } catch (error) {
        this.logger?.warn("auth.signature_verification_failed", {
          wallet: sanitizedKey,
          reason: error instanceof Error ? error.message : "unknown",
        });
        throw new HttpError(401, "Invalid signature.");
      }

      if (!isValid) {
        this.logger?.warn("Invalid challenge signature", { stellarAddress: sanitizedKey });
        this.recordChallengeMetric("failed", sanitizedKey);
        throw new HttpError(401, "Invalid signature.");
      }

      // Concurrently consume challenge and upsert user to eliminate sequential round-trips
      let consumed: boolean;
      let user: User;
      try {
        [consumed, user] = await processEfficiently(
          () => this.challengeRepository.consume(challenge.id, new Date()),
          () => this.upsertUser(sanitizedKey)
        );
      } catch (error) {
        if (error instanceof HttpError || error instanceof AppError) throw error;
        this.logger?.error("Failed to process", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new AppError(500, "Processing failed", "AUTH_PROCESSING_FAILED");
      }

      if (!consumed) {
        throw new HttpError(401, "Challenge already used.");
      }

      this.recordChallengeMetric("verified", sanitizedKey);

      const publicUser = toPublicUser(user);
      this.userCache.set(sanitizedKey, publicUser);

      const token = this.signToken(publicUser);
      const decoded = jwt.decode(token) as { iat?: number; exp?: number } | null;
      this.logger?.info("jwt.issued", {
        wallet: publicUser.stellarAddress,
        issued_at: decoded?.iat
          ? new Date(decoded.iat * 1000).toISOString()
          : new Date().toISOString(),
        expires_at: decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null,
        ip_address: input.ipAddress ?? null,
      });

      return {
        token,
        tokenType: "Bearer",
        expiresIn: this.config.jwt.expiresIn,
        user: publicUser,
      };
    } catch (error) {
      if (error instanceof HttpError) {
        this.logger?.info("auth.verify_failed", {
          reason: error.message,
          wallet: this.tryTruncateWallet(input?.publicKey ?? input?.wallet),
        });
        throw error;
      }
      if (error instanceof AppError) {
        throw error;
      }
      this.logger?.error("Unhandled error in verifyChallenge", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(500, "Failed to verify challenge.");
    }
  }

  async cleanupExpiredChallenges(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    const validMaxAgeMs =
      typeof maxAgeMs === "number" && Number.isFinite(maxAgeMs) && maxAgeMs >= 0
        ? maxAgeMs
        : 24 * 60 * 60 * 1000;
    const before = new Date(Date.now() - validMaxAgeMs);

    try {
      const deleted = await processEfficiently(() =>
        this.challengeRepository.deleteExpired(before)
      );
      this.logger?.info("Cleaned up expired challenges", { count: deleted });
      return deleted;
    } catch (error) {
      this.logger?.error("Failed to cleanup expired challenges", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(500, "Failed to cleanup expired challenges.");
    }
  }

  async getChallengeMetrics(): Promise<{
    active: number;
    consumed: number;
    expired: number;
  }> {
    const cached = this.metricsCache.get("metrics");
    if (cached) {
      return cached;
    }

    if (this.metricsInflight) {
      return this.metricsInflight;
    }

    const fetchMetrics = async () => {
      try {
        const [active, consumed, expired] = await Promise.all([
          this.challengeRepository.countByStatus("active"),
          this.challengeRepository.countByStatus("consumed"),
          this.challengeRepository.countByStatus("expired"),
        ]);
        const result = { active, consumed, expired };
        this.metricsCache.set("metrics", result);
        return result;
      } catch (error) {
        this.logger?.error("Failed to get challenge metrics", {
          error: error instanceof Error ? error.message : String(error),
        });
        throw new HttpError(500, "Failed to get challenge metrics.");
      } finally {
        this.metricsInflight = null;
      }
    };

    this.metricsInflight = fetchMetrics();
    return this.metricsInflight;
  }

  async getCurrentUser(token: string): Promise<PublicUser> {
    try {
      if (typeof token !== "string") {
        throw new HttpError(
          401,
          "Invalid or expired token.",
          buildAuthFailureDetails(undefined, "missing_token")
        );
      }
      const sanitizedToken = token.trim();
      if (!sanitizedToken) {
        throw new HttpError(
          401,
          "Invalid or expired token.",
          buildAuthFailureDetails(token, "missing_token")
        );
      }

      if (sanitizedToken.length > MAX_TOKEN_LENGTH) {
        throw new HttpError(
          401,
          "Invalid or expired token.",
          buildAuthFailureDetails(sanitizedToken, "unparseable_token")
        );
      }

      let payload: AuthTokenPayload;
      try {
        const verifyKey = this.config.jwt.publicKey ?? this.config.jwt.secret;
        payload = jwt.verify(sanitizedToken, verifyKey) as AuthTokenPayload;
      } catch (error) {
        throw new HttpError(
          401,
          "Invalid or expired token.",
          buildAuthFailureDetails(sanitizedToken, classifyJwtError(error))
        );
      }

      const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
      if (!sub) {
        throw new HttpError(
          401,
          "Invalid or expired token.",
          buildAuthFailureDetails(sanitizedToken, "invalid_token")
        );
      }

      // Check LRU cache first for instant resolution under heavy traffic
      const cached = this.userCache.get(sub);
      if (cached) {
        return cached;
      }

      // Single-flight deduplication: collapse concurrent lookups into one database query
      const user = await this.fetchUserWithSingleFlight(sub, sanitizedToken);
      const publicUser = toPublicUser(user);
      this.userCache.set(sub, publicUser);
      return publicUser;
    } catch (error) {
      if (error instanceof HttpError || error instanceof AppError) throw error;
      this.logger?.error("Unhandled error in getCurrentUser", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HttpError(500, "Failed to fetch current user.");
    }
  }

  private async fetchUserWithSingleFlight(sub: string, sanitizedToken: string): Promise<User> {
    const inFlight = this.userLookupInflight.get(sub);
    if (inFlight) {
      const user = await inFlight;
      if (!user) {
        throw new HttpError(
          401,
          "Invalid or expired token.",
          buildAuthFailureDetails(sanitizedToken, "invalid_token")
        );
      }
      return user;
    }

    const promise = (async () => {
      try {
        return await this.userRepository.findByStellarAddress(sub);
      } catch (error) {
        this.logger?.error("Failed to fetch user by stellar address", {
          error: error instanceof Error ? error.message : String(error),
          sub,
        });
        throw new HttpError(500, "Failed to fetch current user.");
      }
    })().finally(() => {
      this.userLookupInflight.delete(sub);
    });

    this.userLookupInflight.set(sub, promise);
    const user = await promise;
    if (!user) {
      throw new HttpError(
        401,
        "Invalid or expired token.",
        buildAuthFailureDetails(sanitizedToken, "invalid_token")
      );
    }
    return user;
  }

  private assertNonEmptyString(value: unknown, fieldName: string): string {
    if (typeof value !== "string") {
      throw new HttpError(400, `${fieldName} is required.`);
    }
    return value;
  }

  private assertValidPublicKey(publicKey: unknown): string {
    if (typeof publicKey !== "string") {
      this.logger?.warn("auth.invalid_public_key", {
        reason: "not_a_string",
        receivedType: typeof publicKey,
      });
      throw new HttpError(400, "Invalid Stellar public key.");
    }
    const sanitized = publicKey.trim();
    if (!sanitized || !StrKey.isValidEd25519PublicKey(sanitized)) {
      this.logger?.warn("auth.invalid_public_key", {
        reason: "malformed_or_invalid_checksum",
      });
      throw new HttpError(400, "Invalid Stellar public key.");
    }
    return sanitized;
  }

  private tryTruncateWallet(value: unknown): string | null {
    if (typeof value !== "string" || value.length === 0) return null;
    if (value.length <= 8) return value;
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
  }

  /**
   * Find-or-create the user for a given Stellar address. Concurrent calls for
   * the same address are coalesced into a single repository round-trip via
   * {@link userUpsertInflight}.
   */
  private async upsertUser(publicKey: string): Promise<User> {
    const sanitized = publicKey.trim();

    const cached = this.userUpsertInflight.get(sanitized);
    if (cached) return cached;

    const promise = (async () => {
      try {
        const existingUser = await this.userRepository.findByStellarAddress(sanitized);
        if (existingUser) {
          this.logger?.debug("auth.user_found", { wallet: sanitized });
          return existingUser;
        }
        const created = await this.userRepository.save({ stellarAddress: sanitized });
        this.logger?.info("auth.user_upserted", {
          wallet: sanitized,
          user_id: created.id,
        });
        return created;
      } catch (error) {
        if (error instanceof Error && error.message.includes("duplicate key")) {
          const existing = await this.userRepository.findByStellarAddress(sanitized);
          if (existing) return existing;
        }
        this.logger?.error("upsertUser failed", {
          error: error instanceof Error ? error.message : String(error),
          publicKey: sanitized,
        });
        throw error;
      }
    })().finally(() => {
      this.userUpsertInflight.delete(sanitized);
    });

    this.userUpsertInflight.set(sanitized, promise);
    return promise;
  }

  private signToken(user: PublicUser): string {
    const isAsymmetric =
      typeof this.config.jwt.secret === "string" && this.config.jwt.secret.includes("BEGIN");

    const signOptions: SignOptions = {
      expiresIn: this.config.jwt.expiresIn as SignOptions["expiresIn"],
      ...(isAsymmetric ? { algorithm: "RS256" as const } : {}),
    };

    return jwt.sign(
      {
        sub: user.stellarAddress,
        stellarAddress: user.stellarAddress,
        wallet: user.stellarAddress,
        walletAddress: user.stellarAddress,
        role: user.userType,
        userType: user.userType,
        userId: user.id,
      },
      this.config.jwt.secret,
      signOptions
    );
  }

  generateToken(user: { id: string; stellarAddress: string }): string & { token: string } {
    if (!user || typeof user !== "object") {
      throw new HttpError(400, "User is required to generate token.");
    }
    const sanitizedAddress =
      typeof user.stellarAddress === "string" ? user.stellarAddress.trim() : "";
    const userId =
      typeof user.id === "string" && user.id.trim() ? user.id.trim() : sanitizedAddress;

    const isAsymmetric =
      typeof this.config.jwt.secret === "string" && this.config.jwt.secret.includes("BEGIN");

    const signOptions: SignOptions = {
      expiresIn: this.config.jwt.expiresIn as SignOptions["expiresIn"],
      ...(isAsymmetric ? { algorithm: "RS256" as const } : {}),
    };

    const rawToken = jwt.sign(
      {
        stellarAddress: sanitizedAddress,
        walletAddress: sanitizedAddress,
        userId,
      },
      this.config.jwt.secret,
      {
        ...signOptions,
        subject: sanitizedAddress,
      }
    );
    const tokenObj = Object.assign(new String(rawToken), { token: rawToken });
    return tokenObj as unknown as string & { token: string };
  }

  getServerPublicKey(): string | undefined {
    return (
      this.serverKeypair?.publicKey() ?? this.config.jwt.publicKey ?? this.config.serverPublicKey
    );
  }

  getPublicKey(): string | undefined {
    return this.getServerPublicKey();
  }

  verifyToken(token: string, key?: string): AuthTokenPayload {
    if (typeof token !== "string" || !token.trim()) {
      throw new HttpError(401, "Token is required.");
    }
    const verifyKey = key ?? this.config.jwt.publicKey ?? this.config.jwt.secret;
    return jwt.verify(token.trim(), verifyKey) as AuthTokenPayload;
  }
}

class TypeOrmUserRepository implements UserRepositoryContract {
  constructor(private readonly repository: Repository<User>) {}

  findById(id: string): Promise<User | null> {
    return this.repository.findOne({
      where: { id },
      select: [...USER_PROFILE_SELECT],
    });
  }

  findByStellarAddress(stellarAddress: string): Promise<User | null> {
    return this.repository.findOne({
      where: { stellarAddress },
      select: [...USER_PROFILE_SELECT],
    });
  }

  findByEmail(email: string): Promise<User | null> {
    return this.repository.findOne({
      where: { email },
    });
  }

  findAll(options?: {
    skip?: number;
    take?: number;
    cursor?: string;
    order?: "ASC" | "DESC";
  }): Promise<User[]> {
    const qb = this.repository.createQueryBuilder("user");
    qb.where("user.deletedAt IS NULL");

    if (options?.cursor) {
      const direction = options.order === "ASC" ? ">" : "<";
      qb.andWhere(`user.id ${direction} :cursor`, { cursor: options.cursor });
    }

    qb.orderBy("user.id", options?.order ?? "DESC");
    if (options?.take) qb.take(options.take);
    if (options?.skip) qb.skip(options.skip);

    return qb.getMany();
  }

  async count(options?: { cursor?: string }): Promise<number> {
    const qb = this.repository.createQueryBuilder("user");
    qb.where("user.deletedAt IS NULL");
    if (options?.cursor) {
      qb.andWhere("user.id < :cursor", { cursor: options.cursor });
    }
    return qb.getCount();
  }

  async save(user: Partial<User>): Promise<User> {
    const entity = this.repository.create(user);
    return this.repository.save(entity);
  }
}

class TypeOrmChallengeRepository implements ChallengeRepositoryContract {
  constructor(private readonly repository: Repository<AuthChallenge>) {}

  async create(input: CreateChallengeRecordInput): Promise<ChallengeRecord> {
    const entity = this.repository.create({
      stellarAddress: input.stellarAddress,
      nonceHash: input.nonceHash,
      message: input.message,
      network: input.network,
      issuedAt: input.issuedAt,
      expiresAt: input.expiresAt,
      consumedAt: null,
    });

    return this.repository.save(entity);
  }

  findByAddressAndNonceHash(
    stellarAddress: string,
    nonceHash: string
  ): Promise<ChallengeRecord | null> {
    return this.repository.findOne({
      where: {
        stellarAddress,
        nonceHash,
      },
    });
  }

  async consume(id: string, consumedAt: Date): Promise<boolean> {
    const result = await this.repository.update(
      {
        id,
        consumedAt: IsNull(),
      },
      {
        consumedAt,
      }
    );

    return (result.affected ?? 0) > 0;
  }

  async deleteExpired(before: Date): Promise<number> {
    const result = await this.repository
      .createQueryBuilder()
      .delete()
      .where("expiresAt < :before", { before })
      .orWhere("consumedAt IS NOT NULL AND consumedAt < :before", { before })
      .execute();
    return result.affected ?? 0;
  }

  async countByStatus(status: "active" | "consumed" | "expired"): Promise<number> {
    const qb = this.repository.createQueryBuilder("challenge");
    const now = new Date();
    switch (status) {
      case "active":
        qb.where("challenge.consumedAt IS NULL AND challenge.expiresAt > :now", { now });
        break;
      case "consumed":
        qb.where("challenge.consumedAt IS NOT NULL");
        break;
      case "expired":
        qb.where("challenge.consumedAt IS NULL AND challenge.expiresAt <= :now", { now });
        break;
    }
    return qb.getCount();
  }
}

export function createAuthService(
  dataSource: DataSource,
  config: Pick<AppConfig, "jwt" | "auth" | "stellar"> &
    Partial<Pick<AuthConfig, "userCacheTtlMs" | "metricsCacheTtlMs">>,
  logger?: AppLogger,
  metrics?: MetricsRegistry
): AuthService {
  return new AuthService({
    userRepository: new TypeOrmUserRepository(dataSource.getRepository(User)),
    challengeRepository: new TypeOrmChallengeRepository(dataSource.getRepository(AuthChallenge)),
    config,
    logger,
    metrics,
  });
}

export function buildChallengeMessage(input: {
  publicKey: string;
  nonce: string;
  network: string;
  networkPassphrase: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  return [
    "StellarSettle Authentication Challenge",
    `Public Key: ${input.publicKey}`,
    `Network: ${input.network}`,
    `Network Passphrase: ${input.networkPassphrase}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expires At: ${input.expiresAt.toISOString()}`,
    "",
    "Sign this exact message to authenticate with the StellarSettle API.",
  ].join("\n");
}

function hashNonce(nonce: string): string {
  return crypto.createHash("sha256").update(nonce, "utf8").digest("hex");
}

function decodeSignature(signature: string): Buffer {
  if (typeof signature !== "string") {
    throw new HttpError(400, "Signature is required.");
  }

  const trimmedSignature = signature.trim();

  if (!trimmedSignature) {
    throw new HttpError(400, "Signature is required.");
  }

  if (trimmedSignature.length > MAX_SIGNATURE_LENGTH) {
    throw new HttpError(400, "Signature exceeds maximum allowed length.");
  }

  const normalizedHexSignature = trimmedSignature.startsWith("0x")
    ? trimmedSignature.slice(2)
    : trimmedSignature;

  if (/^[a-fA-F0-9]+$/.test(normalizedHexSignature) && normalizedHexSignature.length % 2 === 0) {
    return Buffer.from(normalizedHexSignature, "hex");
  }

  if (!/^[A-Za-z0-9+/_=-]+$/.test(trimmedSignature)) {
    throw new HttpError(401, "Invalid signature.");
  }

  const normalizedBase64Signature = trimmedSignature.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = normalizedBase64Signature.length % 4;
  const paddedBase64Signature =
    paddingLength === 0
      ? normalizedBase64Signature
      : `${normalizedBase64Signature}${"=".repeat(4 - paddingLength)}`;

  return Buffer.from(paddedBase64Signature, "base64");
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    stellarAddress: user.stellarAddress,
    email: user.email,
    userType: user.userType,
    kycStatus: user.kycStatus,
    isKycVerified: user.isKycVerified,
    isSuspended: user.isSuspended,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
