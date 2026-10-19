import { Account, Keypair } from "stellar-sdk";
import { PaymentDistributorContractService } from "../../../../src/services/stellar/payment-distributor-contract.service";

describe("PaymentDistributorContractService settlement execution", () => {
  const contractId = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const signer = Keypair.random();
  const recipient = Keypair.random().publicKey();
  const feeRecipient = Keypair.random().publicKey();

  function createRpc(status: "SUCCESS" | "FAILED" = "SUCCESS") {
    return {
      getAccount: jest.fn().mockResolvedValue(new Account(signer.publicKey(), "1")),
      prepareTransaction: jest.fn().mockImplementation(async (tx) => tx),
      sendTransaction: jest.fn().mockResolvedValue({ status: "PENDING", hash: "tx-hash" }),
      getTransaction: jest.fn().mockResolvedValue({ status, ledger: 77 }),
    } as any;
  }

  it("submits and waits for successful ledger confirmation", async () => {
    const service = new PaymentDistributorContractService({
      contractId,
      server: createRpc(),
      networkPassphrase: "Test SDF Network ; September 2015",
      platformSecretKey: signer.secret(),
      verifyDistributorWiring: async () => true,
      confirmationPollMs: 0,
      confirmationAttempts: 2,
    });
    await expect(
      service.distributePayouts({
        invoiceId: "INV-1",
        totalAmountStroops: 1_000n,
        feeRecipient,
        feeBps: 250,
        recipients: [{ address: recipient, amountStroops: 975n }],
      })
    ).resolves.toEqual({ transactionHash: "tx-hash", ledger: 77 });
  });

  it("stops without settlement when wiring is not initialized", async () => {
    const service = new PaymentDistributorContractService({
      contractId,
      server: createRpc(),
      networkPassphrase: "Test SDF Network ; September 2015",
      platformSecretKey: signer.secret(),
      verifyDistributorWiring: async () => false,
    });
    await expect(
      service.distributePayouts({
        invoiceId: "INV-1",
        totalAmountStroops: 1_000n,
        feeRecipient,
        feeBps: 250,
        recipients: [{ address: recipient, amountStroops: 975n }],
      })
    ).rejects.toThrow("not initialized");
  });

  it("surfaces a reverted transaction", async () => {
    const service = new PaymentDistributorContractService({
      contractId,
      server: createRpc("FAILED"),
      networkPassphrase: "Test SDF Network ; September 2015",
      platformSecretKey: signer.secret(),
      confirmationPollMs: 0,
    });
    await expect(
      service.distributePayouts({
        invoiceId: "INV-1",
        totalAmountStroops: 1_000n,
        feeRecipient,
        feeBps: 250,
        recipients: [{ address: recipient, amountStroops: 975n }],
      })
    ).rejects.toThrow("reverted");
  });
});
