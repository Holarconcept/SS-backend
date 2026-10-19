import {
  Address,
  Contract,
  SorobanRpc,
  Transaction,
  nativeToScVal,
  xdr,
  scValToNative,
} from "stellar-sdk";

import { logger as globalLogger } from "../../observability/logger";
import type { AppLogger } from "../../observability/logger";
import type {
  KeyHoldingReading,
  SubscriptionHoldingReader,
} from "../subscription-status.service";

export interface SorobanSubscriptionReaderDependencies {
  /** Gated-content contract that tracks holdings and the access minimum. */
  contractId: string;
  rpcUrl?: string;
  server?: SorobanRpc.Server;
  logger?: AppLogger;
  /** Contract function names, overridable for a contract revision. */
  functionNames?: Partial<SubscriptionFunctionNames>;
}

export interface SubscriptionFunctionNames {
  holding: string;
  minimum: string;
  expiry: string;
}

const DEFAULT_FUNCTIONS: SubscriptionFunctionNames = {
  holding: "holding_of",
  minimum: "min_balance",
  expiry: "expiry_ledger",
};

/**
 * Builds the contract argument for a key.
 *
 * `key_id` accepts either a strkey (a contract id, or a G… public key used as
 * a ledger key) or the plain string identifier the contract itself uses, so an
 * address is only encoded as one when it really is a valid strkey. Everything
 * else is passed through as a `ScVal` string, which is what a contract written
 * against a `Symbol`/`String` key expects.
 */
function toKeyScVal(keyId: string): xdr.ScVal {
  try {
    return new Address(keyId).toScVal();
  } catch {
    return nativeToScVal(keyId, { type: "string" });
  }
}

/**
 * Reads gated-content access state from a Soroban contract.
 *
 * The holding, the minimum required balance and the expiry ledger are exposed
 * as read-only contract functions and fetched through `simulateTransaction` on a
 * stub transaction, which is how the network evaluates a view call without
 * spending a fee. Balances are `i128`, so they are read as `bigint` and handed
 * back as decimal strings.
 */
export class SorobanSubscriptionReader implements SubscriptionHoldingReader {
  private readonly contract: Contract;
  private readonly rpcServer?: SorobanRpc.Server;
  private readonly logger: AppLogger;
  private readonly functionNames: SubscriptionFunctionNames;

  constructor(dependencies: SorobanSubscriptionReaderDependencies) {
    if (!dependencies.contractId) {
      throw new Error("contractId is required.");
    }
    this.contract = new Contract(dependencies.contractId);
    this.logger = dependencies.logger ?? globalLogger;
    this.functionNames = { ...DEFAULT_FUNCTIONS, ...dependencies.functionNames };

    if (dependencies.server) {
      this.rpcServer = dependencies.server;
    } else if (dependencies.rpcUrl) {
      this.rpcServer = new SorobanRpc.Server(dependencies.rpcUrl, {
        allowHttp: dependencies.rpcUrl.startsWith("http://"),
      });
    }
  }

  async readHolding(input: { wallet: string; keyId: string }): Promise<KeyHoldingReading> {
    if (!this.rpcServer) {
      throw new Error("Soroban RPC server is not configured for subscription reads.");
    }

    const keyScVal = toKeyScVal(input.keyId);

    const [balance, minBalance, expiryLedger, ledger] = await Promise.all([
      this.callNumeric(this.functionNames.holding, keyScVal, input.wallet),
      this.callNumeric(this.functionNames.minimum, keyScVal),
      this.callNumeric(this.functionNames.expiry, keyScVal, input.wallet),
      this.currentLedger(),
    ]);

    return {
      balance: balance ?? "0",
      minBalance: minBalance ?? "0",
      expiryLedger: expiryLedger === null ? null : Number(expiryLedger),
      ledger,
    };
  }

  /** Latest closed ledger sequence; the reference point for expiry maths. */
  private async currentLedger(): Promise<number> {
    try {
      const latest = await this.rpcServer!.getLatestLedger();
      return latest.sequence;
    } catch (error) {
      this.logger.warn("Unable to read latest ledger; treating chain head as ledger 0", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Invokes a read-only contract function and coerces the result to a decimal
   * string. A missing or non-numeric result reads as `null` so the caller can
   * distinguish "no value" from a genuine zero.
   */
  private async callNumeric(
    functionName: string,
    keyScVal: xdr.ScVal,
    wallet?: string
  ): Promise<string | null> {
    const args = wallet ? [keyScVal, new Address(wallet).toScVal()] : [keyScVal];

    // Building the operation also validates the function name, and the stub
    // transaction carries it so the node can evaluate the call. It is never
    // submitted, so the read costs no fee.
    const operation = this.contract.call(functionName, ...args);
    const stubTx = { toXDR: () => operation.toXDR("base64") } as unknown as Transaction;

    try {
      const simulation = (await this.rpcServer!.simulateTransaction(stubTx)) as unknown as {
        results?: Array<{ xdr: string }>;
        result?: { retval?: xdr.ScVal };
      };

      const returnValue =
        simulation.results?.[0]?.xdr !== undefined
          ? xdr.ScVal.fromXDR(simulation.results[0].xdr, "base64")
          : simulation.result?.retval;
      if (!returnValue) return null;

      const native = scValToNative(returnValue);
      if (native === null || native === undefined) return null;
      if (typeof native === "object") return null;
      return String(native);
    } catch (error) {
      this.logger.warn("Subscription contract read failed", {
        function_name: functionName,
        wallet,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export function createSorobanSubscriptionReader(
  dependencies: SorobanSubscriptionReaderDependencies
): SorobanSubscriptionReader {
  return new SorobanSubscriptionReader(dependencies);
}
