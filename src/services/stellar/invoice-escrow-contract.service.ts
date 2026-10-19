import {
  Contract,
  Address,
  nativeToScVal,
  xdr,
  SorobanRpc,
  Transaction,
  FeeBumpTransaction,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
} from "stellar-sdk";
import type { AppLogger } from "../../observability/logger";
import { logger as globalLogger } from "../../observability/logger";
import { ServiceError } from "../../utils/service-error";
import type {
  CreateEscrowParams,
  CreateEscrowResult,
  FundEscrowParams,
  RecordPaymentParams,
  SettleEscrowParams,
  SimulateTransactionResult,
  SendTransactionResult,
} from "../../types/soroban.types";

export type CreateEscrowInput = CreateEscrowParams;
export type { CreateEscrowResult, FundEscrowParams, RecordPaymentParams, SettleEscrowParams };

/**
 * Maximum value (inclusive) accepted for `amountStroops`. Soroban `i128`
 * arguments are signed 128-bit integers; we cap at a value comfortably below
 * `2^127 - 1` to avoid accidental overflow when downstream contracts apply
 * arithmetic. `10^18` stroops is already far in excess of any plausible
 * invoice on Stellar.
 */
const MAX_STROOPS = 10n ** 18n;

/**
 * Reject obviously-bad due dates: not-a-number, non-positive, already in the
 * past, or further than 10 years into the future. The 10-year ceiling catches
 * accidental "garbage" timestamps (e.g. milliseconds, seconds-since-1970
 * shifted by a stray factor of 1000) without rejecting legitimate financing
 * windows.
 */
const MAX_DUE_DATE_HORIZON_MS = 10 * 365 * 24 * 60 * 60 * 1000;

/**
 * Default retry policy for transient RPC failures (network blips, 5xx from
 * Soroban RPC). Three attempts with a small exponential backoff (50ms / 100ms
 * + uniform jitter up to 50ms) keeps the worst-case latency bounded while
 * riding out short-lived outages.
 */
const RPC_RETRY_ATTEMPTS = 3;
const RPC_RETRY_BASE_DELAY_MS = 50;
const RPC_RETRY_MAX_JITTER_MS = 50;

/** Status returned by {@link InvoiceEscrowContractService.getTransactionStatus}. */
export type ConfirmationStatus = "SUCCESS" | "FAILED" | "NOT_FOUND";

export interface InvoiceEscrowContractServiceDependencies {
  contractId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  platformSecretKey?: string;
  server?: SorobanRpc.Server;
  logger?: AppLogger;
  confirmationPollMs?: number;
  confirmationAttempts?: number;
  /**
   * Override for {@link MAX_DUE_DATE_HORIZON_MS} (in milliseconds). Mostly
   * useful in tests; leave unset in production.
   */
  maxDueDateHorizonMs?: number;
  /**
   * Override for {@link MAX_STROOPS}. Mostly useful in tests; leave unset in
   * production.
   */
  maxStroops?: bigint;
  /**
   * Override for the number of attempts used to ride out transient RPC
   * failures inside {@link simulateTransaction} and {@link submitTransaction}.
   */
  rpcRetryAttempts?: number;
  /**
   * Override for the base delay used between RPC retry attempts (ms).
   */
  rpcRetryBaseDelayMs?: number;
  /**
   * When `true`, the build methods and {@link createEscrowOnChain} reject
   * `dueDateTimestamp` values that are in the past or further than the
   * configured horizon in the future. Defaults to `false` to preserve the
   * previous permissive behaviour; new deployments should opt in.
   */
  strictDueDateValidation?: boolean;
  /**
   * Inject the current time (ms since epoch). Used for deterministic testing
   * of the strict due-date validator.
   */
  now?: () => number;
}

function sanitizeString(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new ServiceError(
      "invalid_input",
      `${fieldName} is required.`,
      400,
      { field: fieldName, receivedType: typeof value },
    );
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ServiceError(
      "invalid_input",
      `${fieldName} is required.`,
      400,
      { field: fieldName },
    );
  }
  return trimmed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(baseMs: number, maxJitterMs: number): number {
  // `Math.random` is fine here: jitter is for spreading load, not security.
  const jitterMs = Math.floor(Math.random() * maxJitterMs);
  return baseMs + jitterMs;
}

export class InvoiceEscrowContractService {
  private readonly contract: Contract;
  readonly contractId: string;
  private readonly rpcServer?: SorobanRpc.Server;
  private readonly networkPassphrase?: string;
  private readonly platformSecretKey?: string;
  private readonly logger: AppLogger;
  private readonly confirmationPollMs: number;
  private readonly confirmationAttempts: number;
  private readonly maxDueDateHorizonMs: number;
  private readonly maxStroops: bigint;
  private readonly rpcRetryAttempts: number;
  private readonly rpcRetryBaseDelayMs: number;
  private readonly strictDueDateValidation: boolean;
  private readonly now: () => number;

  constructor(
    dependenciesOrContractId: string | InvoiceEscrowContractServiceDependencies,
    logger?: AppLogger
  ) {
    if (typeof dependenciesOrContractId === "string") {
      this.contractId = sanitizeString(dependenciesOrContractId, "contractId");
      this.contract = new Contract(this.contractId);
      this.logger = logger ?? globalLogger;
      this.confirmationPollMs = 1000;
      this.confirmationAttempts = 20;
      this.maxDueDateHorizonMs = MAX_DUE_DATE_HORIZON_MS;
      this.maxStroops = MAX_STROOPS;
      this.rpcRetryAttempts = RPC_RETRY_ATTEMPTS;
      this.rpcRetryBaseDelayMs = RPC_RETRY_BASE_DELAY_MS;
      this.strictDueDateValidation = false;
      this.now = () => Date.now();
    } else {
      this.contractId = sanitizeString(dependenciesOrContractId.contractId, "contractId");
      this.contract = new Contract(this.contractId);
      this.networkPassphrase = dependenciesOrContractId.networkPassphrase;
      this.platformSecretKey = dependenciesOrContractId.platformSecretKey;
      if (dependenciesOrContractId.server) {
        this.rpcServer = dependenciesOrContractId.server;
      } else if (dependenciesOrContractId.rpcUrl) {
        this.rpcServer = new SorobanRpc.Server(dependenciesOrContractId.rpcUrl, {
          allowHttp: dependenciesOrContractId.rpcUrl.startsWith("http://"),
        });
      }
      this.logger = dependenciesOrContractId.logger ?? logger ?? globalLogger;
      this.confirmationPollMs = dependenciesOrContractId.confirmationPollMs ?? 1000;
      this.confirmationAttempts = dependenciesOrContractId.confirmationAttempts ?? 20;
      this.maxDueDateHorizonMs =
        dependenciesOrContractId.maxDueDateHorizonMs ?? MAX_DUE_DATE_HORIZON_MS;
      this.maxStroops = dependenciesOrContractId.maxStroops ?? MAX_STROOPS;
      this.rpcRetryAttempts =
        dependenciesOrContractId.rpcRetryAttempts ?? RPC_RETRY_ATTEMPTS;
      this.rpcRetryBaseDelayMs =
        dependenciesOrContractId.rpcRetryBaseDelayMs ?? RPC_RETRY_BASE_DELAY_MS;
      this.strictDueDateValidation =
        dependenciesOrContractId.strictDueDateValidation ?? false;
      this.now = dependenciesOrContractId.now ?? (() => Date.now());
    }
  }

  /**
   * Parse and validate a stroop amount. Throws a sanitized
   * {@link ServiceError} (`invalid_input`, 400) on bad input. Accepts
   * `bigint`, `number`, or numeric `string`. Numbers must be safe integers;
   * strings must parse cleanly via `BigInt`.
   */
  private parseStroopAmount(amount: bigint | number | string, fieldName = "amountStroops"): bigint {
    let parsed: bigint;
    try {
      if (typeof amount === "bigint") {
        parsed = amount;
      } else if (typeof amount === "number") {
        if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
          throw new TypeError("amount is not an integer");
        }
        parsed = BigInt(amount);
      } else if (typeof amount === "string") {
        const trimmed = amount.trim();
        if (!trimmed) {
          throw new TypeError("amount is empty");
        }
        parsed = BigInt(trimmed);
      } else {
        throw new TypeError(`unsupported amount type: ${typeof amount}`);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ServiceError(
        "invalid_input",
        `Invalid ${fieldName}: ${reason}`,
        400,
        { field: fieldName, reason },
      );
    }

    if (parsed <= 0n) {
      throw new ServiceError(
        "invalid_input",
        `${fieldName} must be positive.`,
        400,
        { field: fieldName, value: parsed.toString() },
      );
    }
    if (parsed > this.maxStroops) {
      throw new ServiceError(
        "invalid_input",
        `${fieldName} exceeds the maximum allowed value (${this.maxStroops}).`,
        400,
        { field: fieldName, value: parsed.toString(), max: this.maxStroops.toString() },
      );
    }
    return parsed;
  }

  /**
   * Validate a future-dated unix timestamp (seconds). The strict checks
   * (past date, absurd horizon) only run when
   * {@link InvoiceEscrowContractServiceDependencies.strictDueDateValidation}
   * is enabled. The shape check (finite, positive) always runs to keep the
   * build helpers crash-safe.
   */
  private parseDueDate(dueDateTimestamp: number): number {
    if (!Number.isFinite(dueDateTimestamp) || dueDateTimestamp <= 0) {
      throw new ServiceError(
        "invalid_input",
        "dueDateTimestamp must be a positive number.",
        400,
        { received: dueDateTimestamp },
      );
    }
    if (!this.strictDueDateValidation) {
      return dueDateTimestamp;
    }
    const dueMs = dueDateTimestamp * 1000;
    const nowMs = this.now();
    if (dueMs <= nowMs) {
      throw new ServiceError(
        "invalid_input",
        "dueDateTimestamp must be in the future.",
        400,
        { dueDateTimestamp, nowSeconds: Math.floor(nowMs / 1000) },
      );
    }
    if (dueMs - nowMs > this.maxDueDateHorizonMs) {
      throw new ServiceError(
        "invalid_input",
        "dueDateTimestamp is further in the future than the allowed horizon.",
        400,
        {
          dueDateTimestamp,
          horizonSeconds: Math.floor(this.maxDueDateHorizonMs / 1000),
        },
      );
    }
    return dueDateTimestamp;
  }

  /**
   * Build the Soroban contract invocation operation for creating an escrow.
   */
  public buildCreateEscrowTx(
    invoiceId: string,
    sellerAddress: string,
    amountStroops: bigint | number | string,
    dueDateTimestamp: number,
    paymentTokenAddress: string
  ): xdr.Operation {
    const safeInvoiceId = sanitizeString(invoiceId, "invoiceId");
    const safeSeller = sanitizeString(sellerAddress, "sellerAddress");
    const safeToken = sanitizeString(paymentTokenAddress, "paymentTokenAddress");

    const amountBigInt = this.parseStroopAmount(amountStroops, "amountStroops");
    this.parseDueDate(dueDateTimestamp);

    return this.contract.call(
      "create_escrow",
      nativeToScVal(safeInvoiceId, { type: "symbol" }),
      new Address(safeSeller).toScVal(),
      nativeToScVal(amountBigInt, { type: "i128" }),
      nativeToScVal(dueDateTimestamp, { type: "u64" }),
      new Address(safeToken).toScVal()
    );
  }

  /**
   * Build the Soroban contract invocation operation for funding an escrow.
   */
  public buildFundEscrowTx(
    invoiceId: string,
    investorAddress: string,
    amountStroops: bigint | number | string
  ): xdr.Operation {
    const safeInvoiceId = sanitizeString(invoiceId, "invoiceId");
    const safeInvestor = sanitizeString(investorAddress, "investorAddress");

    const amountBigInt = this.parseStroopAmount(amountStroops, "amountStroops");

    return this.contract.call(
      "fund_escrow",
      nativeToScVal(safeInvoiceId, { type: "symbol" }),
      new Address(safeInvestor).toScVal(),
      nativeToScVal(amountBigInt, { type: "i128" })
    );
  }

  /**
   * Build the Soroban contract invocation operation for recording a payment.
   */
  public buildRecordPaymentTx(
    invoiceId: string,
    payerAddress: string,
    amountStroops: bigint | number | string
  ): xdr.Operation {
    const safeInvoiceId = sanitizeString(invoiceId, "invoiceId");
    const safePayer = sanitizeString(payerAddress, "payerAddress");

    const amountBigInt = this.parseStroopAmount(amountStroops, "amountStroops");

    return this.contract.call(
      "record_payment",
      nativeToScVal(safeInvoiceId, { type: "symbol" }),
      new Address(safePayer).toScVal(),
      nativeToScVal(amountBigInt, { type: "i128" })
    );
  }

  /**
   * Build the Soroban contract invocation operation for settling an escrow.
   */
  public buildSettleEscrowTx(invoiceId: string): xdr.Operation {
    const safeInvoiceId = sanitizeString(invoiceId, "invoiceId");

    return this.contract.call("settle_escrow", nativeToScVal(safeInvoiceId, { type: "symbol" }));
  }

  /**
   * Simulates a transaction against the Soroban RPC endpoint to verify
   * resource limits and auth footprint. Transient RPC failures are retried
   * with exponential backoff + jitter before being surfaced as a
   * {@link ServiceError}.
   */
  public async simulateTransaction(
    transaction: Transaction | FeeBumpTransaction
  ): Promise<SimulateTransactionResult> {
    if (!this.rpcServer) {
      throw new ServiceError(
        "rpc_not_configured",
        "Soroban RPC server is not configured for simulation.",
        503,
      );
    }

    const simResponse = await this.withRpcRetry(
      () => this.rpcServer!.simulateTransaction(transaction),
      "simulateTransaction",
    );

    const successResponse = simResponse as unknown as {
      minResourceFee?: string;
      cost?: { cpuInsns?: string; memBytes?: string };
      results?: Array<{ auth?: xdr.SorobanAuthorizationEntry[]; xdr: string }>;
      transactionData?: xdr.SorobanTransactionData;
      error?: string;
    };

    return {
      minResourceFee: successResponse.minResourceFee ?? "0",
      cost: {
        cpuInsns: successResponse.cost?.cpuInsns ?? "0",
        memBytes: successResponse.cost?.memBytes ?? "0",
      },
      results: successResponse.results?.map((r) => ({
        auth: r.auth,
        xdr: r.xdr,
      })),
      transactionData: successResponse.transactionData,
      error: successResponse.error,
    };
  }

  /**
   * Submits a transaction to the Stellar network via Soroban RPC
   * `sendTransaction`. Transient RPC failures are retried with exponential
   * backoff + jitter before being surfaced as a {@link ServiceError}.
   */
  public async submitTransaction(
    transaction: Transaction | FeeBumpTransaction
  ): Promise<SendTransactionResult> {
    if (!this.rpcServer) {
      throw new ServiceError(
        "rpc_not_configured",
        "Soroban RPC server is not configured for submission.",
        503,
      );
    }

    const response = await this.withRpcRetry(
      () => this.rpcServer!.sendTransaction(transaction),
      "sendTransaction",
    );

    return {
      status: response.status,
      txHash: response.hash,
      errorResult: response.errorResult,
    };
  }

  /**
   * Polls for transaction confirmation until it reaches `SUCCESS`, `FAILED`,
   * or times out. Each polling cycle tolerates transient RPC errors via
   * {@link withRpcRetry}; only `NOT_FOUND` is treated as "keep polling".
   */
  public async waitForTransactionConfirmation(
    txHash: string,
  ): Promise<{ status: ConfirmationStatus; ledger: number | null }> {
    if (!this.rpcServer) {
      throw new ServiceError(
        "rpc_not_configured",
        "Soroban RPC server is not configured for transaction confirmation polling.",
        503,
      );
    }
    const safeTxHash = sanitizeString(txHash, "txHash");

    let lastLedger: number | null = null;

    for (let attempt = 0; attempt < this.confirmationAttempts; attempt++) {
      try {
        const result = await this.rpcServer.getTransaction(safeTxHash);
        const status = this.extractStatus(result);
        if (status === "SUCCESS") {
          lastLedger = "ledger" in result ? Number(result.ledger) : null;
          this.logger.info("Soroban transaction confirmed on-chain.", {
            txHash: safeTxHash,
            sorobanContractId: this.contractId,
            ledger: lastLedger,
            attempts: attempt + 1,
          });
          return { status: "SUCCESS", ledger: lastLedger };
        }
        if (status === "FAILED") {
          this.logger.error("Soroban transaction reverted on-chain.", {
            txHash: safeTxHash,
            sorobanContractId: this.contractId,
            attempts: attempt + 1,
          });
          return { status: "FAILED", ledger: null };
        }
        // NOT_FOUND: keep polling.
      } catch (error) {
        this.logger.warn("Transient error while checking transaction status", {
          txHash: safeTxHash,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
        // Transient: keep polling.
      }

      if (attempt < this.confirmationAttempts - 1) {
        await sleep(this.confirmationPollMs);
      }
    }

    this.logger.error("Timed out waiting for transaction confirmation.", {
      txHash: safeTxHash,
      sorobanContractId: this.contractId,
      attempts: this.confirmationAttempts,
    });
    throw new ServiceError(
      "transaction_confirmation_timeout",
      "Timed out waiting for transaction confirmation on-chain.",
      504,
      {
        txHash: safeTxHash,
        attempts: this.confirmationAttempts,
        pollMs: this.confirmationPollMs,
        lastLedger,
      },
    );
  }

  /**
   * Extract a normalized status from the heterogeneous response shapes
   * returned by different Soroban RPC versions.
   */
  private extractStatus(
    result: Awaited<ReturnType<SorobanRpc.Server["getTransaction"]>>,
  ): ConfirmationStatus {
    const raw = (result as { status?: unknown }).status;
    if (raw === "SUCCESS") return "SUCCESS";
    if (raw === "FAILED") return "FAILED";
    return "NOT_FOUND";
  }

  /**
   * Run an RPC call with bounded retry on transient failures. The full failure
   * is logged and wrapped in a {@link ServiceError} (`502`) once retries are
   * exhausted so callers see a stable, sanitized error code. The final
   * `error`-level log preserves the legacy messages ("Soroban simulateTransac
   * tion call failed." / "Soroban sendTransaction call failed.") so existing
   * log-based alerting keeps working.
   */
  private async withRpcRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    let lastError: unknown;
    const finalFailureMessage =
      operationName === "simulateTransaction"
        ? "Soroban simulateTransaction call failed."
        : "Soroban sendTransaction call failed.";
    const finalErrorCode =
      operationName === "simulateTransaction"
        ? "soroban_simulation_failed"
        : "soroban_submission_failed";
    const finalErrorDescription =
      operationName === "simulateTransaction"
        ? "Failed to simulate the transaction against the Soroban RPC endpoint."
        : "Failed to submit the transaction to the Soroban RPC endpoint.";

    for (let attempt = 1; attempt <= this.rpcRetryAttempts; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const isLast = attempt === this.rpcRetryAttempts;
        if (isLast) {
          this.logger.error(finalFailureMessage, {
            sorobanContractId: this.contractId,
            operation: operationName,
            attempts: attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
        this.logger.warn("Soroban RPC call failed, will retry if attempts remain", {
          operation: operationName,
          attempt,
          attemptsRemaining: this.rpcRetryAttempts - attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        const delay = jitter(this.rpcRetryBaseDelayMs * 2 ** (attempt - 1), RPC_RETRY_MAX_JITTER_MS);
        await sleep(delay);
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new ServiceError(finalErrorCode, finalErrorDescription, 502, {
      operation: operationName,
      attempts: this.rpcRetryAttempts,
      reason,
    });
  }

  /**
   * Settles an escrow on-chain by building, submitting, and waiting for confirmation
   * of the `settle_escrow` transaction.
   *
   * @param invoiceId The invoice ID to settle
   * @returns The transaction hash and ledger of the confirmed settlement
   * @throws ServiceError if RPC is not configured, submission fails, or confirmation fails/times out
   */
  public async settleEscrowOnChain(invoiceId: string): Promise<{ transactionHash: string; ledger: number | null }> {
    if (!this.rpcServer || !this.networkPassphrase || !this.platformSecretKey) {
      throw new ServiceError(
        "rpc_not_configured",
        "Soroban RPC and signer configuration is incomplete for settlement",
        503,
      );
    }

    const safeInvoiceId = sanitizeString(invoiceId, "invoiceId");
    const operation = this.contract.call("settle_escrow", nativeToScVal(safeInvoiceId, { type: "symbol" }));

    const signer = Keypair.fromSecret(this.platformSecretKey);
    const account = await this.rpcServer.getAccount(signer.publicKey());

    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const prepared = await this.rpcServer.prepareTransaction(transaction);
    prepared.sign(signer);

    const submitted = await this.withRpcRetry(
      () => this.rpcServer!.sendTransaction(prepared),
      "sendTransaction",
    );

    if (submitted.status === "ERROR") {
      throw new ServiceError(
        "on_chain_settlement_failed",
        "On-chain settlement transaction rejected",
        502,
        { errorResult: submitted.errorResult },
      );
    }

    const confirmation = await this.waitForTransactionConfirmation(submitted.hash);
    if (confirmation.status === "FAILED") {
      throw new ServiceError(
        "on_chain_settlement_failed",
        "On-chain settlement transaction failed",
        502,
        { transactionHash: submitted.hash },
      );
    }
    if (confirmation.status === "NOT_FOUND") {
      throw new ServiceError(
        "on_chain_settlement_timeout",
        "Timed out waiting for on-chain settlement confirmation",
        504,
      );
    }

    this.logger.info("Soroban escrow settled successfully on-chain.", {
      invoiceId: safeInvoiceId,
      sorobanContractId: this.contractId,
      transactionHash: submitted.hash,
      ledger: confirmation.ledger,
    });

    return { transactionHash: submitted.hash, ledger: confirmation.ledger };
  }

  /**
   * Creates/initializes an escrow on-chain and logs the structured completion
   * event.
   *
   * Note: this method builds the operation payload and emits the structured
   * log line; actual on-chain submission is performed by the caller using
   * {@link submitTransaction} + {@link waitForTransactionConfirmation}.
   * Only sanitized metadata (`invoiceId`, `sorobanContractId`,
   * `sellerAddress`, `amountStroops`) is logged — no secret keys, signing
   * seeds, or auth tokens are ever written to logs.
   */
public async createEscrowOnChain(input: CreateEscrowInput): Promise<CreateEscrowResult> {
    const amountBigInt = this.parseStroopAmount(input.amountStroops, "amountStroops");
    this.parseDueDate(input.dueDateTimestamp);

    const operation = this.buildCreateEscrowTx(
      input.invoiceId,
      input.sellerAddress,
      amountBigInt,
      input.dueDateTimestamp,
      input.paymentTokenAddress
    );

    const amountStroopsStr = amountBigInt.toString();

    this.logger.info("Soroban escrow created successfully on-chain.", {
      invoiceId: input.invoiceId,
      sorobanContractId: this.contractId,
      sellerAddress: input.sellerAddress,
      amountStroops: amountStroopsStr,
    });

    return {
      contractId: this.contractId,
      invoiceId: input.invoiceId,
      sellerAddress: input.sellerAddress,
      amountStroops: amountStroopsStr,
      operation,
    };
  }

  public buildRegisterInvoiceTx(
    invoiceId: string,
    sellerAddress: string,
    amountStroops: bigint | number | string
  ): xdr.Operation {
    const safeInvoiceId = sanitizeString(invoiceId, "invoiceId");
    const safeSeller = sanitizeString(sellerAddress, "sellerAddress");
    const amountBigInt = this.parseStroopAmount(amountStroops, "amountStroops");

    return this.contract.call(
      "register_invoice",
      nativeToScVal(safeInvoiceId, { type: "symbol" }),
      new Address(safeSeller).toScVal(),
      nativeToScVal(amountBigInt, { type: "i128" })
    );
  }

  public async executeRegisterInvoice(
    input: { invoiceId: string; sellerAddress: string; amountStroops: string | bigint | number }
  ): Promise<{ transactionHash: string; ledger: number | null }> {
    if (!this.rpcServer || !this.networkPassphrase || !this.platformSecretKey) {
      throw new ServiceError(
        "rpc_not_configured",
        "Escrow contract RPC and signer configuration is incomplete.",
        503,
      );
    }

    const safeInvoiceId = sanitizeString(input.invoiceId, "invoiceId");
    const safeSellerAddress = sanitizeString(input.sellerAddress, "sellerAddress");
    const amountBigInt = this.parseStroopAmount(input.amountStroops, "amountStroops");

    const operation = this.buildRegisterInvoiceTx(
      safeInvoiceId,
      safeSellerAddress,
      amountBigInt
    );

    let account: Awaited<ReturnType<SorobanRpc.Server["getAccount"]>>;
    try {
      const signer = Keypair.fromSecret(this.platformSecretKey);
      account = await this.rpcServer.getAccount(signer.publicKey());
    } catch (error) {
      this.logger.error("Failed to fetch Soroban account for register_invoice.", {
        sorobanContractId: this.contractId,
        invoiceId: safeInvoiceId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceError(
        "soroban_account_fetch_failed",
        "Failed to fetch Soroban account for invoice registration.",
        502,
        { invoiceId: safeInvoiceId },
      );
    }

    const signer = Keypair.fromSecret(this.platformSecretKey);
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    let prepared: Transaction;
    try {
      prepared = await this.rpcServer.prepareTransaction(transaction) as Transaction;
    } catch (error) {
      this.logger.error("Failed to prepare register_invoice transaction.", {
        sorobanContractId: this.contractId,
        invoiceId: safeInvoiceId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new ServiceError(
        "soroban_prepare_failed",
        "Failed to prepare the register_invoice transaction.",
        502,
        { invoiceId: safeInvoiceId },
      );
    }

    prepared.sign(signer);

    const submitted = await this.submitTransaction(prepared);
    if (submitted.status === "ERROR") {
      this.logger.error("register_invoice transaction rejected by Soroban RPC.", {
        sorobanContractId: this.contractId,
        invoiceId: safeInvoiceId,
        errorResult: submitted.errorResult,
      });
      throw new ServiceError(
        "soroban_register_invoice_rejected",
        "Failed to submit register_invoice transaction.",
        502,
        { invoiceId: safeInvoiceId, errorResult: submitted.errorResult },
      );
    }

    const { status, ledger } = await this.waitForTransactionConfirmation(submitted.txHash);
    if (status !== "SUCCESS") {
      this.logger.error("register_invoice transaction failed on-chain.", {
        sorobanContractId: this.contractId,
        invoiceId: safeInvoiceId,
        transactionHash: submitted.txHash,
        status,
      });
      throw new ServiceError(
        "soroban_register_invoice_failed",
        `register_invoice transaction failed on-chain: ${status}`,
        502,
        { invoiceId: safeInvoiceId, transactionHash: submitted.txHash, status },
      );
    }

    this.logger.info("Soroban invoice registered on-chain.", {
      invoiceId: safeInvoiceId,
      sorobanContractId: this.contractId,
      sellerAddress: safeSellerAddress,
      amountStroops: amountBigInt.toString(),
      transactionHash: submitted.txHash,
    });

    return { transactionHash: submitted.txHash, ledger };
  }
}
