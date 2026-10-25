import { StrKey } from "@stellar/stellar-sdk";

export function isValidStellarPublicKey(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidEd25519PublicKey(address);
}

export function isValidSorobanContractId(contractId: unknown): contractId is string {
  return (
    typeof contractId === "string" &&
    (StrKey as { isValidContract?: (value: string) => boolean }).isValidContract?.(contractId) === true
  );
}
