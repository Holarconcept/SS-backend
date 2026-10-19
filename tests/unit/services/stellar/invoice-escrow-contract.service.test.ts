import { Address, scValToNative } from "stellar-sdk";
import { InvoiceEscrowContractService } from "../../../../src/services/stellar/invoice-escrow-contract.service";
import type { AppLogger } from "../../../../src/observability/logger";
import { ServiceError } from "../../../../src/utils/service-error";

describe("InvoiceEscrowContractService", () => {
  const ESCROW_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const TEST_SELLER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
  const TEST_TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const TEST_INVOICE_ID = "INV-2026-001";
  const TEST_AMOUNT_STROOPS = 500_000_000n;
  const TEST_DUE_DATE = 1770000000;

  let mockLogger: AppLogger;
  let service: InvoiceEscrowContractService;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    };

    service = new InvoiceEscrowContractService({
      contractId: ESCROW_CONTRACT_ID,
      logger: mockLogger,
    });
  });

  describe("Constructor & Initialization", () => {
    it("should initialize correctly with options object", () => {
      expect(service.contractId).toBe(ESCROW_CONTRACT_ID);
    });

    it("should initialize correctly with string contract ID", () => {
      const stringInitService = new InvoiceEscrowContractService(ESCROW_CONTRACT_ID, mockLogger);
      expect(stringInitService.contractId).toBe(ESCROW_CONTRACT_ID);
    });

    it("should throw error if contractId is empty", () => {
      expect(() => new InvoiceEscrowContractService("")).toThrow("contractId is required.");
      expect(() => new InvoiceEscrowContractService({ contractId: "" })).toThrow(
        "contractId is required."
      );
      expect(
        () => new InvoiceEscrowContractService({ contractId: "" }),
      ).toThrow("contractId is required.");
      expect(
        () => new InvoiceEscrowContractService({ contractId: "   " }),
      ).toThrow("contractId is required.");
    });
  });

  describe("buildCreateEscrowTx", () => {
    it("should construct valid create_escrow host function invocation", () => {
      const op = service.buildCreateEscrowTx(
        TEST_INVOICE_ID,
        TEST_SELLER,
        TEST_AMOUNT_STROOPS,
        TEST_DUE_DATE,
        TEST_TOKEN
      );

      expect(op.body().switch().name).toBe("invokeHostFunction");
      const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

      expect(invokeContractArgs.functionName().toString()).toBe("create_escrow");

      const args = invokeContractArgs.args();
      expect(args).toHaveLength(5);

      // Argument 0: invoiceId (Symbol)
      expect(scValToNative(args[0])).toBe(TEST_INVOICE_ID);

      // Argument 1: sellerAddress (Address)
      expect(Address.fromScVal(args[1]).toString()).toBe(TEST_SELLER);

      // Argument 2: amount (i128)
      expect(BigInt(scValToNative(args[2]))).toBe(TEST_AMOUNT_STROOPS);

      // Argument 3: dueDate (u64)
      expect(Number(scValToNative(args[3]))).toBe(TEST_DUE_DATE);

      // Argument 4: paymentTokenAddress (Address)
      expect(Address.fromScVal(args[4]).toString()).toBe(TEST_TOKEN);
    });

    it("validates required inputs for buildCreateEscrowTx", () => {
      expect(() =>
        service.buildCreateEscrowTx("", TEST_SELLER, TEST_AMOUNT_STROOPS, TEST_DUE_DATE, TEST_TOKEN),
      ).toThrow("invoiceId is required.");

      expect(() =>
        service.buildCreateEscrowTx(TEST_INVOICE_ID, "", TEST_AMOUNT_STROOPS, TEST_DUE_DATE, TEST_TOKEN),
      ).toThrow("sellerAddress is required.");

      expect(() =>
        service.buildCreateEscrowTx(TEST_INVOICE_ID, TEST_SELLER, 0n, TEST_DUE_DATE, TEST_TOKEN),
      ).toThrow("amountStroops must be positive.");

      expect(() =>
        service.buildCreateEscrowTx(TEST_INVOICE_ID, TEST_SELLER, -100n, TEST_DUE_DATE, TEST_TOKEN),
      ).toThrow("amountStroops must be positive.");

      expect(() =>
        service.buildCreateEscrowTx(TEST_INVOICE_ID, TEST_SELLER, TEST_AMOUNT_STROOPS, 0, TEST_TOKEN),
      ).toThrow("dueDateTimestamp must be a positive number.");

      expect(() =>
        service.buildCreateEscrowTx(TEST_INVOICE_ID, TEST_SELLER, TEST_AMOUNT_STROOPS, TEST_DUE_DATE, ""),
      ).toThrow("paymentTokenAddress is required.");
    });
  });

  describe("createEscrowOnChain - Structured Logging", () => {
    it("should record a structured log entry on escrow creation success", async () => {
      const result = await service.createEscrowOnChain({
        invoiceId: TEST_INVOICE_ID,
        sellerAddress: TEST_SELLER,
        amountStroops: TEST_AMOUNT_STROOPS,
        dueDateTimestamp: TEST_DUE_DATE,
        paymentTokenAddress: TEST_TOKEN,
      });

      expect(result).toBeDefined();
      expect(result.contractId).toBe(ESCROW_CONTRACT_ID);
      expect(result.invoiceId).toBe(TEST_INVOICE_ID);
      expect(result.sellerAddress).toBe(TEST_SELLER);
      expect(result.amountStroops).toBe(TEST_AMOUNT_STROOPS.toString());

      // Verify logger.info was called with exact structured metadata
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Soroban escrow created successfully on-chain.",
        {
          invoiceId: TEST_INVOICE_ID,
          sorobanContractId: ESCROW_CONTRACT_ID,
          sellerAddress: TEST_SELLER,
          amountStroops: TEST_AMOUNT_STROOPS.toString(),
        }
      );
    });

    it("should never leak secret keys or sensitive tokens into logs", async () => {
      const secretLikeToken = "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

      await service.createEscrowOnChain({
        invoiceId: TEST_INVOICE_ID,
        sellerAddress: TEST_SELLER,
        amountStroops: "1000000",
        dueDateTimestamp: TEST_DUE_DATE,
        paymentTokenAddress: TEST_TOKEN,
      });

      const logCalls = (mockLogger.info as jest.Mock).mock.calls;
      expect(logCalls.length).toBeGreaterThan(0);

      const loggedMetadata = logCalls[0][1];
      const metadataString = JSON.stringify(loggedMetadata);

      expect(metadataString).not.toContain(secretLikeToken);
      expect(loggedMetadata).toEqual({
        invoiceId: TEST_INVOICE_ID,
        sorobanContractId: ESCROW_CONTRACT_ID,
        sellerAddress: TEST_SELLER,
        amountStroops: "1000000",
      });
    });
  });

  describe("buildFundEscrowTx", () => {
    it("should construct valid fund_escrow host function invocation", () => {
      const op = service.buildFundEscrowTx(TEST_INVOICE_ID, TEST_SELLER, TEST_AMOUNT_STROOPS);
      expect(op.body().switch().name).toBe("invokeHostFunction");
      const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

      expect(invokeContractArgs.functionName().toString()).toBe("fund_escrow");
      const args = invokeContractArgs.args();
      expect(args).toHaveLength(3);
      expect(scValToNative(args[0])).toBe(TEST_INVOICE_ID);
      expect(Address.fromScVal(args[1]).toString()).toBe(TEST_SELLER);
      expect(BigInt(scValToNative(args[2]))).toBe(TEST_AMOUNT_STROOPS);
    });

    it("validates required inputs for buildFundEscrowTx", () => {
      expect(() => service.buildFundEscrowTx("", TEST_SELLER, TEST_AMOUNT_STROOPS)).toThrow(
        "invoiceId is required.",
      );
      expect(() => service.buildFundEscrowTx(TEST_INVOICE_ID, "", TEST_AMOUNT_STROOPS)).toThrow(
        "investorAddress is required.",
      );
      expect(() => service.buildFundEscrowTx(TEST_INVOICE_ID, TEST_SELLER, 0n)).toThrow(
        "amountStroops must be positive.",
      );
    });
  });

  describe("buildRecordPaymentTx", () => {
    it("should construct valid record_payment host function invocation", () => {
      const op = service.buildRecordPaymentTx(TEST_INVOICE_ID, TEST_SELLER, TEST_AMOUNT_STROOPS);
      const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

      expect(invokeContractArgs.functionName().toString()).toBe("record_payment");
      const args = invokeContractArgs.args();
      expect(args).toHaveLength(3);
      expect(scValToNative(args[0])).toBe(TEST_INVOICE_ID);
    });

    it("validates required inputs for buildRecordPaymentTx", () => {
      expect(() => service.buildRecordPaymentTx("", TEST_SELLER, TEST_AMOUNT_STROOPS)).toThrow(
        "invoiceId is required.",
      );
      expect(() => service.buildRecordPaymentTx(TEST_INVOICE_ID, "", TEST_AMOUNT_STROOPS)).toThrow(
        "payerAddress is required.",
      );
      expect(() => service.buildRecordPaymentTx(TEST_INVOICE_ID, TEST_SELLER, -5n)).toThrow(
        "amountStroops must be positive.",
      );
    });
  });

  describe("buildSettleEscrowTx", () => {
    it("should construct valid settle_escrow host function invocation", () => {
      const op = service.buildSettleEscrowTx(TEST_INVOICE_ID);
      const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

      expect(invokeContractArgs.functionName().toString()).toBe("settle_escrow");
      const args = invokeContractArgs.args();
      expect(args).toHaveLength(1);
      expect(scValToNative(args[0])).toBe(TEST_INVOICE_ID);
    });

    it("validates required inputs for buildSettleEscrowTx", () => {
      expect(() => service.buildSettleEscrowTx("")).toThrow("invoiceId is required.");
    });
  });

  describe("RPC simulation and submission", () => {
    it("should simulate transaction via RPC server", async () => {
      const mockServer = {
        simulateTransaction: jest.fn().mockResolvedValue({
          minResourceFee: "100",
          cost: { cpuInsns: "1000", memBytes: "2000" },
          results: [{ xdr: "AAAA==" }],
        }),
      } as any;

      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
      });

      const res = await rpcService.simulateTransaction({} as any);
      expect(res.minResourceFee).toBe("100");
      expect(mockServer.simulateTransaction).toHaveBeenCalled();
    });

    it("should submit transaction via RPC server", async () => {
      const mockServer = {
        sendTransaction: jest.fn().mockResolvedValue({
          status: "PENDING",
          hash: "abc123hash",
        }),
      } as any;

      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
      });

      const res = await rpcService.submitTransaction({} as any);
      expect(res.status).toBe("PENDING");
      expect(res.txHash).toBe("abc123hash");
    });

    it("wraps a simulateTransaction RPC failure in a ServiceError and logs it", async () => {
      const mockServer = {
        simulateTransaction: jest.fn().mockRejectedValue(new Error("ECONNRESET")),
      } as any;

      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
      });

      await expect(rpcService.simulateTransaction({} as any)).rejects.toBeInstanceOf(
        ServiceError,
      );
      await expect(rpcService.simulateTransaction({} as any)).rejects.toMatchObject({
        code: "soroban_simulation_failed",
        statusCode: 502,
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Soroban simulateTransaction call failed.",
        expect.objectContaining({ sorobanContractId: ESCROW_CONTRACT_ID }),
      );
    });

    it("wraps a submitTransaction RPC failure in a ServiceError and logs it", async () => {
      const mockServer = {
        sendTransaction: jest.fn().mockRejectedValue(new Error("timeout")),
      } as any;

      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
      });

      await expect(rpcService.submitTransaction({} as any)).rejects.toBeInstanceOf(ServiceError);
      await expect(rpcService.submitTransaction({} as any)).rejects.toMatchObject({
        code: "soroban_submission_failed",
        statusCode: 502,
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Soroban sendTransaction call failed.",
        expect.objectContaining({ sorobanContractId: ESCROW_CONTRACT_ID }),
      );
    });
  });

  describe("waitForTransactionConfirmation", () => {
    it("polls and returns SUCCESS on successful on-chain confirmation", async () => {
      const mockServer = {
        getTransaction: jest.fn().mockResolvedValue({
          status: "SUCCESS",
          ledger: "12345",
        }),
      } as any;

      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
        confirmationPollMs: 1,
        confirmationAttempts: 3,
      });

      const result = await rpcService.waitForTransactionConfirmation("hash-123");
      expect(result.status).toBe("SUCCESS");
      expect(result.ledger).toBe(12345);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Soroban transaction confirmed on-chain.",
        expect.objectContaining({ txHash: "hash-123", ledger: 12345 }),
      );
    });

    it("returns FAILED when transaction reverts on-chain", async () => {
      const mockServer = {
        getTransaction: jest.fn().mockResolvedValue({
          status: "FAILED",
        }),
      } as any;

      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
        confirmationPollMs: 1,
        confirmationAttempts: 3,
      });

      const result = await rpcService.waitForTransactionConfirmation("hash-failed");
      expect(result.status).toBe("FAILED");
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Soroban transaction reverted on-chain.",
        expect.objectContaining({ txHash: "hash-failed" }),
      );
    });

    it("throws ServiceError 504 on confirmation timeout", async () => {
      const mockServer = {
        getTransaction: jest.fn().mockResolvedValue({
          status: "NOT_FOUND",
        }),
      } as any;

      const rpcService = new InvoiceEscrowContractService({
        contractId: ESCROW_CONTRACT_ID,
        server: mockServer,
        logger: mockLogger,
        confirmationPollMs: 1,
        confirmationAttempts: 2,
      });

      await expect(rpcService.waitForTransactionConfirmation("hash-timeout")).rejects.toBeInstanceOf(
        ServiceError,
      );
      await expect(rpcService.waitForTransactionConfirmation("hash-timeout")).rejects.toMatchObject({
        code: "transaction_confirmation_timeout",
        statusCode: 504,
      });
    });
  });
});
