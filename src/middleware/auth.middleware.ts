import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import type { AuthService } from "../services/auth.service";
import type { AuthenticatedRequest } from "../types/auth";
import type { AppLogger } from "../observability/logger";
import { logger as globalLogger } from "../observability/logger";

import { AppError, HttpError } from "../utils/http-error";
import { UserType, KYCStatus } from "../types/enums";
import {
  type AuthFailureReason,
  buildAuthFailureDetails,
  classifyJwtError,
} from "../lib/auth-failure";

interface AuthTokenPayload {
  sub: string;
  stellarAddress: string;
  wallet?: string;
  role?: UserType;
  userType?: UserType;
  userId?: string;
}

/**
 * Tokens this service issues are a few hundred bytes. Anything far beyond that
 * is not one of ours, and is rejected before it is decoded or verified so an
 * oversized header cannot be used to burn CPU.
 */
export const MAX_BEARER_TOKEN_LENGTH = 4_096;

/**
 * Upper bound on the user lookup behind `createAuthMiddleware`. The lookup hits
 * the database; without a bound, a stalled connection pool holds every
 * authenticated request open until the client gives up.
 */
export const DEFAULT_AUTH_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Tokens are verified against the symmetric JWT_SECRET, so only HMAC is
 * accepted. Allowing RS256/ES256 here would open algorithm confusion attacks.
 */
export const ALLOWED_JWT_ALGORITHMS: jwt.Algorithm[] = ["HS256"];

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export interface AuthMiddlewareOptions {
  logger?: AppLogger;
  /** Override for the user lookup timeout. */
  timeoutMs?: number;
}

type BearerTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: AuthFailureReason; token?: string };

class AuthLookupTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Authentication lookup timed out after ${timeoutMs}ms`);
    this.name = "AuthLookupTimeoutError";
  }
}

/**
 * Extracts the token from an `Authorization: Bearer <token>` header.
 *
 * The scheme is matched case-insensitively (RFC 7235) and surrounding
 * whitespace is ignored, so `bearer <token>` from some HTTP clients is
 * accepted. Oversized tokens are rejected without being echoed into failure
 * details, since those details decode the token.
 */
export function extractBearerToken(header: unknown): BearerTokenResult {
  if (typeof header !== "string") {
    return { ok: false, reason: "missing_token" };
  }

  const match = /^\s*bearer\s+(.*)$/i.exec(header);
  if (!match) {
    return { ok: false, reason: "missing_token" };
  }

  const token = match[1].trim();
  if (!token) {
    return { ok: false, reason: "missing_token" };
  }
  if (token.length > MAX_BEARER_TOKEN_LENGTH) {
    return { ok: false, reason: "unparseable_token" };
  }

  return { ok: true, token };
}

function missingOrMalformedTokenError(
  result: Extract<BearerTokenResult, { ok: false }>,
  appLogger?: AppLogger
) {
  if (result.reason === "missing_token") {
    return new HttpError(
      401,
      "Authorization token is required.",
      buildAuthFailureDetails(undefined, "missing_token", appLogger)
    );
  }
  return new HttpError(
    401,
    "Invalid or expired token.",
    buildAuthFailureDetails(result.token, result.reason, appLogger)
  );
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AuthLookupTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createAuthMiddleware(
  authService: AuthService,
  { logger = globalLogger, timeoutMs = DEFAULT_AUTH_LOOKUP_TIMEOUT_MS }: AuthMiddlewareOptions = {}
) {
  if (typeof authService?.getCurrentUser !== "function") {
    throw new Error("createAuthMiddleware requires an authService with getCurrentUser().");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Auth middleware timeoutMs must be a positive integer.");
  }

  return async (req: AuthenticatedRequest, _res: Response, next: NextFunction): Promise<void> => {
    const extracted = extractBearerToken(req.headers.authorization);
    if (!extracted.ok) {
      next(missingOrMalformedTokenError(extracted));
      return;
    }

    const { token } = extracted;
    const startedAt = Date.now();

    try {
      const user = await withTimeout(
        Promise.resolve().then(() => authService.getCurrentUser(token)),
        timeoutMs
      );
      if (user.isSuspended) {
        next(new AppError(403, "This account has been suspended.", "ACCOUNT_SUSPENDED"));
        return;
      }
      req.user = user;
      next();
    } catch (error) {
      if (error instanceof HttpError || error instanceof AppError) {
        next(error);
        return;
      }

      if (error instanceof AuthLookupTimeoutError) {
        // An outage, not a bad credential: a 401 here would make clients
        // discard valid sessions and send a wave of re-logins at a backend
        // that is already struggling.
        logger.error("Authentication lookup timed out", {
          method: req.method,
          path: req.path,
          duration_ms: Date.now() - startedAt,
        });
        next(
          new AppError(
            503,
            "Authentication is temporarily unavailable. Please try again shortly.",
            "AUTH_UNAVAILABLE"
          )
        );
        return;
      }

      if (error instanceof jwt.JsonWebTokenError) {
        next(
          new HttpError(
            401,
            "Invalid or expired token.",
            buildAuthFailureDetails(token, classifyJwtError(error))
          )
        );
        return;
      }

      logger.error('Failed to process', { error });
      next(new AppError(500, 'Processing failed', 'AUTH_PROCESSING_FAILED'));
    }
  };
}

async function processEfficiently(token: string, secret: string): Promise<jwt.JwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(token, secret, { algorithms: ALLOWED_JWT_ALGORITHMS }, (error, payload) => {
      if (error) {
        reject(error);
      } else {
        resolve(payload as jwt.JwtPayload);
      }
    });
  });
}

export async function authenticateJWT(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const extracted = extractBearerToken(req.headers.authorization);
  if (!extracted.ok) {
    next(missingOrMalformedTokenError(extracted));
    return;
  }

  const { token } = extracted;

  // Not a compact JWS at all: skip verification and report it as such.
  if (!JWT_SHAPE.test(token)) {
    next(
      new HttpError(
        401,
        "Invalid or expired token.",
        buildAuthFailureDetails(token, "unparseable_token")
      )
    );
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // A server misconfiguration, not a problem with the caller's token.
    globalLogger.error("JWT_SECRET is not configured; cannot verify bearer tokens", {
      method: req.method,
      path: req.path,
    });
    next(
      new AppError(500, "Authentication is not configured on this server.", "AUTH_MISCONFIGURED")
    );
    return;
  }

  let payload: jwt.JwtPayload;
  try {
    payload = await processEfficiently(token, secret);
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(
        new HttpError(
          401,
          "Invalid or expired token.",
          buildAuthFailureDetails(token, classifyJwtError(error))
        )
      );
      return;
    }

    globalLogger.error('Failed to process', { error });
    next(new AppError(500, 'Processing failed', 'AUTH_PROCESSING_FAILED'));
    return;
  }

  const claims = typeof payload === "object" && payload !== null ? payload : null;
  const subject = nonEmptyString(claims?.sub);
  if (!claims || !subject) {
    next(
      new HttpError(401, "Invalid token payload.", buildAuthFailureDetails(token, "invalid_token"))
    );
    return;
  }

  const { userId, stellarAddress, wallet, userType, role } = claims as Partial<AuthTokenPayload>;
  const resolvedAddress = nonEmptyString(wallet) ?? nonEmptyString(stellarAddress) ?? subject;

  // Issue #610: Check wallet suspension status
  const { isWalletSuspended } = await import("@/middleware/suspended-wallet.middleware");
  if (isWalletSuspended(resolvedAddress)) {
    next(
      new HttpError(
        403,
        "Wallet is suspended and cannot perform authenticated actions.",
        buildAuthFailureDetails(token, "wallet_suspended")
      )
    );
    return;
  }

  (req as AuthenticatedRequest).user = {
    id: nonEmptyString(userId) ?? subject,
    // Tokens are issued with the wallet address as subject.
    stellarAddress: resolvedAddress,
    email: null,
    userType: userType || role || (null as unknown as UserType),
    kycStatus: null as unknown as KYCStatus,
    isKycVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  next();
}

export function requireRole(allowedRoles: UserType[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      return next(new HttpError(401, "Authentication required"));
    }

    const role = authReq.user.userType;
    if (!role || (!allowedRoles.includes(role) && role !== UserType.BOTH)) {
      return next(new HttpError(403, "Access forbidden for this user role"));
    }

    next();
  };
}

export function requireKYC(skipVerification = false) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (skipVerification) {
      next();
      return;
    }

    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      next(new HttpError(401, "Authentication required"));
      return;
    }

    if (authReq.user.kycStatus !== KYCStatus.APPROVED) {
      next(new HttpError(403, "KYC approval required for this action"));
      return;
    }

    next();
  };
}

export function checkKycVerified(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user) {
    next(new HttpError(401, "Authentication required"));
    return;
  }
  if (user.kycStatus !== KYCStatus.APPROVED) {
    next(new AppError(403, "KYC approval required for this action", "KYC_NOT_APPROVED"));
    return;
  }
  next();
}

export function requireSeller() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      next(new HttpError(401, "Authentication required."));
      return;
    }

    if (
      authReq.user.userType !== UserType.SELLER &&
      authReq.user.userType !== UserType.BOTH
    ) {
      next(new HttpError(403, "Seller access required."));
      return;
    }

    next();
  };
}

export function requireAdmin(adminWallets: string[] = []) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      next(new HttpError(401, "Authentication required"));
      return;
    }

    if (
      user.userType === UserType.ADMIN ||
      (adminWallets.length > 0 && adminWallets.includes(user.stellarAddress))
    ) {
      next();
      return;
    }

    next(new AppError(403, "Admin privileges required", "ADMIN_REQUIRED"));
  };
}

/** Requires an authenticated investor (or BOTH) account. */
export function requireInvestor() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      next(new HttpError(401, "Authentication required."));
      return;
    }

    if (
      authReq.user.userType !== UserType.INVESTOR &&
      authReq.user.userType !== UserType.BOTH
    ) {
      next(new HttpError(403, "Investor access required."));
      return;
    }

    next();
  };
}
