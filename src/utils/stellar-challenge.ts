import crypto from "crypto";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  StrKey,
  Transaction,
  TransactionBuilder,
} from "stellar-sdk";
import { HttpError } from "./http-error";

export interface WalletChallenge {
  transaction: Transaction;
  nonce: string;
}

export function buildWalletChallenge(
  walletAddress: string,
  networkPassphrase: string,
  serverKeypair: Keypair
): WalletChallenge {
  if (!StrKey.isValidEd25519PublicKey(walletAddress)) {
    throw new HttpError(400, "Invalid wallet address.");
  }

  // ManageData value must be ≤ 64 bytes; 32 random bytes encoded as hex = 64 chars
  const nonce = crypto.randomBytes(32).toString("hex");
  const account = new Account(serverKeypair.publicKey(), "-1");
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.manageData({
        name: "web_auth_domain",
        value: Buffer.from(nonce, "utf8"),
        source: walletAddress,
      })
    )
    .setTimeout(300)
    .build();

  tx.sign(serverKeypair);
  return { transaction: tx, nonce };
}
