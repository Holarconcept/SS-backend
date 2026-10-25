import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { isValidStellarPublicKey } from "../../src/utils/stellar-address.utils";

describe("isValidStellarPublicKey", () => {
  it("returns true for a valid Stellar ed25519 public key", () => {
    expect(isValidStellarPublicKey(Keypair.random().publicKey())).toBe(true);
  });

  it("returns false for malformed G-addresses", () => {
    expect(isValidStellarPublicKey("GABC")).toBe(false);
    expect(
      isValidStellarPublicKey("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    ).toBe(false);
  });

  it("returns false for non-public-key StrKey values", () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));

    expect(isValidStellarPublicKey(contractId)).toBe(false);
  });

  it("returns false for non-string values", () => {
    expect(isValidStellarPublicKey(null)).toBe(false);
    expect(isValidStellarPublicKey(undefined)).toBe(false);
    expect(isValidStellarPublicKey(123)).toBe(false);
  });
});
