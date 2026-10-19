import jwt from "jsonwebtoken";
import type { AppLogger } from "../observability/logger";

export type AuthFailureReason =
  | "missing_token"
  | "expired_token"
  | "invalid_signature"
  | "invalid_token"
  | "unparseable_token"
  | "insufficient_role";

export interface AuthFailureDetails {
  reason: AuthFailureReason;
  truncatedAddress: string | null;
  failedAt: string;
}

/**
 * Upper limit on wallet address length to prevent storing excessively large strings.
 * Stellar addresses are ~56 chars; this allows for some variance.
 */
const MAX_WALLET_ADDRESS_LENGTH = 512;

/**
 * Cache for ISO strings to avoid repeated Date operations. Reset on each call to
 * ensure staleness doesn't accumulate, but amortizes the cost of toISOString().
 */
let cachedIsoString: string | null = null;
let cachedIsoTimestamp = 0;
const ISO_CACHE_TTL_MS = 1000; // Refresh every second

/**
 * Efficiently retrieves current timestamp as ISO string with caching.
 * Under high load, calling new Date().toISOString() repeatedly is wasteful.
 * This cache reduces GC pressure and CPU usage in auth failure paths.
 */
function getCurrentIsoString(): string {
  const now = Date.now();
  if (cachedIsoString && now - cachedIsoTimestamp < ISO_CACHE_TTL_MS) {
    return cachedIsoString;
  }
  try {
    cachedIsoString = new Date(now).toISOString();
    cachedIsoTimestamp = now;
    return cachedIsoString;
  } catch {
    // Fallback to a safe default if Date operations fail
    return "1970-01-01T00:00:00.000Z";
  }
}

/**
 * Safely extracts and validates a string value from a JWT payload.
 * Returns the trimmed string or null if validation fails.
 *
 * @param value - The value to extract and validate
 * @param maxLength - Maximum allowed length for the extracted value
 * @returns Trimmed non-empty string or null
 */
function safeExtractString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }

  return trimmed;
}

/**
 * Truncates a wallet address to a displayable format (first 4 + ... + last 4 chars).
 * Performs input validation and returns null for invalid addresses.
 *
 * Performance: O(1) operation with bounds checking.
 * Handles edge cases: null, undefined, empty, very short addresses.
 *
 * @param address - The wallet address to truncate
 * @returns Truncated address or null if invalid
 */
export function truncateWalletAddress(address: string | null | undefined): string | null {
  const validated = safeExtractString(address, MAX_WALLET_ADDRESS_LENGTH);
  if (!validated) {
    return null;
  }

  if (validated.length <= 8) {
    return validated;
  }

  return `${validated.slice(0, 4)}...${validated.slice(-4)}`;
}

/**
 * Extracts the wallet address (sub claim) from a JWT without verification.
 * Used to populate error details for logging/telemetry.
 *
 * Performance: O(1) decode + property lookup.
 * Error handling: Catches JWT decode errors gracefully and returns null.
 * Safety: Does not verify signature; safe for error paths.
 *
 * @param token - The JWT token string (unverified)
 * @returns Extracted wallet address or null if extraction fails
 */
export function extractWalletFromUnverifiedToken(token?: string): string | null {
  const validated = safeExtractString(token, 8_192); // JWT size limit
  if (!validated) {
    return null;
  }

  let decoded: string | jwt.JwtPayload | null;
  try {
    decoded = jwt.decode(validated);
  } catch {
    // jwt.decode() throws on structural issues (e.g., invalid base64).
    // Return null without escalating; auth failure details are best-effort.
    return null;
  }

  if (!decoded || typeof decoded === "string") {
    return null;
  }

  return safeExtractString(decoded.sub, MAX_WALLET_ADDRESS_LENGTH);
}

/**
 * Builds structured failure details from an authentication error.
 * Safe to call in error paths; all operations are wrapped with fallbacks.
 *
 * Performance: O(1) operations; no I/O or external dependencies.
 * Error handling: All exceptions caught; always returns a valid object.
 * Logging: Optional logger parameter for observability.
 *
 * @param token - The JWT token (optional, used to extract wallet address)
 * @param reason - The classification of the auth failure
 * @param logger - Optional AppLogger for error tracking
 * @returns Object with authFailure details
 */
export function buildAuthFailureDetails(
  token: string | undefined,
  reason: AuthFailureReason,
  logger?: AppLogger
): { authFailure: AuthFailureDetails } {
  let truncatedAddress: string | null = null;

  try {
    const wallet = extractWalletFromUnverifiedToken(token);
    truncatedAddress = truncateWalletAddress(wallet);
  } catch (error) {
    // Wallet extraction is best-effort; log if logger provided but don't escalate.
    if (logger) {
      logger.debug("Failed to extract wallet from unverified token", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    truncatedAddress = null;
  }

  const failedAt = getCurrentIsoString();

  return {
    authFailure: {
      reason,
      truncatedAddress,
      failedAt,
    },
  };
}

/**
 * Classifies a JWT error into a standardized AuthFailureReason.
 * Handles all jwt library error types and unknown errors gracefully.
 *
 * Performance: O(1) instanceof checks + string operations.
 * Error handling: Always returns a valid reason; never throws.
 *
 * @param error - The error to classify
 * @returns Standardized AuthFailureReason
 */
export function classifyJwtError(error: unknown): AuthFailureReason {
  if (error instanceof jwt.TokenExpiredError) {
    return "expired_token";
  }

  if (error instanceof jwt.JsonWebTokenError) {
    const message = error.message.toLowerCase();

    if (message.includes("invalid signature")) {
      return "invalid_signature";
    }

    // jsonwebtoken throws this exact JsonWebTokenError message when the
    // token isn't even well-formed JWT (not base64/dot-delimited, or the
    // header/payload segments aren't valid JSON) — distinct from a
    // structurally valid token with a bad signature or claims.
    if (message.includes("malformed")) {
      return "unparseable_token";
    }

    return "invalid_token";
  }

  return "invalid_token";
}
