import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { InvoiceTokenContractService } from "../../../../src/services/stellar/invoice-token-contract.service";

describe("InvoiceTokenContractService - buildMintTx", () => {
  const TOKEN_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const TEST_RECIPIENT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

  let service: InvoiceTokenContractService;

  beforeEach(() => {
    service = new InvoiceTokenContractService(TOKEN_CONTRACT_ID);
  });

  it("should initialize with correct contract ID", () => {
    expect(service.contractId).toBe(TOKEN_CONTRACT_ID);
  });

  it("should throw an error when contractId is empty", () => {
    expect(() => new InvoiceTokenContractService("")).toThrow("contractId is required.");
  });

  it("should construct a valid InvokeHostFunction operation", () => {
    const tokenAmount = 50_000_000n;
    const op = service.buildMintTx(TEST_RECIPIENT, tokenAmount);

    expect(op).toBeDefined();
    const opBody = op.body();
    expect(opBody.switch().name).toBe("invokeHostFunction");
  });

  it("should target the exact configured TOKEN_CONTRACT_ID", () => {
    const tokenAmount = 100_000n;
    const op = service.buildMintTx(TEST_RECIPIENT, tokenAmount);

    const invokeHostFunctionOp = op.body().invokeHostFunctionOp();
    const hostFunction = invokeHostFunctionOp.hostFunction();

    expect(hostFunction.switch().name).toBe("hostFunctionTypeInvokeContract");

    const invokeContractArgs = hostFunction.invokeContract();
    const contractAddressScVal = invokeContractArgs.contractAddress();
    const contractAddress = Address.fromScAddress(contractAddressScVal).toString();

    expect(contractAddress).toBe(TOKEN_CONTRACT_ID);
  });

  it("should serialize the mint function name and ScVal arguments properly", () => {
    const tokenAmount = 750_000n;
    const op = service.buildMintTx(TEST_RECIPIENT, tokenAmount);

    const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

    // Verify function name
    const functionName = invokeContractArgs.functionName().toString();
    expect(functionName).toBe("mint");

    // Verify args length: [recipient, amount]
    const args = invokeContractArgs.args();
    expect(args).toHaveLength(2);

    // Verify recipient Address ScVal serialization
    const recipientScVal = args[0];
    expect(Address.fromScVal(recipientScVal).toString()).toBe(TEST_RECIPIENT);

    // Verify token amount i128 ScVal serialization
    const amountScVal = args[1];
    expect(amountScVal.switch().name).toBe("scvI128");
    const nativeAmount = scValToNative(amountScVal);
    expect(BigInt(nativeAmount)).toBe(tokenAmount);
  });

  it("should accept bigint, number, and string token amounts", () => {
    const amountFromBigInt = service.buildMintTx(TEST_RECIPIENT, 1_000_000n);
    const amountFromNumber = service.buildMintTx(TEST_RECIPIENT, 1_000_000);
    const amountFromString = service.buildMintTx(TEST_RECIPIENT, "1000000");

    const getAmount = (operation: xdr.Operation) => {
      const args = operation.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
      return BigInt(scValToNative(args[1]));
    };

    expect(getAmount(amountFromBigInt)).toBe(1_000_000n);
    expect(getAmount(amountFromNumber)).toBe(1_000_000n);
    expect(getAmount(amountFromString)).toBe(1_000_000n);
  });

  it("should handle boundary amounts such as zero and large 128-bit values", () => {
    const zeroAmount = 0n;
    const largeAmount = 18446744073709551615000000n;

    const opZero = service.buildMintTx(TEST_RECIPIENT, zeroAmount);
    const opLarge = service.buildMintTx(TEST_RECIPIENT, largeAmount);

    const getAmount = (operation: xdr.Operation) => {
      const args = operation.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
      return BigInt(scValToNative(args[1]));
    };

    expect(getAmount(opZero)).toBe(zeroAmount);
    expect(getAmount(opLarge)).toBe(largeAmount);
  });

  it("should reject invalid recipient Stellar address strings", () => {
    expect(() => service.buildMintTx("INVALID_STELLAR_ADDRESS", 1000n)).toThrow();
  });

  describe("mintInvoiceTokens", () => {
    it("should build and return structured mint result", async () => {
      const result = await service.mintInvoiceTokens("INV-123", TEST_RECIPIENT, 500_000n);

      expect(result.invoiceId).toBe("INV-123");
      expect(result.contractId).toBe(TOKEN_CONTRACT_ID);
      expect(result.recipientAddress).toBe(TEST_RECIPIENT);
      expect(result.tokenAmount).toBe("500000");
      expect(result.operation).toBeDefined();
    });
  });

  describe("buildBalanceTx & getTokenBalance", () => {
    it("should construct valid balance host function invocation", () => {
      const op = service.buildBalanceTx(TEST_RECIPIENT);
      const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();

      expect(invokeContractArgs.functionName().toString()).toBe("balance");
      const args = invokeContractArgs.args();
      expect(args).toHaveLength(1);
      expect(Address.fromScVal(args[0]).toString()).toBe(TEST_RECIPIENT);
    });

    it("should simulate balance query with RPC server", async () => {
      const mockServer = {
        simulateTransaction: jest.fn().mockResolvedValue({
          results: [{ xdr: nativeToScVal(12345n, { type: "i128" }).toXDR("base64") }],
        }),
      } as any;

      const rpcTokenService = new InvoiceTokenContractService({
        contractId: TOKEN_CONTRACT_ID,
        server: mockServer,
      });

      const balance = await rpcTokenService.getTokenBalance(TEST_RECIPIENT);
      expect(balance).toBe(12345n);
    });
  });
});
