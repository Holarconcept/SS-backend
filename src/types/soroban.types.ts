import type { xdr } from "stellar-sdk";

export interface CreateEscrowParams {
  invoiceId: string;
  sellerAddress: string;
  amountStroops: bigint | number | string;
  dueDateTimestamp: number;
  paymentTokenAddress: string;
  tokenContractAddress?: string;
  commitmentHash?: string;
  platformFeeBps?: number;
}

export interface CreateEscrowResult {
  contractId: string;
  invoiceId: string;
  sellerAddress: string;
  amountStroops: string;
  txHash?: string;
  operation: xdr.Operation;
}

export interface FundEscrowParams {
  invoiceId: string;
  investorAddress: string;
  amountStroops: bigint | number | string;
}

export interface RecordPaymentParams {
  invoiceId: string;
  amountStroops: bigint | number | string;
  payerAddress: string;
}

export interface SettleEscrowParams {
  invoiceId: string;
}

export interface SorobanContractConfig {
  rpcUrl: string;
  networkPassphrase: string;
  escrowContractId: string;
  tokenContractId?: string;
  paymentDistributorContractId?: string;
  platformSecretKey?: string;
}

export interface SorobanEventTopic {
  raw: xdr.ScVal;
  decoded: unknown;
}

export interface DecodedSorobanEvent {
  id: string;
  contractId: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: string;
  topics: unknown[];
  data: unknown;
  inSuccessfulContractCall: boolean;
}

export interface SimulateTransactionResult {
  minResourceFee: string;
  cost: {
    cpuInsns: string;
    memBytes: string;
  };
  results?: Array<{
    auth?: xdr.SorobanAuthorizationEntry[];
    xdr: string;
  }>;
  transactionData?: xdr.SorobanTransactionData;
  error?: string;
}

export interface SendTransactionResult {
  status: "PENDING" | "SUCCESS" | "ERROR" | "DUPLICATE" | "TRY_AGAIN_LATER";
  txHash: string;
  errorResult?: xdr.TransactionResult;
}
