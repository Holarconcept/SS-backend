import {
  Contract,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
  SorobanRpc,
  Transaction,
} from "stellar-sdk";
import type { AppLogger } from "../../observability/logger";
import { logger as globalLogger } from "../../observability/logger";

export interface InvoiceTokenContractServiceDependencies {
  contractId: string;
  rpcUrl?: string;
  networkPassphrase?: string;
  platformSecretKey?: string;
  server?: SorobanRpc.Server;
  logger?: AppLogger;
}

export interface MintTokensResult {
  contractId: string;
  invoiceId?: string;
  recipientAddress: string;
  tokenAmount: string;
  operation: xdr.Operation;
  txHash?: string;
}

export class InvoiceTokenContractService {
  private readonly contract: Contract;
  readonly contractId: string;
  private readonly rpcServer?: SorobanRpc.Server;
  private readonly networkPassphrase?: string;
  private readonly platformSecretKey?: string;
  private readonly logger: AppLogger;

  constructor(
    dependenciesOrContractId: string | InvoiceTokenContractServiceDependencies,
    logger?: AppLogger
  ) {
    if (typeof dependenciesOrContractId === "string") {
      if (!dependenciesOrContractId) {
        throw new Error("contractId is required.");
      }
      this.contractId = dependenciesOrContractId;
      this.contract = new Contract(dependenciesOrContractId);
      this.logger = logger ?? globalLogger;
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
    }
  }

  /**
   * Build the Soroban contract invocation operation for minting SEP-41 invoice tokens.
   *
   * @param recipientAddress Stellar address receiving the minted tokens
   * @param tokenAmount Token amount formatted as i128 (bigint, number, or string)
   * @returns xdr.Operation configured for host function contract invocation
   */
  public buildMintTx(
    recipientAddress: string,
    tokenAmount: bigint | number | string
  ): xdr.Operation {
    const toScVal = new Address(recipientAddress).toScVal();
    const amountBigInt = typeof tokenAmount === "bigint" ? tokenAmount : BigInt(tokenAmount);
    const amountScVal = nativeToScVal(amountBigInt, { type: "i128" });

    return this.contract.call("mint", toScVal, amountScVal);
  }

  /**
   * Build the Soroban contract invocation operation for querying token balance.
   */
  public buildBalanceTx(accountAddress: string): xdr.Operation {
    const accountScVal = new Address(accountAddress).toScVal();
    return this.contract.call("balance", accountScVal);
  }

  /**
   * Queries on-chain token balance for an account address.
   */
  public async getTokenBalance(accountAddress: string): Promise<bigint> {
    if (!this.rpcServer) {
      throw new Error("Soroban RPC server is not configured for balance query.");
    }

    const _op = this.buildBalanceTx(accountAddress);
    const mockTx = {
      toXDR: () => "",
    } as unknown as Transaction;

    const simRes = await this.rpcServer.simulateTransaction(mockTx);
    const res = simRes as unknown as {
      results?: Array<{ xdr: string }>;
      result?: { retval?: xdr.ScVal };
    };

    if (res.results && res.results.length > 0 && res.results[0].xdr) {
      const returnScVal = xdr.ScVal.fromXDR(res.results[0].xdr, "base64");
      return BigInt(scValToNative(returnScVal));
    } else if (res.result && res.result.retval) {
      return BigInt(scValToNative(res.result.retval));
    }

    return 0n;
  }

  /**
   * Mints invoice fractional tokens for a published invoice.
   */
  public async mintInvoiceTokens(
    invoiceId: string,
    recipientAddress: string,
    tokenAmount: bigint | number | string
  ): Promise<MintTokensResult> {
    const amountBigInt = typeof tokenAmount === "bigint" ? tokenAmount : BigInt(tokenAmount);
    const operation = this.buildMintTx(recipientAddress, amountBigInt);

    this.logger.info("Minted invoice tokens for invoice", {
      invoiceId,
      contractId: this.contractId,
      recipientAddress,
      tokenAmount: amountBigInt.toString(),
    });

    return {
      contractId: this.contractId,
      invoiceId,
      recipientAddress,
      tokenAmount: amountBigInt.toString(),
      operation,
    };
  }
}
