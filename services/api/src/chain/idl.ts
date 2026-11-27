/** The committed Meridian IDL (programs/meridian/idl/meridian.json) and its Borsh coder (copy of the Automation module, as in the Indexer). */
import { BorshCoder, Idl } from "@coral-xyz/anchor";
import { AccountMeta, PublicKey } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findIdl(): string {
  if (process.env.MERIDIAN_IDL) return process.env.MERIDIAN_IDL;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const p = join(dir, "programs/meridian/idl/meridian.json");
    if (existsSync(p)) return p;
    dir = dirname(dir);
  }
  throw new Error("meridian.json IDL not found; set MERIDIAN_IDL");
}

export const IDL = JSON.parse(readFileSync(findIdl(), "utf8")) as Idl & {
  errors: { code: number; name: string }[];
};
export const PROGRAM_ID = new PublicKey(IDL.address);
export const coder = new BorshCoder(IDL);

const errorsByCode = new Map(IDL.errors.map((e) => [e.code, e.name]));
export function errorName(code: number): string | undefined {
  return errorsByCode.get(code);
}

type IdlIxAccount = { name: string; writable?: boolean; signer?: boolean; optional?: boolean; address?: string };

/**
 * Account metas for an instruction, in IDL order, from a name → key map. Accounts with
 * a fixed `address` in the IDL (programs) are filled in; a missing optional account is
 * passed as the program id (Anchor's "None"); anything else missing is an error.
 */
export function metas(ix: string, keys: Record<string, PublicKey | null | undefined>): AccountMeta[] {
  const def = IDL.instructions.find((i) => i.name === ix);
  if (!def) throw new Error(`no instruction ${ix} in IDL`);
  return (def.accounts as IdlIxAccount[]).map((a) => {
    let k = keys[a.name] ?? (a.address ? new PublicKey(a.address) : undefined);
    if (!k) {
      if (a.optional) return { pubkey: PROGRAM_ID, isSigner: false, isWritable: false };
      if (a.name === "program") k = PROGRAM_ID;
      else throw new Error(`${ix}: missing account ${a.name}`);
    }
    return { pubkey: k, isSigner: !!a.signer, isWritable: !!a.writable };
  });
}
