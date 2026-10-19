import { Keypair, Networks, Transaction } from "stellar-sdk";
import { buildWalletChallenge } from "@/utils/stellar-challenge";
import { HttpError } from "@/utils/http-error";

const TESTNET_PASSPHRASE = Networks.TESTNET;

describe("buildWalletChallenge", () => {
  it("returns a signed Transaction for a valid wallet address and server keypair", () => {
    const walletKeypair = Keypair.random();
    const serverKeypair = Keypair.random();

    const { transaction, nonce } = buildWalletChallenge(
      walletKeypair.publicKey(),
      TESTNET_PASSPHRASE,
      serverKeypair
    );

    expect(transaction).toBeInstanceOf(Transaction);
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBeGreaterThan(0);

    // Transaction must carry at least one ManageData operation named web_auth_domain
    const ops = transaction.operations;
    expect(ops.length).toBeGreaterThan(0);
    const managedDataOp = ops.find(
      (op) => op.type === "manageData" && op.name === "web_auth_domain"
    );
    expect(managedDataOp).toBeDefined();

    // Transaction must be signed by the server keypair
    expect(transaction.signatures.length).toBeGreaterThan(0);
  });

  it("throws HttpError for an invalid wallet address", () => {
    const serverKeypair = Keypair.random();

    expect(() =>
      buildWalletChallenge("NOT_A_VALID_STELLAR_ADDRESS", TESTNET_PASSPHRASE, serverKeypair)
    ).toThrow(HttpError);

    expect(() => buildWalletChallenge("", TESTNET_PASSPHRASE, serverKeypair)).toThrow(HttpError);
  });

  it("produces a different nonce on each call", () => {
    const walletKeypair = Keypair.random();
    const serverKeypair = Keypair.random();

    const first = buildWalletChallenge(
      walletKeypair.publicKey(),
      TESTNET_PASSPHRASE,
      serverKeypair
    );
    const second = buildWalletChallenge(
      walletKeypair.publicKey(),
      TESTNET_PASSPHRASE,
      serverKeypair
    );

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.transaction.toXDR()).not.toBe(second.transaction.toXDR());
  });
});
