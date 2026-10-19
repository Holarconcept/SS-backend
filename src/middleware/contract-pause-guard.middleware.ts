import type { NextFunction, Request, Response } from "express";
import { Contract } from "stellar-sdk";
import type { ContractGuardService } from "../services/stellar/contract-guard.service";
import type { AppLogger } from "../observability/logger";
import { logger as globalLogger } from "../observability/logger";
import { AppError } from "../utils/http-error";

/**
 * Upper bound on a pause-state read. The service has no timeout of its own on
 * the RPC call, and because it shares one in-flight read per contract, a hung
 * node would otherwise stall every guarded request at once.
 */
export const DEFAULT_PAUSE_CHECK_TIMEOUT_MS = 3_000;

/**
 * Seconds a blocked client should wait before retrying. Matches the service's
 * pause-state cache lifetime, so a retry after this long sees a fresh reading.
 */
export const PAUSED_RETRY_AFTER_SECONDS = 15;

export interface ContractPauseGuardOptions {
  contractGuardService: ContractGuardService;
  /** Contract to check. When null the guard is inert and every request passes. */
  contractId?: string | null;
  /**
   * Additional contracts the request depends on (for example escrow, token and
   * payment distributor). The request is blocked if any of them is paused.
   * Combined with `contractId`; blanks and duplicates are ignored.
   */
  contractIds?: ReadonlyArray<string | null | undefined>;
  logger?: AppLogger;
  /** Override for the pause-state read timeout. */
  timeoutMs?: number;
}

class PauseCheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Contract pause state check timed out after ${timeoutMs}ms`);
    this.name = "PauseCheckTimeoutError";
  }
}

class ContractPausedError extends Error {
  constructor(public readonly contractId: string) {
    super(`Contract ${contractId} is paused`);
    this.name = "ContractPausedError";
  }
}

/**
 * Normalises and validates the configured contract id up front.
 *
 * A malformed id would otherwise make every ledger-key build throw inside the
 * service, which degrades to "assume not paused" — the guard would silently
 * stop guarding. Failing at startup surfaces the misconfiguration instead.
 */
function normaliseContractId(contractId: string | null | undefined): string | null {
  if (contractId === null || contractId === undefined) {
    return null;
  }
  if (typeof contractId !== "string") {
    throw new Error("Contract pause guard contractId must be a string or null.");
  }

  const trimmed = contractId.trim();
  if (!trimmed) {
    return null;
  }
  try {
    // Same constructor the service uses to build the ledger key.
    new Contract(trimmed);
  } catch {
    throw new Error("Contract pause guard contractId is not a valid Soroban contract id.");
  }
  return trimmed;
}

/** Validated, de-duplicated list of contracts to guard, in configuration order. */
function resolveGuardedContracts(
  contractId: string | null | undefined,
  contractIds: ReadonlyArray<string | null | undefined> | undefined
): string[] {
  if (contractIds !== undefined && !Array.isArray(contractIds)) {
    throw new Error("Contract pause guard contractIds must be an array.");
  }

  const guarded = new Set<string>();
  for (const candidate of [contractId, ...(contractIds ?? [])]) {
    const normalised = normaliseContractId(candidate);
    if (normalised) {
      guarded.add(normalised);
    }
  }
  return [...guarded];
}

/**
 * Reads every contract's pause state concurrently. Throws a ContractPausedError
 * if any contract is paused, short-circuiting the check. If RPC errors occur,
 * they are deferred until all checks complete, ensuring that a paused state
 * always takes precedence over a failed read.
 */
async function processEfficiently(
  service: ContractGuardService,
  contractIds: readonly string[]
): Promise<void> {
  const errors: unknown[] = [];

  await Promise.all(
    contractIds.map(async (id) => {
      try {
        const isPaused = await service.checkContractPauseState(id);
        if (isPaused) {
          throw new ContractPausedError(id);
        }
      } catch (error) {
        if (error instanceof ContractPausedError) {
          throw error;
        }
        errors.push(error);
      }
    })
  );

  if (errors.length > 0) {
    throw errors[0];
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PauseCheckTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Request path without the query string, which can carry sensitive values. */
function requestPath(req: Request): string {
  const url = req.originalUrl ?? req.path ?? "";
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/**
 * Blocks requests while the underlying Soroban contract — or any of several
 * contracts the request depends on — is paused.
 *
 * When contracts are paused on-chain — during a security investigation, say —
 * any funding, investment or settlement call the API accepts would fail at
 * submission time anyway, after the user has already committed to it. Rejecting
 * up front with a 503 is both faster and clearer than letting the request reach
 * the chain and bounce.
 *
 * 503 rather than 403: this is a temporary, whole-system condition the caller
 * can retry out of, not a permission problem with their request.
 *
 * If the pause state cannot be determined — the read throws unexpectedly or
 * exceeds `timeoutMs` — the request fails with 503 `CONTRACT_PAUSE_CHECK_FAILED`
 * rather than being waved through on an unknown state.
 *
 * Read-only endpoints should not use this guard. Browsing the marketplace
 * during a pause is harmless, and blocking it would hide the state of the
 * system from the people who need to see it.
 */
export function checkContractNotPaused({
  contractGuardService,
  contractId,
  contractIds,
  logger = globalLogger,
  timeoutMs = DEFAULT_PAUSE_CHECK_TIMEOUT_MS,
}: ContractPauseGuardOptions) {
  const guardedContractIds = resolveGuardedContracts(contractId, contractIds);
  const contractIdForLogs =
    guardedContractIds.length === 1 ? guardedContractIds[0] : guardedContractIds.join(",");

  if (
    guardedContractIds.length > 0 &&
    typeof contractGuardService?.checkContractPauseState !== "function"
  ) {
    throw new Error("Contract pause guard requires a contractGuardService.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Contract pause guard timeoutMs must be a positive integer.");
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (guardedContractIds.length === 0) {
      next();
      return;
    }

    const startedAt = Date.now();

    try {
      await withTimeout(
        processEfficiently(contractGuardService, guardedContractIds),
        timeoutMs
      );
      
      // If we reach here, no contract is paused
      next();
    } catch (error) {
      if (error instanceof ContractPausedError) {
        logger.warn("Request blocked: smart contract is paused", {
          contract_id: error.contractId,
          method: req.method,
          path: requestPath(req),
        });

        if (!res.headersSent) {
          res.setHeader("Retry-After", String(PAUSED_RETRY_AFTER_SECONDS));
          res.status(503).json({
            success: false,
            error: {
              code: "CONTRACT_PAUSED",
              message: "Smart contract operations are currently paused by administration.",
            },
          });
        }
        return;
      }

      // The service already degrades gracefully on RPC failure, so reaching
      // here means something unexpected broke or the read hung. Fail the
      // request rather than waving it through on an unknown pause state.
      const timedOut = error instanceof PauseCheckTimeoutError;
      logger.error("Contract pause state check failed; rejecting request", {
        contract_id: contractIdForLogs,
        method: req.method,
        path: requestPath(req),
        reason: timedOut ? "timeout" : "error",
        duration_ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });

      next(
        new AppError(
          503,
          "Unable to verify smart contract status. Please try again shortly.",
          "CONTRACT_PAUSE_CHECK_FAILED"
        )
      );
    }
  };
}
