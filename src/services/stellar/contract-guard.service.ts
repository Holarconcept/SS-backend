import { Contract, xdr, scValToNative } from "@stellar/stellar-sdk";
import type { AppLogger } from "../../observability/logger";
import { logger as globalLogger } from "../../observability/logger";

type FetchLike = typeof fetch;
type Clock = () => number;

/**
 * How long a pause reading stays usable before the guard goes back to the RPC.
 *
 * Short enough that a pause takes effect within seconds, long enough that a
 * burst of API traffic collapses into one RPC call per contract rather than one
 * per request — which is what would otherwise get the node to throttle us.
 */
export const PAUSE_STATE_TTL_MS = 15_000;

/** Contract storage symbol holding the emergency pause flag. */
const PAUSED_STORAGE_KEY = "Paused";

export interface ContractGuardServiceDependencies {
  /** Soroban JSON-RPC endpoint, e.g. https://soroban-testnet.stellar.org. */
  rpcUrl: string;
  fetchFn?: FetchLike;
  logger?: AppLogger;
  /** Cache lifetime override, primarily for tests. */
  ttlMs?: number;
  /** Injectable clock so tests can advance time without waiting. */
  now?: Clock;
  /**
   * Decodes a base64 `ContractData` ledger entry into the flag it holds.
   * Injectable so tests can exercise the caching and failure behaviour without
   * hand-assembling ledger-entry XDR.
   */
  decodeEntry?: (entryXdr: string) => boolean;
}

interface CachedPauseState {
  paused: boolean;
  readAt: number;
}

interface SorobanLedgerEntryResult {
  key?: string;
  xdr?: string;
}

interface SorobanGetLedgerEntriesResponse {
  result?: {
    entries?: SorobanLedgerEntryResult[] | null;
  };
  error?: {
    code?: number;
    message?: string;
  };
}

/**
 * Reads and caches the on-chain emergency pause flag for Soroban contracts.
 *
 * The contracts expose `pause()` / `unpause()` which flip a `Paused` entry in
 * persistent contract storage. This service reads that entry directly through
 * `getLedgerEntries`, so it observes a pause the moment the admin's transaction
 * lands rather than waiting for an event pipeline.
 *
 * ## Absent entry means "not paused"
 *
 * A contract that has never been paused has no `Paused` storage entry at all.
 * That is indistinguishable from `false` and is treated as such.
 *
 * ## Behaviour when the RPC is unreachable
 *
 * Falling back to "paused" on every RPC blip would take the whole API down for
 * a network wobble; falling back to "not paused" would let trades through
 * during a real incident. The compromise: serve the last reading we have, even
 * an expired one, and only assume "not paused" when we have never had one. Both
 * fallbacks are logged at warn level so the gap is visible in an incident.
 */
export class ContractGuardService {
  private readonly rpcUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly logger: AppLogger;
  private readonly ttlMs: number;
  private readonly now: Clock;
  private readonly decodeEntry: (entryXdr: string) => boolean;
  private readonly cache = new Map<string, CachedPauseState>();
  /** In-flight reads, so concurrent requests share one RPC round trip. */
  private readonly inFlight = new Map<string, Promise<boolean>>();

  constructor(dependencies: ContractGuardServiceDependencies) {
    if (!dependencies.rpcUrl) {
      throw new Error("rpcUrl is required.");
    }
    this.rpcUrl = dependencies.rpcUrl;
    this.fetchFn = dependencies.fetchFn ?? fetch;
    this.logger = dependencies.logger ?? globalLogger;
    this.ttlMs = dependencies.ttlMs ?? PAUSE_STATE_TTL_MS;
    this.now = dependencies.now ?? Date.now;
    this.decodeEntry = dependencies.decodeEntry ?? decodePausedEntry;
  }

  /**
   * Returns whether `contractId` is currently paused, using the cached reading
   * when it is still fresh.
   */
  async checkContractPauseState(contractId: string): Promise<boolean> {
    const cached = this.cache.get(contractId);
    if (cached && this.now() - cached.readAt < this.ttlMs) {
      return cached.paused;
    }

    const existing = this.inFlight.get(contractId);
    if (existing) {
      return existing;
    }

    const read = this.readAndCache(contractId).finally(() => {
      this.inFlight.delete(contractId);
    });
    this.inFlight.set(contractId, read);
    return read;
  }

  /** Drops all cached readings. Used by tests and by admin-triggered refreshes. */
  clearCache(): void {
    this.cache.clear();
  }

  private async readAndCache(contractId: string): Promise<boolean> {
    try {
      const paused = await this.fetchPauseState(contractId);
      this.cache.set(contractId, { paused, readAt: this.now() });
      return paused;
    } catch (error) {
      const stale = this.cache.get(contractId);
      if (stale) {
        this.logger.warn("Falling back to stale contract pause state", {
          contract_id: contractId,
          stale_paused: stale.paused,
          stale_age_ms: this.now() - stale.readAt,
          reason: error instanceof Error ? error.message : String(error),
        });
        return stale.paused;
      }

      this.logger.warn("Contract pause state unavailable; assuming not paused", {
        contract_id: contractId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async fetchPauseState(contractId: string): Promise<boolean> {
    const response = await this.fetchFn(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLedgerEntries",
        params: { keys: [buildPausedLedgerKey(contractId)] },
      }),
    });

    if (!response.ok) {
      throw new Error(`Soroban RPC responded ${response.status}`);
    }

    const body = (await response.json()) as SorobanGetLedgerEntriesResponse;
    if (body.error) {
      throw new Error(body.error.message ?? "Soroban RPC returned an error");
    }

    const entry = body.result?.entries?.[0];
    if (!entry?.xdr) {
      // No `Paused` entry has ever been written for this contract.
      return false;
    }

    return this.decodeEntry(entry.xdr);
  }
}

/**
 * Builds the base64 ledger key for a contract's persistent `Paused` entry.
 */
export function buildPausedLedgerKey(contractId: string): string {
  const contract = new Contract(contractId);
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: contract.address().toScAddress(),
      key: xdr.ScVal.scvSymbol(PAUSED_STORAGE_KEY),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  return key.toXDR("base64");
}

/**
 * Decodes a `ContractData` ledger entry into the boolean it holds.
 *
 * Anything that is not a boolean `true` reads as not paused — a contract that
 * stores something unexpected under `Paused` is a bug, but it is not grounds
 * for refusing every payment in the system.
 */
export function decodePausedEntry(entryXdr: string): boolean {
  const entryData = xdr.LedgerEntryData.fromXDR(entryXdr, "base64");
  const value = scValToNative(entryData.contractData().val());
  return value === true;
}

export function createContractGuardService(
  dependencies: ContractGuardServiceDependencies
): ContractGuardService {
  return new ContractGuardService(dependencies);
}
