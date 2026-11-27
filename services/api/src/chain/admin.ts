/**
 * Unsigned admin transactions for the Squads multisig (spec 7.6, A21, A22, MER-64).
 *
 * The API never holds a key and never calls RPC on a request path, so it returns:
 * - `multisig.instructions`: the program instructions with the multisig vault (Config.admin)
 *   as signer and fee payer, ready for Squads `vaultTransactionCreate`;
 * - `transaction`: the same instructions compiled into an unsigned v0 message. Squads stores
 *   the message and supplies its own blockhash at execution, so the message carries a
 *   placeholder blockhash (all zeros) rather than one fetched from RPC.
 */
import {
  PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { createHash } from "node:crypto";
import { coder, metas, PROGRAM_ID } from "./idl.js";
import { ata, bondAuthority, configPda, disputePda, eventAuthority, marketPda, seeded, tickerDayPda, TOKEN_PROGRAM_ID } from "./pdas.js";

export interface AdminChainConfig {
  /** Config.admin: the Squads vault that signs admin instructions. */
  adminAuthority: PublicKey;
  usdcMint: PublicKey;
  feeVault: PublicKey;
  bondVault: PublicKey;
}

export const PLACEHOLDER_BLOCKHASH = new PublicKey(new Uint8Array(32)).toBase58();

export interface UnsignedAdminTx {
  transaction: string;
  multisig: {
    vault: string;
    instructions: { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string }[];
  };
}

export function toUnsigned(cfg: AdminChainConfig, ixs: TransactionInstruction[]): UnsignedAdminTx {
  const msg = new TransactionMessage({ payerKey: cfg.adminAuthority, recentBlockhash: PLACEHOLDER_BLOCKHASH, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  return {
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    multisig: {
      vault: cfg.adminAuthority.toBase58(),
      instructions: ixs.map((ix) => ({
        programId: ix.programId.toBase58(),
        accounts: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
        data: ix.data.toString("base64"),
      })),
    },
  };
}

const bn = (v: bigint | number) => new BN(v.toString());

export function ixPause(cfg: AdminChainConfig, paused: boolean): TransactionInstruction {
  const name = paused ? "pause" : "unpause";
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas(name, { admin: cfg.adminAuthority, config: configPda(), event_authority: eventAuthority() }),
    data: coder.instruction.encode(name, {}),
  });
}

export function ixAddStrike(cfg: AdminChainConfig, symbol: string, date: number, strikeCents: bigint): TransactionInstruction {
  const market = marketPda(symbol, date, strikeCents);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("add_strike", {
      payer: cfg.adminAuthority, authority: cfg.adminAuthority, config: configPda(), ticker_day: tickerDayPda(symbol, date), market,
      yes_mint: seeded("yes", market), no_mint: seeded("no", market), vault: seeded("vault", market), book: seeded("book", market),
      base_vault: seeded("base", market), quote_vault: seeded("quote", market), usdc_mint: cfg.usdcMint,
      system_program: SystemProgram.programId, event_authority: eventAuthority(),
    }),
    data: coder.instruction.encode("add_strike", { strike_cents: bn(strikeCents) }),
  });
}

export function ixVoidMarket(cfg: AdminChainConfig, m: { address: PublicKey; vault: PublicKey; yesMint: PublicKey; noMint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("void_market", {
      admin: cfg.adminAuthority, config: configPda(), market: m.address, vault: m.vault, yes_mint: m.yesMint, no_mint: m.noMint,
      event_authority: eventAuthority(),
    }),
    data: coder.instruction.encode("void_market", {}),
  });
}

/** admin_settle: the override price for a ticker-day still unrecorded after the delay (D4). */
export function ixOverrideSettle(cfg: AdminChainConfig, symbol: string, date: number, priceRaw: bigint, expo: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("admin_settle", {
      admin: cfg.adminAuthority, config: configPda(), ticker_day: tickerDayPda(symbol, date), event_authority: eventAuthority(),
    }),
    data: coder.instruction.encode("admin_settle", { price: bn(priceRaw), expo }),
  });
}

/** resolve_dispute (D8): uphold, or correct once with a new price. */
export function ixResolveDispute(
  cfg: AdminChainConfig, symbol: string, date: number, disputer: PublicKey,
  r: { result: "UPHELD" } | { result: "CORRECTED"; priceRaw: bigint; expo: number },
): TransactionInstruction {
  const td = tickerDayPda(symbol, date);
  const resolution = r.result === "UPHELD" ? { Uphold: {} } : { Correct: { price: bn(r.priceRaw), expo: r.expo } };
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("resolve_dispute", {
      admin: cfg.adminAuthority, config: configPda(), ticker_day: td, dispute: disputePda(td), bond_vault: cfg.bondVault,
      bond_authority: bondAuthority(), fee_vault: cfg.feeVault, disputer_usdc: ata(disputer, cfg.usdcMint),
      token_program: TOKEN_PROGRAM_ID, event_authority: eventAuthority(),
    }),
    data: coder.instruction.encode("resolve_dispute", { resolution }),
  });
}

/** Decodes a program instruction (tests and the audit log). */
export function decodeIx(data: Buffer | Uint8Array): { name: string; data: unknown } | null {
  return coder.instruction.decode(Buffer.from(data)) as { name: string; data: unknown } | null;
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
