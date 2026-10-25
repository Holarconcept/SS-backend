import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { DataSource } from "typeorm";

import { User } from "../models/User.model";
import { logger as globalLogger, type AppLogger } from "../observability/logger";
import { AppError } from "../utils/http-error";
import { extractBearerToken } from "./auth.middleware";

/** Returns true when the wallet belongs to a suspended account. */
export type SuspensionLookup = (stellarAddress: string) => Promise<boolean>;

const suspendedWallets = new Set<string>();

export function markWalletSuspended(wallet: string): void {
  suspendedWallets.add(wallet);
}

export function unmarkWalletSuspended(wallet: string): void {
  suspendedWallets.delete(wallet);
}

export function isWalletSuspended(stellarAddress?: string | null): boolean {
  if (!stellarAddress) return false;
  return suspendedWallets.has(stellarAddress);
}

export function createDataSourceSuspensionLookup(dataSource: DataSource): SuspensionLookup {
  return async (stellarAddress) => {
    if (!dataSource.isInitialized) return false;
    const user = await dataSource.getRepository(User).findOne({
      select: { id: true, isSuspended: true },
      where: { stellarAddress },
    });
    return user?.isSuspended === true;
  };
}

export function accountSuspendedError(): AppError {
  return new AppError(403, "This account has been suspended.", "ACCOUNT_SUSPENDED");
}

function walletFromToken(token: string): string | null {
  const claims = jwt.decode(token);
  if (!claims || typeof claims !== "object") return null;
  const wallet = claims.stellarAddress ?? claims.sub;
  return typeof wallet === "string" && wallet.trim() ? wallet.trim() : null;
}

/**
 * Refuses every request carrying a bearer token for a suspended wallet with
 * 403 ACCOUNT_SUSPENDED. Mounted ahead of the routers so it covers all
 * authenticated routes, whichever auth middleware they use.
 *
 * The token is only decoded here, not verified: this guard can only deny,
 * and the route's own auth middleware still verifies the signature. The
 * suspension flag is read on every request, so unsuspending restores access
 * immediately with the user's existing token.
 */
export function createSuspendedWalletGuard(
  lookup: SuspensionLookup,
  log: AppLogger = globalLogger
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const extracted = extractBearerToken(req.headers.authorization);
    if (!extracted.ok) {
      next();
      return;
    }

    const wallet = walletFromToken(extracted.token);
    if (!wallet) {
      next();
      return;
    }

    try {
      if (await lookup(wallet)) {
        log.warn("Rejected request from suspended wallet.", {
          method: req.method,
          path: req.path,
          wallet,
        });
        next(accountSuspendedError());
        return;
      }
      next();
    } catch (error) {
      // Fail closed: an unknown suspension state must not let a request through.
      log.error("Suspension lookup failed.", {
        method: req.method,
        path: req.path,
        error: error instanceof Error ? error.message : String(error),
      });
      next(
        new AppError(
          503,
          "Authentication is temporarily unavailable. Please try again shortly.",
          "AUTH_UNAVAILABLE"
        )
      );
    }
  };
}
