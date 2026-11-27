/** PDA derivations, mirroring programs/meridian/src/constants.rs seeds. */
import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./idl.js";

const enc = (s: string) => Buffer.from(s, "utf8");
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];

export const configPda = () => pda([enc("config")]);
export const tickerDayPda = (ticker: string, date: number) => pda([enc("tday"), enc(ticker), u32le(date)]);
export const marketPda = (ticker: string, date: number, strikeCents: bigint) =>
  pda([enc("market"), enc(ticker), u32le(date), u64le(strikeCents)]);
export const seeded = (seed: "yes" | "no" | "vault" | "book" | "base" | "quote", market: PublicKey) =>
  pda([enc(seed), market.toBuffer()]);
export const ledgerPda = (market: PublicKey, owner: PublicKey) => pda([enc("ledger"), market.toBuffer(), owner.toBuffer()]);
export const disputePda = (td: PublicKey) => pda([enc("dispute"), td.toBuffer()]);
export const bondAuthority = () => pda([enc("bond")]);
export const eventAuthority = () => pda([enc("__event_authority")]);

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const PYTH_RECEIVER_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];
}
