/**
 * The real Meridian program (target/deploy/meridian.so) on LiteSVM, for building
 * transactions with the Tx Builder and then signing and executing them as a wallet would.
 * `syncRedis` plays the Indexer's part from account state: it decodes the OrderBook and
 * each user's ledger and token accounts and writes `md:mkt`, `md:book:{m}:ord`, `md:oo`
 * and `md:pos` exactly in the Indexer's layout, so guards read what the chain holds.
 */
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import type { Redis } from "ioredis";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Clock as SvmClock, FailedTransactionMetadata, LiteSVM } from "litesvm";
import { K } from "../../../shared/src/keys.js";
import { coder, metas, PROGRAM_ID } from "../../src/chain/idl.js";
import { ata, ATA_PROGRAM_ID, configPda, eventAuthority, ledgerPda, marketPda, seeded, tickerDayPda, TOKEN_PROGRAM_ID } from "../../src/chain/pdas.js";
import type { MarketKeys } from "../../src/chain/ixs.js";

const here = dirname(fileURLToPath(import.meta.url));
export const SO_PATH = join(here, "../../../../target/deploy/meridian.so");
export const haveProgram = existsSync(SO_PATH);
if (process.env.REQUIRE_PROGRAM && !haveProgram) throw new Error(`REQUIRE_PROGRAM is set but ${SO_PATH} is missing: run \`make build\` first`);

const LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
export const DATE = 20261125;
export const T = { mintOpen: 1795613400, open: 1795617000, close: 1795640400 };

function mintData(authority: PublicKey | null, decimals: number): Uint8Array {
  const d = Buffer.alloc(82);
  if (authority) {
    d.writeUInt32LE(1, 0);
    authority.toBuffer().copy(d, 4);
  }
  d.writeUInt8(decimals, 44);
  d.writeUInt8(1, 45);
  return new Uint8Array(d);
}

function tokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint): Uint8Array {
  const d = Buffer.alloc(165);
  mint.toBuffer().copy(d, 0);
  owner.toBuffer().copy(d, 32);
  d.writeBigUInt64LE(amount, 64);
  d.writeUInt8(1, 108);
  return new Uint8Array(d);
}

// OrderBook layout (services/automation/src/chain/book.ts).
const HEADER = 8 + 32 * 3 + 8 * 6 + 4 + 1 + 3;
const ORDER_SIZE = 56;
const LEVEL_SIZE = 8 + ORDER_SIZE * 8;
const LEVELS = 99;
const BOOK_LEN = HEADER + 2 * LEVELS * LEVEL_SIZE;

export interface Market extends MarketKeys {
  strikeCents: bigint;
}

export class Svm {
  readonly svm = new LiteSVM();
  readonly deployer = Keypair.generate();
  readonly admin = Keypair.generate();
  readonly creator = Keypair.generate();
  readonly settler = Keypair.generate();
  readonly usdcMint = Keypair.generate().publicKey;
  readonly feeVault = Keypair.generate().publicKey;
  readonly bondVault = Keypair.generate().publicKey;
  readonly users = new Map<string, Keypair>();
  now = T.open + 3600;

  constructor() {
    const elf = readFileSync(SO_PATH);
    const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER_UPGRADEABLE)[0];
    const meta = Buffer.alloc(45);
    meta.writeUInt32LE(3, 0);
    meta.writeUInt8(1, 12);
    this.deployer.publicKey.toBuffer().copy(meta, 13);
    this.put(programData, new Uint8Array(Buffer.concat([meta, elf])), LOADER_UPGRADEABLE);
    const prog = Buffer.alloc(36);
    prog.writeUInt32LE(2, 0);
    programData.toBuffer().copy(prog, 4);
    this.put(PROGRAM_ID, new Uint8Array(prog), LOADER_UPGRADEABLE, true);
    for (const k of [this.deployer, this.admin, this.creator, this.settler]) this.svm.airdrop(k.publicKey, 1_000_000_000_000n);
    this.put(this.usdcMint, mintData(Keypair.generate().publicKey, 6), TOKEN_PROGRAM_ID);
    this.put(this.feeVault, tokenAccountData(this.usdcMint, this.admin.publicKey, 0n), TOKEN_PROGRAM_ID);
    const bondAuth = PublicKey.findProgramAddressSync([Buffer.from("bond")], PROGRAM_ID)[0];
    this.put(this.bondVault, tokenAccountData(this.usdcMint, bondAuth, 0n), TOKEN_PROGRAM_ID);
    this.send([new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("initialize_config", {
        deployer: this.deployer.publicKey, config: configPda(), usdc_mint: this.usdcMint, program: PROGRAM_ID, program_data: programData,
        system_program: SystemProgram.programId,
      }),
      data: coder.instruction.encode("initialize_config", {
        args: {
          admin: this.admin.publicKey, market_creator: this.creator.publicKey, settler: this.settler.publicKey, fee_vault: this.feeVault,
          bond_vault: this.bondVault, tickers: MAG7.map((s, i) => ({ symbol: s, feed_id: [...Buffer.alloc(32, i + 1)] })),
        },
      }),
    })], [this.deployer]);
  }

  put(address: PublicKey, data: Uint8Array, owner: PublicKey, executable = false) {
    const lamports = Number(this.svm.minimumBalanceForRentExemption(BigInt(data.length)));
    this.svm.setAccount(address, { lamports, data, owner, executable, rentEpoch: 0 });
  }

  private clock() {
    const c = this.svm.getClock();
    this.svm.setClock(new SvmClock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(this.now)));
  }

  /** Sends a legacy tx signed by `signers` (setup steps). Throws with the program logs on failure. */
  send(ixs: TransactionInstruction[], signers: Keypair[]) {
    this.clock();
    this.svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = signers[0]!.publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    const res = this.svm.sendTransaction(tx);
    if (res instanceof FailedTransactionMetadata) throw new Error(`setup tx failed:\n${res.meta().logs().join("\n")}`);
  }

  /** What a wallet does with a Tx Builder transaction: sign it and send it. Returns the logs. */
  signAndSend(b64: string, signer: Keypair): { ok: boolean; logs: string[] } {
    this.clock();
    const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
    tx.sign([signer]);
    const res = this.svm.sendTransaction(tx);
    if (res instanceof FailedTransactionMetadata) return { ok: false, logs: res.meta().logs() };
    return { ok: true, logs: res.logs() };
  }

  /** The blockhash a fresh Tx Builder build should use. */
  blockhash() {
    return { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 1_000 };
  }

  createMarket(symbol: string, strikeCents: bigint, closeTime = T.close): Market {
    const td = tickerDayPda(symbol, DATE);
    if (!this.svm.getAccount(td)) {
      this.now = T.mintOpen - 3600;
      this.send([new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: metas("create_ticker_day", { payer: this.creator.publicKey, creator: this.creator.publicKey, config: configPda(), ticker_day: td, system_program: SystemProgram.programId }),
        data: coder.instruction.encode("create_ticker_day", { ticker: symbol, date: DATE, mint_open_time: new BN(T.mintOpen), open_time: new BN(T.open), close_time: new BN(closeTime) }),
      })], [this.creator]);
      this.now = T.open + 3600;
    }
    const market = marketPda(symbol, DATE, strikeCents);
    const create = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("create_strike_market", {
        payer: this.creator.publicKey, authority: this.creator.publicKey, config: configPda(), ticker_day: td, market,
        yes_mint: seeded("yes", market), no_mint: seeded("no", market), vault: seeded("vault", market), book: seeded("book", market),
        base_vault: seeded("base", market), quote_vault: seeded("quote", market), usdc_mint: this.usdcMint, event_authority: eventAuthority(),
      }),
      data: coder.instruction.encode("create_strike_market", { strike_cents: new BN(strikeCents.toString()) }),
    });
    const grow = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("grow_book", { payer: this.creator.publicKey, market, book: seeded("book", market), system_program: SystemProgram.programId }),
      data: coder.instruction.encode("grow_book", {}),
    });
    const steps = Math.ceil((BOOK_LEN - 10_240) / 10_240);
    this.send([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), create, ...Array.from({ length: steps }, () => grow)], [this.creator]);
    return {
      address: market, tickerDay: td, yesMint: seeded("yes", market), noMint: seeded("no", market), vault: seeded("vault", market),
      book: seeded("book", market), strikeCents,
    };
  }

  user(name: string, usdc: bigint): Keypair {
    const kp = Keypair.generate();
    this.svm.airdrop(kp.publicKey, 10_000_000_000n);
    this.put(ata(kp.publicKey, this.usdcMint), tokenAccountData(this.usdcMint, kp.publicKey, usdc), TOKEN_PROGRAM_ID);
    this.users.set(name, kp);
    return kp;
  }

  token(k: PublicKey): bigint {
    const a = this.svm.getAccount(k);
    return a && a.data.length >= 72 ? Buffer.from(a.data).readBigUInt64LE(64) : 0n;
  }

  usdc(u: Keypair) {
    return this.token(ata(u.publicKey, this.usdcMint));
  }

  /** Resting orders decoded from the OrderBook account. */
  orders(m: Market): { side: "BID" | "ASK"; price: number; owner: string; orderId: bigint; qty: bigint; tag: number }[] {
    const a = this.svm.getAccount(m.book);
    if (!a || a.data.length < BOOK_LEN) return [];
    const buf = Buffer.from(a.data);
    const out = [];
    for (const side of [0, 1]) {
      for (let price = 1; price <= LEVELS; price++) {
        const lvl = HEADER + (side * LEVELS + price - 1) * LEVEL_SIZE;
        for (let i = 0; i < buf.readUInt8(lvl); i++) {
          const o = lvl + 8 + i * ORDER_SIZE;
          out.push({
            side: side === 0 ? ("BID" as const) : ("ASK" as const), price, owner: new PublicKey(buf.subarray(o, o + 32)).toBase58(),
            orderId: buf.readBigUInt64LE(o + 32), qty: buf.readBigUInt64LE(o + 40), tag: buf.readUInt8(o + 48),
          });
        }
      }
    }
    return out;
  }

  ledger(m: Market, owner: PublicKey): { freeUsdc: bigint; lockedUsdc: bigint; freeYes: bigint; lockedYes: bigint; pendingBuyNo: bigint } | null {
    const a = this.svm.getAccount(ledgerPda(m.address, owner));
    if (!a || a.data.length === 0) return null;
    const d = coder.accounts.decode("UserLedger", Buffer.from(a.data)) as Record<string, { toString(): string }>;
    const g = (k: string) => BigInt(d[k]!.toString());
    return { freeUsdc: g("free_usdc"), lockedUsdc: g("locked_usdc"), freeYes: g("free_yes"), lockedYes: g("locked_yes"), pendingBuyNo: g("pending_buy_no") };
  }

  /** Writes the Indexer's Redis view of `m` (market, book index, users' positions and open orders). */
  async syncRedis(redis: Redis, symbol: string, m: Market, extra: Record<string, string> = {}) {
    const id = m.address.toBase58();
    const orders = this.orders(m);
    const p = redis.multi();
    p.hset(K.mkt(id), {
      symbol, date: String(DATE), strike_cents: m.strikeCents.toString(), status: "TRADING", outcome: "", yes_mint: m.yesMint.toBase58(),
      no_mint: m.noMint.toBase58(), vault: m.vault.toBase58(), book: m.book.toBase58(), ticker_day: m.tickerDay.toBase58(),
      open_time: String(T.open), close_time: String(T.close), seq: "1", ...extra,
    });
    p.hset(K.tday(symbol, DATE), { mint_open_time: String(T.mintOpen), open_time: String(T.open), close_time: extra.close_time ?? String(T.close) });
    p.zadd(K.dayStrikes(DATE, symbol), Number(m.strikeCents), id);
    p.del(K.ord(id));
    for (const o of orders) {
      p.hset(K.ord(id), o.orderId.toString(), JSON.stringify({ owner: o.owner, side: o.side, price: o.price, qty: Number(o.qty), tag: o.tag === 1 ? "BUY_NO" : "NONE" }));
    }
    for (const u of this.users.values()) {
      const o = u.publicKey.toBase58();
      const l = this.ledger(m, u.publicKey) ?? { freeUsdc: 0n, lockedUsdc: 0n, freeYes: 0n, lockedYes: 0n, pendingBuyNo: 0n };
      const yes = this.token(ata(u.publicKey, m.yesMint)) + l.freeYes + l.lockedYes;
      const no = this.token(ata(u.publicKey, m.noMint));
      p.hset(K.pos(o), id, JSON.stringify({
        yes: Number(yes), no: Number(no), ledger_usdc: l.freeUsdc.toString(), ledger_yes: Number(l.freeYes), avg_yes: 0, avg_no: 0,
        yes_cost: "0", no_cost: "0", realized: "0", pending_no: Number(l.pendingBuyNo), redeemed: false, last_seq: "1",
      }));
      for (const k of await redis.hkeys(K.oo(o))) if (k.startsWith(`${id}:`)) p.hdel(K.oo(o), k);
      for (const x of orders.filter((y) => y.owner === o)) {
        p.hset(K.oo(o), `${id}:${x.orderId}`, JSON.stringify({
          market: id, order_id: x.orderId.toString(), owner: o, side: x.side, price: x.price, qty: Number(x.qty), qty_original: Number(x.qty),
          qty_filled: 0, tif: "GTC", tag: x.tag === 1 ? "BUY_NO" : "NONE", intent: x.tag === 1 ? "BUY_NO" : x.side === "BID" ? "BUY_YES" : "SELL_YES", status: "OPEN",
        }));
      }
    }
    await p.exec();
  }

  // ---- direct setup actions (a maker quoting, outside the Tx Builder) ----
  private tradeKeys(user: PublicKey, m: Market) {
    return {
      user, config: configPda(), ticker_day: m.tickerDay, market: m.address, book: m.book, base_vault: seeded("base", m.address),
      quote_vault: seeded("quote", m.address), vault: m.vault, yes_mint: m.yesMint, no_mint: m.noMint, ledger: ledgerPda(m.address, user),
      user_usdc: ata(user, this.usdcMint), user_yes: ata(user, m.yesMint), user_no: ata(user, m.noMint),
      token_program: TOKEN_PROGRAM_ID, associated_token_program: ATA_PROGRAM_ID, system_program: SystemProgram.programId, event_authority: eventAuthority(),
    };
  }

  mint(u: Keypair, m: Market, n: bigint) {
    this.send([new TransactionInstruction({ programId: PROGRAM_ID, keys: metas("mint_pair", this.tradeKeys(u.publicKey, m)), data: coder.instruction.encode("mint_pair", { n: new BN(n.toString()) }) })], [u]);
  }

  place(u: Keypair, m: Market, side: "bid" | "ask", price: number, qty: bigint) {
    this.send([new TransactionInstruction({
      programId: PROGRAM_ID, keys: metas("place_order", this.tradeKeys(u.publicKey, m)),
      data: coder.instruction.encode("place_order", { side: side === "bid" ? { Bid: {} } : { Ask: {} }, price, qty: new BN(qty.toString()), tif: { Gtc: {} }, client_id: new BN(1) }),
    })], [u]);
  }
}
