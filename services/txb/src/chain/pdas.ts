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
/**
 * findProgramAddressSync costs ~0.1-0.3 ms (sha256 + curve check per bump) and a trade build
 * derives a dozen addresses, mostly the same ones again (MER-83 load run). Derivations are
 * pure, so remember them; the cap keeps memory bounded on a long-running builder.
 */
const memo = new Map<string, PublicKey>();
const MEMO_MAX = 100_000;
function find(seeds: Buffer[], program: PublicKey): PublicKey {
  const k = program.toBase58() + ":" + seeds.map((x) => x.toString("hex")).join(":");
  let v = memo.get(k);
  if (!v) {
    if (memo.size >= MEMO_MAX) memo.clear();
    v = PublicKey.findProgramAddressSync(seeds, program)[0];
    memo.set(k, v);
  }
  return v;
}
const pda = (seeds: Buffer[]) => find(seeds, PROGRAM_ID);

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
  return find([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
}
