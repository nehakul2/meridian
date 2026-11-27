/**
 * Instruction builders for the user-facing Meridian instructions (spec 7.4). Account lists
 * come from the committed IDL (`metas`), so an IDL change that reorders accounts is picked up
 * and a missing account is an error, not a silently wrong transaction.
 */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { coder, metas, PROGRAM_ID } from "./idl.js";
import { ata, ATA_PROGRAM_ID, configPda, disputePda, eventAuthority, ledgerPda, seeded, tickerDayPda, TOKEN_PROGRAM_ID } from "./pdas.js";

export interface MarketKeys {
  address: PublicKey;
  tickerDay: PublicKey;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  book: PublicKey;
}

export type Side = "BID" | "ASK";
export type Tif = "IOC" | "GTC" | "POST_ONLY";

const bn = (v: bigint | number) => new BN(v.toString());
const writable = (k: PublicKey) => ({ pubkey: k, isSigner: false, isWritable: true });

function tradeKeys(owner: PublicKey, m: MarketKeys, usdcMint: PublicKey) {
  return {
    user: owner, config: configPda(), ticker_day: m.tickerDay, market: m.address, book: m.book,
    base_vault: seeded("base", m.address), quote_vault: seeded("quote", m.address), vault: m.vault,
    yes_mint: m.yesMint, no_mint: m.noMint, ledger: ledgerPda(m.address, owner),
    user_usdc: ata(owner, usdcMint), user_yes: ata(owner, m.yesMint), user_no: ata(owner, m.noMint),
    system_program: SystemProgram.programId, event_authority: eventAuthority(),
  };
}

/** The four trade instructions share one account list plus makers' ledgers as remaining accounts. */
function trade(name: string, owner: PublicKey, m: MarketKeys, usdcMint: PublicKey, args: Record<string, unknown>, makers: PublicKey[]) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [...metas(name, tradeKeys(owner, m, usdcMint)), ...makers.map((o) => writable(ledgerPda(m.address, o)))],
    data: coder.instruction.encode(name, args),
  });
}

export function ixPlaceOrder(owner: PublicKey, m: MarketKeys, usdcMint: PublicKey, side: Side, price: number, qty: bigint, tif: Tif, clientId: bigint, makers: PublicKey[]) {
  const t = tif === "IOC" ? { Ioc: {} } : tif === "GTC" ? { Gtc: {} } : { PostOnly: {} };
  return trade("place_order", owner, m, usdcMint, { side: side === "BID" ? { Bid: {} } : { Ask: {} }, price, qty: bn(qty), tif: t, client_id: bn(clientId) }, makers);
}

export const ixBuyNoMarket = (owner: PublicKey, m: MarketKeys, usdcMint: PublicKey, qty: bigint, minYes: number, makers: PublicKey[]) =>
  trade("buy_no_market", owner, m, usdcMint, { qty: bn(qty), min_yes_price: minYes }, makers);

export const ixBuyNoLimit = (owner: PublicKey, m: MarketKeys, usdcMint: PublicKey, qty: bigint, yes: number, makers: PublicKey[]) =>
  trade("buy_no_limit", owner, m, usdcMint, { qty: bn(qty), yes_price: yes }, makers);

export const ixSellNo = (owner: PublicKey, m: MarketKeys, usdcMint: PublicKey, qty: bigint, maxYes: number, makers: PublicKey[]) =>
  trade("sell_no", owner, m, usdcMint, { qty: bn(qty), max_yes_price: maxYes }, makers);

function cancelKeys(owner: PublicKey, m: MarketKeys, usdcMint: PublicKey) {
  return {
    owner, config: configPda(), market: m.address, book: m.book, ledger: ledgerPda(m.address, owner),
    base_vault: seeded("base", m.address), quote_vault: seeded("quote", m.address), vault: m.vault,
    yes_mint: m.yesMint, no_mint: m.noMint, user_usdc: ata(owner, usdcMint), user_no: ata(owner, m.noMint),
    system_program: SystemProgram.programId, event_authority: eventAuthority(),
  };
}

/** cancel_order: a BUY_NO order's Yes is merged back with the user's No inside the program. */
export const ixCancelOrder = (owner: PublicKey, m: MarketKeys, usdcMint: PublicKey, orderId: bigint) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys: metas("cancel_order", cancelKeys(owner, m, usdcMint)), data: coder.instruction.encode("cancel_order", { order_id: bn(orderId) }) });

export const ixCancelAll = (owner: PublicKey, m: MarketKeys, usdcMint: PublicKey) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys: metas("cancel_all", cancelKeys(owner, m, usdcMint)), data: coder.instruction.encode("cancel_all", {}) });

function mintMergeKeys(owner: PublicKey, m: MarketKeys, usdcMint: PublicKey) {
  return {
    user: owner, config: configPda(), ticker_day: m.tickerDay, market: m.address, yes_mint: m.yesMint, no_mint: m.noMint,
    vault: m.vault, user_usdc: ata(owner, usdcMint), user_yes: ata(owner, m.yesMint), user_no: ata(owner, m.noMint),
    system_program: SystemProgram.programId, event_authority: eventAuthority(),
  };
}

export const ixMint = (owner: PublicKey, m: MarketKeys, usdcMint: PublicKey, n: bigint) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys: metas("mint_pair", mintMergeKeys(owner, m, usdcMint)), data: coder.instruction.encode("mint_pair", { n: bn(n) }) });

export const ixMerge = (owner: PublicKey, m: MarketKeys, usdcMint: PublicKey, n: bigint) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys: metas("merge_pair", mintMergeKeys(owner, m, usdcMint)), data: coder.instruction.encode("merge_pair", { n: bn(n) }) });

/** withdraw: the user's free ledger balances (maker proceeds, released escrow) to their wallet. */
export const ixWithdraw = (owner: PublicKey, m: MarketKeys, usdcMint: PublicKey) =>
  new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("withdraw", {
      owner, config: configPda(), market: m.address, book: m.book, ledger: ledgerPda(m.address, owner),
      base_vault: seeded("base", m.address), quote_vault: seeded("quote", m.address), yes_mint: m.yesMint,
      user_usdc: ata(owner, usdcMint), user_yes: ata(owner, m.yesMint), system_program: SystemProgram.programId,
      event_authority: eventAuthority(),
    }),
    data: coder.instruction.encode("withdraw", {}),
  });

export const ixRedeem = (owner: PublicKey, m: MarketKeys, usdcMint: PublicKey, yesN: bigint, noN: bigint) =>
  new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("redeem", {
      user: owner, config: configPda(), market: m.address, vault: m.vault, yes_mint: m.yesMint, no_mint: m.noMint,
      user_yes: ata(owner, m.yesMint), user_no: ata(owner, m.noMint), user_usdc: ata(owner, usdcMint), event_authority: eventAuthority(),
    }),
    data: coder.instruction.encode("redeem", { yes_n: bn(yesN), no_n: bn(noN) }),
  });

/** Associated token account, created only if missing (redeem does not create token accounts). */
export const ixCreateAtaIdempotent = (owner: PublicKey, mint: PublicKey) =>
  new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      writable(ata(owner, mint)),
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });

/** raise_dispute (D8): posts the bond from the disputer's USDC account. */
export const ixRaiseDispute = (owner: PublicKey, symbol: string, date: number, usdcMint: PublicKey, bondVault: PublicKey, evidenceHash: Buffer) => {
  const td = tickerDayPda(symbol, date);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("raise_dispute", {
      disputer: owner, config: configPda(), ticker_day: td, dispute: disputePda(td), disputer_usdc: ata(owner, usdcMint),
      bond_vault: bondVault, system_program: SystemProgram.programId, event_authority: eventAuthority(),
    }),
    data: coder.instruction.encode("raise_dispute", { evidence_hash: [...evidenceHash] }),
  });
};

export function decodeIx(data: Buffer | Uint8Array): { name: string; data: Record<string, unknown> } | null {
  return coder.instruction.decode(Buffer.from(data)) as { name: string; data: Record<string, unknown> } | null;
}
