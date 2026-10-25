import { nativeToScVal, Address, xdr } from "@stellar/stellar-sdk";

export function scValI128(amount: bigint | string): xdr.ScVal {
  return nativeToScVal(BigInt(amount), { type: "i128" });
}

export function scValU64(val: number | bigint | string): xdr.ScVal {
  return nativeToScVal(BigInt(val), { type: "u64" });
}

export function scValSymbol(val: string): xdr.ScVal {
  return nativeToScVal(val, { type: "symbol" });
}

export function scValAddress(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}
