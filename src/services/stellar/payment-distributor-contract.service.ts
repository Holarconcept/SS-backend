import {
  Contract,
  Address,
  nativeToScVal,
  xdr,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { AppLogger } from "../../observability/logger";
import { logger as globalLogger } from "../../observability/logger";
import { ServiceError } from "../../utils/service-error";
import { mapSorobanError } from "./soroban-error-mapper";

/**
 * A single payout leg: an on-chain destination and the amount (in stroops)
 * it should receive out of a settlement's proceeds.
 */
export interface PayoutRecipient {
  address: string;
  amountStroops: bigint | number | string;
}

export interface PaymentDistributorContractServiceDependencies {
  contractId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  platformSecretKey?: string;
  server?: SorobanRpc.Server;
  logger?: AppLogger;
  verifyDistributorWiring?: () => Promise<boolean>;
  confirmationPollMs?: number;
  confirmationAttempts?: number;
}

export interface DistributePayoutsInput {
  invoiceId: string;
  recipients: PayoutRecipient[];
  totalAmountStroops: bigint;
  feeRecipient: string;
  feeBps: number;
}

export interface DistributePayoutsResult {
  transactionHash: string;
  ledger: number | null;
}

const MAX_FEE_BPS = 10_000;

/**
 * Encodes Soroban contract calls for the on-chain payment distributor
 * contract, which fans a settlement's proceeds out across sellers,
 * investors, and the platform fee account in a single transaction.
 *
 * Minimal implementation covering `buildDistributePayoutsTx` only (#156).
 * `createEscrowOnChain`-style orchestration (structured completion logging,
 * simulate/submit helpers) intentionally mirrors
 * `InvoiceEscrowContractService`'s shape so a fuller implementation can be
 * layered on without a breaking change to this constructor/method surface.
 */
export class PaymentDistributorContractService {
  private readonly contract: Contract;
  readonly contractId: string;
  private readonly rpcServer?: SorobanRpc.Server;
  private readonly networkPassphrase?: string;
  private readonly platformSecretKey?: string;
  private readonly logger: AppLogger;
  private readonly verifyDistributorWiring?: () => Promise<boolean>;
  private readonly confirmationPollMs: number;
  private readonly confirmationAttempts: number;

  constructor(
    dependenciesOrContractId: string | PaymentDistributorContractServiceDependencies,
    logger?: AppLogger
  ) {
    if (typeof dependenciesOrContractId === "string") {
      if (!dependenciesOrContractId) {
        throw new Error("contractId is required.");
      }
      this.contractId = dependenciesOrContractId;
      this.contract = new Contract(dependenciesOrContractId);
      this.logger = logger ?? globalLogger;
      this.confirmationPollMs = 1000;
      this.confirmationAttempts = 20;
    } else {
      if (!dependenciesOrContractId.contractId) {
        throw new Error("contractId is required.");
      }
      this.contractId = dependenciesOrContractId.contractId;
      this.contract = new Contract(dependenciesOrContractId.contractId);
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
      this.verifyDistributorWiring = dependenciesOrContractId.verifyDistributorWiring;
      this.confirmationPollMs = dependenciesOrContractId.confirmationPollMs ?? 1000;
      this.confirmationAttempts = dependenciesOrContractId.confirmationAttempts ?? 20;
    }
  }

  /**
   * Builds the Soroban contract invocation operation for fanning a
   * settlement's proceeds out to every recipient (sellers, investors) plus
   * the platform fee account, in a single `distribute_payouts` call.
   *
   * @param invoiceId The settled invoice this distribution is for.
   * @param recipients Non-empty list of (address, amountStroops) payout legs.
   * @param platformFeeAccount The platform's fee-collection Stellar address.
   * @param feeBps Platform fee in basis points (0-10000) applied on-chain.
   *
   * @throws if recipients is empty, or feeBps is not an integer in [0, 10000].
   */
  public buildDistributePayoutsTx(
    invoiceId: string,
    recipients: PayoutRecipient[],
    platformFeeAccount: string,
    feeBps: number
  ): xdr.Operation {
    if (recipients.length === 0) {
      throw new Error("At least one payout recipient is required.");
    }
    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) {
      throw new Error(`feeBps must be an integer between 0 and ${MAX_FEE_BPS}.`);
    }

    const recipientAddressesScVal = xdr.ScVal.scvVec(
      recipients.map((recipient) => new Address(recipient.address).toScVal())
    );

    const recipientAmountsScVal = xdr.ScVal.scvVec(
      recipients.map((recipient) => {
        const amountBigInt =
          typeof recipient.amountStroops === "bigint"
            ? recipient.amountStroops
            : BigInt(recipient.amountStroops);
        return nativeToScVal(amountBigInt, { type: "i128" });
      })
    );

    return this.contract.call(
      "distribute_payouts",
      nativeToScVal(invoiceId, { type: "symbol" }),
      recipientAddressesScVal,
      recipientAmountsScVal,
      new Address(platformFeeAccount).toScVal(),
      nativeToScVal(feeBps, { type: "u32" })
    );
  }

  public async distributePayouts(input: DistributePayoutsInput): Promise<DistributePayoutsResult> {
    if (!this.rpcServer || !this.networkPassphrase || !this.platformSecretKey) {
      throw new Error("Payment distributor RPC and signer configuration is incomplete.");
    }
    if (this.verifyDistributorWiring && !(await this.verifyDistributorWiring())) {
      throw new Error("Payment distributor is not initialized on the invoice escrow contract.");
    }
    const recipientTotal = input.recipients.reduce(
      (sum, recipient) => sum + BigInt(recipient.amountStroops),
      0n
    );
    const fee = (input.totalAmountStroops * BigInt(input.feeBps)) / 10_000n;
    if (recipientTotal + fee > input.totalAmountStroops) {
      throw new Error("Payout recipients and protocol fee exceed the settlement total.");
    }

    const signer = Keypair.fromSecret(this.platformSecretKey);
    const account = await this.rpcServer.getAccount(signer.publicKey());
    const transaction = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.buildDistributePayoutsTx(
          input.invoiceId,
          input.recipients,
          input.feeRecipient,
          input.feeBps
        )
      )
      .setTimeout(30)
      .build();
    const prepared = await this.rpcServer.prepareTransaction(transaction);
    prepared.sign(signer);

    // Submit and map Soroban RPC errors to ServiceError with retryability
    try {
      const submitted = (await this.rpcServer.sendTransaction(prepared)) as SorobanRpc.Api.SendTransactionResponse;
      if (submitted.status === "ERROR") {
        // Map to a ServiceError (non-retryable transaction rejection)
        throw mapSorobanError(submitted, {
          contractId: this.contractId,
        }).error;
      }

      for (let attempt = 0; attempt < this.confirmationAttempts; attempt++) {
        const result = (await this.rpcServer.getTransaction(submitted.hash)) as SorobanRpc.Api.GetTransactionResponse;
        if (result.status === "SUCCESS") {
          this.logger.info("Payment distribution confirmed on-chain.", {
            invoice_id: input.invoiceId,
            transaction_hash: submitted.hash,
          });
          return {
            transactionHash: submitted.hash,
            ledger: "ledger" in result ? Number(result.ledger) : null,
          };
        }
        if (result.status === "FAILED") {
          throw new ServiceError(
            "soroban_tx_reverted",
            "Payment distribution transaction reverted on-chain.",
            422,
            { contractId: this.contractId }
          );
        }
        await new Promise((resolve) => setTimeout(resolve, this.confirmationPollMs));
      }
      throw new Error("Timed out waiting for payment distribution confirmation.");
    } catch (err) {
      // If it's already a ServiceError, rethrow; otherwise map and throw a sanitized ServiceError
      if (err instanceof ServiceError || (err instanceof Error && err.name === "ServiceError"))
        throw err;
      const mapped = mapSorobanError(err, {
        contractId: this.contractId,
        invoiceId: input.invoiceId,
      });
      throw mapped.error;
    }
  }
}
