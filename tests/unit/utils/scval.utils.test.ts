import { scValToNative } from "stellar-sdk";
import { scValI128, scValU64, scValSymbol, scValAddress } from "../../../src/services/stellar/utils/scval.utils";

// Polyfill BigInt.prototype.toJSON so Jest IPC message serialization does not throw
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

describe("scValI128", () => {
  it("should encode zero correctly", () => {
    const val = scValI128(0n);
    expect(scValToNative(val)).toBe(0n);
  });

  it("should encode a positive bigint", () => {
    const val = scValI128(500_000_000n);
    expect(scValToNative(val)).toBe(500_000_000n);
  });

  it("should encode a large i128 stroop value", () => {
    const large = BigInt("170141183460469231731687303715884105727");
    const val = scValI128(large);
    expect(scValToNative(val)).toBe(large);
  });

  it("should encode from string input", () => {
    const val = scValI128("1000000000");
    expect(scValToNative(val)).toBe(1000000000n);
  });

  it("should encode negative values", () => {
    const val = scValI128(-500n);
    expect(scValToNative(val)).toBe(-500n);
  });
});

describe("scValU64", () => {
  it("should encode zero correctly", () => {
    const val = scValU64(0);
    expect(scValToNative(val)).toBe(0n);
  });

  it("should encode a timestamp", () => {
    const val = scValU64(1770000000);
    expect(scValToNative(val)).toBe(1770000000n);
  });

  it("should encode max u64", () => {
    const maxU64 = 18446744073709551615n;
    const val = scValU64(maxU64);
    expect(scValToNative(val)).toBe(18446744073709551615n);
  });
});

describe("scValSymbol", () => {
  it("should encode an invoice ID", () => {
    const val = scValSymbol("INV-2026-001");
    expect(scValToNative(val)).toBe("INV-2026-001");
  });

  it("should encode a short symbol", () => {
    const val = scValSymbol("create_escrow");
    expect(scValToNative(val)).toBe("create_escrow");
  });

  it("should encode an empty string", () => {
    const val = scValSymbol("");
    expect(scValToNative(val)).toBe("");
  });
});

describe("scValAddress", () => {
  it("should encode a Stellar address", () => {
    const addr = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
    const val = scValAddress(addr);
    expect(scValToNative(val)).toBe(addr);
  });

  it("should encode a contract address", () => {
    const addr = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
    const val = scValAddress(addr);
    expect(scValToNative(val)).toBe(addr);
  });
});
