import { Address, Keypair, scValToNative } from "@stellar/stellar-sdk";
import {
  PaymentDistributorContractService,
  PayoutRecipient,
} from "../../../../src/services/stellar/payment-distributor-contract.service";

describe("PaymentDistributorContractService.buildDistributePayoutsTx (Issue #156)", () => {
  // A known-valid contract StrKey, reused from the existing
  // invoice-escrow-contract.service.test.ts fixtures.
  const PAYMENT_DISTRIBUTOR_CONTRACT_ID =
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  const SELLER_ADDRESS = Keypair.random().publicKey();
  const INVESTOR_A_ADDRESS = Keypair.random().publicKey();
  const INVESTOR_B_ADDRESS = Keypair.random().publicKey();
  const PLATFORM_FEE_ACCOUNT = Keypair.random().publicKey();
  const INVOICE_ID = "INV-2026-900";

  let service: PaymentDistributorContractService;

  beforeEach(() => {
    service = new PaymentDistributorContractService(PAYMENT_DISTRIBUTOR_CONTRACT_ID);
  });

  const singleRecipient: PayoutRecipient[] = [
    { address: SELLER_ADDRESS, amountStroops: 500_000_000n },
  ];

  it("initializes with the configured payment distributor contract ID", () => {
    expect(service.contractId).toBe(PAYMENT_DISTRIBUTOR_CONTRACT_ID);
  });

  it("throws when constructed without a contractId", () => {
    expect(() => new PaymentDistributorContractService("")).toThrow("contractId is required.");
  });

  it("invokes exactly the configured PAYMENT_DISTRIBUTOR_CONTRACT_ID, not some other address", () => {
    const op = service.buildDistributePayoutsTx(
      INVOICE_ID,
      singleRecipient,
      PLATFORM_FEE_ACCOUNT,
      250
    );

    const invokeContractArgs = op.body().invokeHostFunctionOp().hostFunction().invokeContract();
    const invokedContractId = Address.fromScAddress(
      invokeContractArgs.contractAddress()
    ).toString();

    expect(invokedContractId).toBe(PAYMENT_DISTRIBUTOR_CONTRACT_ID);
    expect(invokedContractId).toBe(service.contractId);
  });

  it("encodes the method name as distribute_payouts", () => {
    const op = service.buildDistributePayoutsTx(
      INVOICE_ID,
      singleRecipient,
      PLATFORM_FEE_ACCOUNT,
      250
    );

    const functionName = op
      .body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract()
      .functionName()
      .toString();

    expect(functionName).toBe("distribute_payouts");
  });

  it("fans a single payout out to seller, investors, and the platform fee account", () => {
    const recipients: PayoutRecipient[] = [
      { address: SELLER_ADDRESS, amountStroops: 300_000_000n },
      { address: INVESTOR_A_ADDRESS, amountStroops: 150_000_000n },
      { address: INVESTOR_B_ADDRESS, amountStroops: 50_000_000n },
    ];

    const op = service.buildDistributePayoutsTx(INVOICE_ID, recipients, PLATFORM_FEE_ACCOUNT, 250);

    const args = op.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
    expect(args).toHaveLength(5);

    // arg 0: invoiceId (symbol)
    expect(args[0].switch().name).toBe("scvSymbol");
    expect(scValToNative(args[0])).toBe(INVOICE_ID);

    // arg 1: recipient addresses (Vec<Address>), in the given order
    expect(args[1].switch().name).toBe("scvVec");
    const addressVals = args[1].vec() ?? [];
    expect(addressVals.map((v) => Address.fromScVal(v).toString())).toEqual([
      SELLER_ADDRESS,
      INVESTOR_A_ADDRESS,
      INVESTOR_B_ADDRESS,
    ]);

    // arg 2: recipient amounts (Vec<i128>), positionally matching the addresses
    expect(args[2].switch().name).toBe("scvVec");
    const amountVals = args[2].vec() ?? [];
    expect(amountVals.map((v) => BigInt(scValToNative(v)))).toEqual([
      300_000_000n,
      150_000_000n,
      50_000_000n,
    ]);

    // arg 3: platform fee account (Address)
    expect(args[3].switch().name).toBe("scvAddress");
    expect(Address.fromScVal(args[3]).toString()).toBe(PLATFORM_FEE_ACCOUNT);
  });

  describe("feeBps serialization", () => {
    it("serializes feeBps as a u32 argument matching the given value", () => {
      const op = service.buildDistributePayoutsTx(
        INVOICE_ID,
        singleRecipient,
        PLATFORM_FEE_ACCOUNT,
        250
      );

      const args = op.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
      const feeBpsArg = args[4];

      expect(feeBpsArg.switch().name).toBe("scvU32");
      expect(scValToNative(feeBpsArg)).toBe(250);
    });

    it.each([0, 1, 100, 9_999, 10_000])("round-trips feeBps=%i exactly", (feeBps) => {
      const op = service.buildDistributePayoutsTx(
        INVOICE_ID,
        singleRecipient,
        PLATFORM_FEE_ACCOUNT,
        feeBps
      );
      const args = op.body().invokeHostFunctionOp().hostFunction().invokeContract().args();
      expect(scValToNative(args[4])).toBe(feeBps);
    });

    it("rejects feeBps above 10000 (100%)", () => {
      expect(() =>
        service.buildDistributePayoutsTx(INVOICE_ID, singleRecipient, PLATFORM_FEE_ACCOUNT, 10_001)
      ).toThrow("feeBps must be an integer between 0 and 10000.");
    });

    it("rejects a negative feeBps", () => {
      expect(() =>
        service.buildDistributePayoutsTx(INVOICE_ID, singleRecipient, PLATFORM_FEE_ACCOUNT, -1)
      ).toThrow("feeBps must be an integer between 0 and 10000.");
    });

    it("rejects a non-integer feeBps", () => {
      expect(() =>
        service.buildDistributePayoutsTx(INVOICE_ID, singleRecipient, PLATFORM_FEE_ACCOUNT, 12.5)
      ).toThrow("feeBps must be an integer between 0 and 10000.");
    });
  });

  describe("invalid inputs", () => {
    it("throws when recipients is empty", () => {
      expect(() =>
        service.buildDistributePayoutsTx(INVOICE_ID, [], PLATFORM_FEE_ACCOUNT, 250)
      ).toThrow("At least one payout recipient is required.");
    });

    it("throws when a recipient address is invalid", () => {
      const recipients: PayoutRecipient[] = [
        { address: "not-a-valid-address", amountStroops: 100n },
      ];

      expect(() =>
        service.buildDistributePayoutsTx(INVOICE_ID, recipients, PLATFORM_FEE_ACCOUNT, 250)
      ).toThrow();
    });

    it("throws when the platform fee account is invalid", () => {
      expect(() =>
        service.buildDistributePayoutsTx(INVOICE_ID, singleRecipient, "not-a-valid-address", 250)
      ).toThrow();
    });
  });
});
