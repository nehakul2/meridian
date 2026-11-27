/**
 * Records `test/fixtures/day.json`: one META trading day run against the real program
 * (target/deploy/meridian.so) on LiteSVM, using the automation jobs for the morning,
 * settlement and cleanup and direct instructions for user trades. Every spec 4.6 event
 * kind appears at least once. The fixture holds each successful transaction as RPC
 * `getTransaction` would return it (account keys and inner instructions), so the
 * decoder tests read exactly what the Indexer reads in production.
 *
 *   npm run fixture:record     (needs `make build` and services/automation's node_modules)
 *
 * The scenario (strike 680, prev close 680.00, close 685.12, so YES):
 *   1% taker fee (update_config)
 *   alice mints 100 pairs, offers Yes 20 @ 64; bob bids 50 @ 61
 *   carol Buy No market 10 (fills bob @ 61, No booked at 39)
 *   dave Buy No limit 10 @ Yes 65 (rests, BOTH_PENDING)
 *   erin buys Yes IOC 25 @ 65: alice 20 @ 64, dave 5 @ 65 (maker BUY_NO fill)
 *   carol Sell No 5 (buys dave's other 5 @ 65 and merges)
 *   alice merges 10, bob cancels his bid, dave Buy No limit 3 @ 70 then cancels it,
 *   frank Buy No limit 2 @ 90 (left for prune), alice withdraws her ledger
 *   pause / unpause; close recorded, disputed, corrected to 685.12; strikes settle;
 *   the 720 strike (no trades) is voided first; prune, close books (fees swept); alice redeems.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, Signer, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { utils } from "@coral-xyz/anchor";
import { it } from "vitest";
import { FailedTransactionMetadata } from "litesvm";
import { coder, IDL, metas, PROGRAM_ID } from "../../automation/src/chain/idl.js";
import {
  ata, ATA_PROGRAM_ID, bondAuthority, configPda, disputePda, eventAuthority, ledgerPda, marketPda, seeded,
  tickerDayPda, TOKEN_PROGRAM_ID,
} from "../../automation/src/chain/pdas.js";
import { runCloseBook, runFinalize, runPrune, runStrikeCrank } from "../../automation/src/jobs/cranks.js";
import { runMorning } from "../../automation/src/jobs/morning.js";
import { runSettle } from "../../automation/src/jobs/settler.js";
import { etToUnix } from "../../automation/src/time.js";
import { FakeClock, makeDeps } from "../../automation/test/helpers/fakes.js";
import { SvmEnv } from "../../automation/test/helpers/svm.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../test/fixtures/day.json");
const DATE = "2026-11-25";
const KEY = 20261125;
const CLOSE = etToUnix(DATE, 16, 0);
const USDC = 1_000_000n;

interface RecordedTx {
  signature: string; slot: number; blockTime: number; err: null; label: string;
  accountKeys: string[]; innerInstructions: { index: number; instructions: { programIdIndex: number; data: string }[] }[];
}

const recorded: RecordedTx[] = [];

class RecordingEnv extends SvmEnv {
  get txs() {
    return recorded;
  }
  label = "";
  override sendSync(ixs: TransactionInstruction[], signers: Signer[]) {
    this.syncClock();
    this.svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = signers[0]!.publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    // SvmEnv.findMarkets scans the keys of sent transactions (its stand-in for getProgramAccounts).
    const seen = (this as unknown as { seen: Set<string> }).seen;
    for (const ix of ixs) for (const k of ix.keys) seen.add(k.pubkey.toBase58());
    const res = this.svm.sendTransaction(tx);
    if (res instanceof FailedTransactionMetadata) {
      throw new Error(`${this.label}: ${res.meta().logs().join("\n")}`);
    }
    const keys = tx.compileMessage().accountKeys.map((k) => k.toBase58());
    const inner = res.innerInstructions()
      .map((list, index) => ({
        index,
        instructions: list.map((ii) => ({
          programIdIndex: ii.instruction().programIdIndex(),
          data: utils.bytes.bs58.encode(Buffer.from(ii.instruction().data())),
        })),
      }))
      .filter((g) => g.instructions.length > 0);
    this.txs.push({
      signature: utils.bytes.bs58.encode(Buffer.from(res.signature())), slot: Number(this.svm.getClock().slot),
      blockTime: this.clock.now(), err: null, label: this.label ?? "setup", accountKeys: keys, innerInstructions: inner,
    });
    return res;
  }
}

it("records the day fixture", async () => {
  const clock = new FakeClock(etToUnix(DATE, 8, 0));
  const env = new RecordingEnv(clock);
  const ctx = makeDeps({ clock, chain: env.chain(), poster: env });
  ctx.store.tickers = ctx.store.tickers.filter((t) => t.symbol === "META");
  for (const t of ctx.store.tickers) t.liquidityTierOverride = "A";
  ctx.massive.set("META", "2026-11-24", 68000n);
  ctx.databento.set("META", "2026-11-24", 68000n);
  env.label = "morning";
  await runMorning(ctx.deps, DATE);

  const chain = ctx.deps.chain;
  const m = (await chain.market(marketPda("META", KEY, 68000n)))!;
  const all = await chain.markets(tickerDayPda("META", KEY));
  const m720 = all.reduce((a, b) => (b.strikeCents > a.strikeCents ? b : a)); // highest strike, never traded
  const td = tickerDayPda("META", KEY);
  const users = Object.fromEntries(["alice", "bob", "carol", "dave", "erin", "frank", "disputer"].map((n) => [n, env.user(1_000n * USDC)]));
  const { alice, bob, carol, dave, erin, frank, disputer } = users as Record<string, Keypair>;

  const tradeKeys = (u: PublicKey) => ({
    user: u, owner: u, config: configPda(), ticker_day: m.tickerDay, market: m.address, book: m.book,
    base_vault: seeded("base", m.address), quote_vault: seeded("quote", m.address), vault: m.vault,
    yes_mint: m.yesMint, no_mint: m.noMint, ledger: ledgerPda(m.address, u),
    user_usdc: ata(u, env.usdcMint), user_yes: ata(u, m.yesMint), user_no: ata(u, m.noMint),
    token_program: TOKEN_PROGRAM_ID, associated_token_program: ATA_PROGRAM_ID, system_program: SystemProgram.programId,
    event_authority: eventAuthority(),
  });
  const send = (label: string, name: string, signer: Keypair, args: Record<string, unknown>, extra: Record<string, PublicKey> = {}, makers: PublicKey[] = []) => {
    env.label = label;
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [...metas(name, { ...tradeKeys(signer.publicKey), ...extra }),
        ...makers.map((mk) => ({ pubkey: ledgerPda(m.address, mk), isSigner: false, isWritable: true }))],
      data: coder.instruction.encode(name, args),
    });
    env.sendSync([ix], [signer]);
  };
  const n = (v: number | bigint) => new BN(v.toString());

  const adminSend = (label: string, name: string, keys: Record<string, PublicKey>, args: Record<string, unknown> = {}) => {
    env.label = label;
    env.sendSync([new TransactionInstruction({ programId: PROGRAM_ID, keys: metas(name, { admin: env.admin.publicKey, config: configPda(), event_authority: eventAuthority(), ...keys }), data: coder.instruction.encode(name, args) })], [env.admin]);
  };
  // 1% taker fee, so fills carry fees and close_book sweeps them (FeesSwept).
  const cu = (IDL.types ?? []).find((t) => t.name === "ConfigUpdate")!.type as { fields: { name: string }[] };
  adminSend("fee 100 bps", "update_config", {}, { update: Object.fromEntries(cu.fields.map((f) => [f.name, f.name === "fee_bps" ? 100 : null])) });
  clock.t = etToUnix(DATE, 9, 45);
  send("alice mints 100", "mint_pair", alice, { n: n(100) });
  send("alice asks 20 @ 64", "place_order", alice, { side: { Ask: {} }, price: 64, qty: n(20), tif: { Gtc: {} }, client_id: n(1) });
  send("bob bids 50 @ 61", "place_order", bob, { side: { Bid: {} }, price: 61, qty: n(50), tif: { Gtc: {} }, client_id: n(2) });
  clock.t += 60;
  send("carol buy no market 10", "buy_no_market", carol, { qty: n(10), min_yes_price: 60 }, {}, [bob.publicKey]);
  send("dave buy no limit 10 @ 65", "buy_no_limit", dave, { qty: n(10), yes_price: 65 });
  clock.t += 60;
  send("erin buys yes ioc 25 @ 65", "place_order", erin, { side: { Bid: {} }, price: 65, qty: n(25), tif: { Ioc: {} }, client_id: n(3) }, {}, [alice.publicKey, dave.publicKey]);
  send("carol sell no 5", "sell_no", carol, { qty: n(5), max_yes_price: 66 }, {}, [dave.publicKey]);
  clock.t += 60;
  send("alice merges 10", "merge_pair", alice, { n: n(10) });
  const orderOf = async (u: Keypair) => (await chain.book(m))!.orders.find((o) => o.owner.equals(u.publicKey))!.orderId;
  send("bob cancels his bid", "cancel_order", bob, { order_id: n(await orderOf(bob)) });
  send("dave buy no limit 3 @ 70", "buy_no_limit", dave, { qty: n(3), yes_price: 70 });
  send("dave cancels it", "cancel_order", dave, { order_id: n(await orderOf(dave)) });
  send("frank buy no limit 2 @ 90", "buy_no_limit", frank, { qty: n(2), yes_price: 90 });
  send("alice withdraws", "withdraw", alice, {});

  clock.t += 60;
  adminSend("pause", "pause", {});
  adminSend("unpause", "unpause", {});
  adminSend("void 720", "void_market", { market: m720.address, vault: m720.vault, yes_mint: m720.yesMint, no_mint: m720.noMint });

  // Close: recorded 684.00 (wrong), disputed, corrected to 685.12.
  clock.t = CLOSE + 300;
  ctx.massive.set("META", DATE, 68400n);
  ctx.databento.set("META", DATE, 68400n);
  ctx.hermes.add("META", { price: 68400000n, conf: 6840n, publishTime: CLOSE + 1 });
  env.label = "record close";
  await runSettle(ctx.deps, DATE);
  clock.t += 120;
  const cfg = await chain.config();
  env.label = "dispute";
  env.sendSync([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("raise_dispute", {
      disputer: disputer.publicKey, config: configPda(), ticker_day: td, dispute: disputePda(td),
      disputer_usdc: ata(disputer.publicKey, env.usdcMint), bond_vault: cfg.bondVault, token_program: TOKEN_PROGRAM_ID,
      system_program: SystemProgram.programId, event_authority: eventAuthority(),
    }),
    data: coder.instruction.encode("raise_dispute", { evidence_hash: Array(32).fill(9) }),
  })], [disputer]);
  clock.t += 300;
  adminSend("correct", "resolve_dispute", {
    ticker_day: td, dispute: disputePda(td), bond_vault: cfg.bondVault, bond_authority: bondAuthority(),
    fee_vault: cfg.feeVault, disputer_usdc: ata(disputer.publicKey, env.usdcMint), token_program: TOKEN_PROGRAM_ID,
  }, { resolution: { Correct: { price: n(68512000), expo: -5 } } });
  clock.t += 60;
  env.label = "finalize";
  await runFinalize(ctx.deps, DATE);
  env.label = "settle strikes";
  await runStrikeCrank(ctx.deps, DATE);
  clock.t += 60;
  env.label = "prune";
  await runPrune(ctx.deps, DATE);
  env.label = "close books";
  await runCloseBook(ctx.deps, DATE);
  // alice holds 70 Yes in her wallet (+ 0 in the ledger after withdraw).
  env.label = "alice redeems";
  const rk = tradeKeys(alice.publicKey);
  env.sendSync([new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("redeem", { ...rk, user: alice.publicKey }),
    data: coder.instruction.encode("redeem", { yes_n: n(70), no_n: n(0) }),
  })], [alice]);

  const fixture = {
    programId: PROGRAM_ID.toBase58(),
    date: DATE,
    markets: { m680: m.address.toBase58(), m720: m720.address.toBase58(), tickerDay: td.toBase58(), config: configPda().toBase58() },
    users: Object.fromEntries(Object.entries(users).map(([k, v]) => [k, v.publicKey.toBase58()])),
    txs: env.txs,
  };
  writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`wrote ${env.txs.length} transactions to ${OUT}`);
});
