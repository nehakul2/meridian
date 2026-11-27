/**
 * Meridian program client for Automation: account reads, instruction builders and a
 * send path with typed errors. Transport (RPC or LiteSVM in tests) sits behind
 * `AccountReader` and `TxSender`, so the jobs run the same code in both.
 *
 * Keys (D23): the morning job signs with `market_creator`, the settler with `settler`;
 * cranks are permissionless and sign with the automation fee payer only. No admin key
 * is ever loaded here (SEC-06).
 */
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Connection, Keypair, PublicKey, Signer, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { BOOK_LEN, BookView, decodeBook, TAG_BUY_NO } from "./book.js";
import { coder, errorName, metas, PROGRAM_ID } from "./idl.js";
import {
  ata, bondAuthority, configPda, disputePda, eventAuthority, ledgerPda, marketPda, seeded, tickerDayPda, TOKEN_PROGRAM_ID,
} from "./pdas.js";

export interface RawAccount {
  data: Uint8Array;
  owner: PublicKey;
  lamports: number;
}

export interface AccountReader {
  getAccount(key: PublicKey): Promise<RawAccount | null>;
  /** Every Market account whose `ticker_day` is `td` (getProgramAccounts on RPC). */
  findMarkets(td: PublicKey): Promise<PublicKey[]>;
}

export interface SendOpts {
  computeUnits?: number;
  /** Priority fee in micro-lamports per CU (SJ-08). */
  priorityMicroLamports?: number;
  lookupTables?: AddressLookupTableAccount[];
}

export interface TxSender {
  /** Sends and confirms; the first signer pays. Throws ProgramError / ChainError. */
  send(ixs: TransactionInstruction[], signers: Signer[], opts?: SendOpts): Promise<string>;
}

/** A Meridian (or other program) custom error, e.g. 6044 ConfidenceStraddle. */
export class ProgramError extends Error {
  constructor(public readonly code: number, public readonly errName: string | undefined, public readonly logs: string[] = []) {
    super(`program error ${code}${errName ? ` ${errName}` : ""}`);
  }
}

/** Transport-level failure: worth retrying. */
export class ChainError extends Error {
  constructor(message: string, public readonly retryable = true) {
    super(message);
  }
}

export function isProgramError(e: unknown, ...names: string[]): e is ProgramError {
  return e instanceof ProgramError && (names.length === 0 || names.includes(e.errName ?? ""));
}

/** Pulls a custom program error code out of RPC error text, logs or a tx `err` object. */
export function parseProgramError(e: unknown, logs: string[] = []): ProgramError | null {
  const ie = (e as { InstructionError?: [number, { Custom?: number }] } | null)?.InstructionError;
  if (ie && typeof ie[1]?.Custom === "number") return new ProgramError(ie[1].Custom, errorName(ie[1].Custom), logs);
  const text = [String((e as Error)?.message ?? e), ...logs].join("\n");
  const n = /Error Number: (\d+)/.exec(text);
  if (n) return new ProgramError(Number(n[1]), errorName(Number(n[1])), logs);
  const hex = /custom program error: 0x([0-9a-fA-F]+)/.exec(text);
  if (hex) {
    const code = parseInt(hex[1]!, 16);
    return new ProgramError(code, errorName(code), logs);
  }
  return null;
}

export type TickerDayStatus = "Open" | "Provisional" | "Disputed" | "Final";
export type MarketStatus = "Trading" | "Halted" | "Settled" | "Void";

export interface TickerDayAccount {
  address: PublicKey;
  ticker: string;
  date: number;
  mintOpenTime: number;
  openTime: number;
  closeTime: number;
  status: TickerDayStatus;
  finalBasis: string;
  recordedAt: number;
  price: bigint;
  expo: number;
  closeSource: string;
  refConf: bigint;
  strikeCount: number;
  finalizedAt: number;
}

export interface MarketAccount {
  address: PublicKey;
  tickerDay: PublicKey;
  ticker: string;
  date: number;
  strikeCents: bigint;
  yesMint: PublicKey;
  noMint: PublicKey;
  vault: PublicKey;
  book: PublicKey;
  pairsOutstanding: bigint;
  collateralAccounted: bigint;
  status: MarketStatus;
  outcome: string;
  totalTrades: bigint;
  seq: bigint;
}

export interface ConfigAccount {
  admin: PublicKey;
  marketCreator: PublicKey;
  settler: PublicKey;
  paused: boolean;
  feeVault: PublicKey;
  usdcMint: PublicKey;
  settleWindowS: number;
  disputeWindowS: number;
  disputeResolutionS: number;
  overrideDelayS: number;
  bondVault: PublicKey;
  closeToleranceBps: number;
  tickers: { symbol: string; feedId: Buffer }[];
}

type Decoded = Record<string, any>;
const variant = (v: Decoded) => {
  const k = Object.keys(v)[0]!;
  return k.charAt(0).toUpperCase() + k.slice(1);
};
const sym = (b: number[]) => Buffer.from(b).toString("utf8").replace(/\0+$/, "");
const num = (v: { toString(): string }) => Number(v.toString());
const big = (v: { toString(): string }) => BigInt(v.toString());

export function decodeTickerDay(address: PublicKey, data: Uint8Array): TickerDayAccount {
  const d = coder.accounts.decode("TickerDay", Buffer.from(data)) as Decoded;
  return {
    address,
    ticker: sym(d.ticker),
    date: d.date,
    mintOpenTime: num(d.mint_open_time),
    openTime: num(d.open_time),
    closeTime: num(d.close_time),
    status: variant(d.status) as TickerDayStatus,
    finalBasis: variant(d.final_basis),
    recordedAt: num(d.recorded_at),
    price: big(d.price),
    expo: d.expo,
    closeSource: variant(d.close_source),
    refConf: big(d.ref_conf),
    strikeCount: d.strike_count,
    finalizedAt: num(d.finalized_at),
  };
}

export function decodeMarket(address: PublicKey, data: Uint8Array): MarketAccount {
  const d = coder.accounts.decode("Market", Buffer.from(data)) as Decoded;
  return {
    address,
    tickerDay: d.ticker_day,
    ticker: sym(d.ticker),
    date: d.date,
    strikeCents: big(d.strike_cents),
    yesMint: d.yes_mint,
    noMint: d.no_mint,
    vault: d.vault,
    book: d.book,
    pairsOutstanding: big(d.pairs_outstanding),
    collateralAccounted: big(d.collateral_accounted),
    status: variant(d.status) as MarketStatus,
    outcome: variant(d.outcome),
    totalTrades: big(d.total_trades),
    seq: big(d.seq),
  };
}

/** Number of grow_book calls that take a fresh book to full size (MER-20). */
export const BOOK_GROWTH_STEP = 10_240;
export const GROW_STEPS = Math.ceil((BOOK_LEN - BOOK_GROWTH_STEP) / BOOK_GROWTH_STEP);

export interface ChainKeys {
  /** Pays fees and rent (D28): the automation wallet. */
  payer: Keypair;
  creator?: Keypair;
  settler?: Keypair;
}

export class MeridianChain {
  private cfg: ConfigAccount | null = null;

  constructor(
    readonly reader: AccountReader,
    readonly sender: TxSender,
    readonly keys: ChainKeys,
    readonly opts: { priorityMicroLamports?: number } = {},
  ) {}

  async config(refresh = false): Promise<ConfigAccount> {
    if (this.cfg && !refresh) return this.cfg;
    const a = await this.reader.getAccount(configPda());
    if (!a) throw new ChainError("Config account not initialised", false);
    const d = coder.accounts.decode("Config", Buffer.from(a.data)) as Decoded;
    this.cfg = {
      admin: d.admin,
      marketCreator: d.market_creator,
      settler: d.settler,
      paused: d.paused,
      feeVault: d.fee_vault,
      usdcMint: d.usdc_mint,
      settleWindowS: num(d.settle_window_s),
      disputeWindowS: num(d.dispute_window_s),
      disputeResolutionS: num(d.dispute_resolution_s),
      overrideDelayS: num(d.override_delay_s),
      bondVault: d.bond_vault,
      closeToleranceBps: d.close_tolerance_bps,
      tickers: (d.tickers as Decoded[]).filter((t) => t.symbol[0] !== 0).map((t) => ({ symbol: sym(t.symbol), feedId: Buffer.from(t.feed_id) })),
    };
    return this.cfg;
  }

  async tickerDay(ticker: string, date: number): Promise<TickerDayAccount | null> {
    const k = tickerDayPda(ticker, date);
    const a = await this.reader.getAccount(k);
    return a ? decodeTickerDay(k, a.data) : null;
  }

  async market(address: PublicKey): Promise<MarketAccount | null> {
    const a = await this.reader.getAccount(address);
    return a ? decodeMarket(address, a.data) : null;
  }

  async markets(td: PublicKey): Promise<MarketAccount[]> {
    const keys = await this.reader.findMarkets(td);
    const out: MarketAccount[] = [];
    for (const k of keys) {
      const m = await this.market(k);
      if (m && m.tickerDay.equals(td)) out.push(m);
    }
    return out.sort((a, b) => (a.strikeCents < b.strikeCents ? -1 : a.strikeCents > b.strikeCents ? 1 : 0));
  }

  async book(m: MarketAccount): Promise<BookView | null> {
    const a = await this.reader.getAccount(m.book);
    if (!a || a.data.length === 0) return null;
    return decodeBook(a.data);
  }

  private send(ixs: TransactionInstruction[], signers: Signer[], extra: SendOpts = {}) {
    return this.sender.send(ixs, signers, { priorityMicroLamports: this.opts.priorityMicroLamports, ...extra });
  }

  private need(k: keyof ChainKeys): Keypair {
    const kp = this.keys[k];
    if (!kp) throw new Error(`${k} key not loaded in this process`);
    return kp;
  }

  // ---- morning job (market_creator) ----

  ixCreateTickerDay(ticker: string, date: number, mintOpen: number, open: number, close: number): TransactionInstruction {
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("create_ticker_day", {
        payer: this.keys.payer.publicKey,
        creator: this.need("creator").publicKey,
        config: configPda(),
        ticker_day: tickerDayPda(ticker, date),
        system_program: SystemProgram.programId,
      }),
      data: coder.instruction.encode("create_ticker_day", {
        ticker, date, mint_open_time: bn(mintOpen), open_time: bn(open), close_time: bn(close),
      }),
    });
  }

  async createTickerDay(ticker: string, date: number, mintOpen: number, open: number, close: number): Promise<string> {
    return this.send([this.ixCreateTickerDay(ticker, date, mintOpen, open, close)], [this.keys.payer, this.need("creator")]);
  }

  async ixsCreateMarket(ticker: string, date: number, strike: bigint): Promise<TransactionInstruction[]> {
    const cfg = await this.config();
    const market = marketPda(ticker, date, strike);
    const create = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("create_strike_market", {
        payer: this.keys.payer.publicKey,
        authority: this.need("creator").publicKey,
        config: configPda(),
        ticker_day: tickerDayPda(ticker, date),
        market,
        yes_mint: seeded("yes", market),
        no_mint: seeded("no", market),
        vault: seeded("vault", market),
        book: seeded("book", market),
        base_vault: seeded("base", market),
        quote_vault: seeded("quote", market),
        usdc_mint: cfg.usdcMint,
        event_authority: eventAuthority(),
      }),
      data: coder.instruction.encode("create_strike_market", { strike_cents: bn(strike) }),
    });
    const grow = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("grow_book", {
        payer: this.keys.payer.publicKey,
        market,
        book: seeded("book", market),
        system_program: SystemProgram.programId,
      }),
      data: coder.instruction.encode("grow_book", {}),
    });
    return [create, ...Array.from({ length: GROW_STEPS }, () => grow)];
  }

  /** create_strike_market plus grow_book to full size, in one transaction. */
  async createStrikeMarket(ticker: string, date: number, strike: bigint): Promise<string> {
    return this.send(await this.ixsCreateMarket(ticker, date, strike), [this.keys.payer, this.need("creator")], {
      computeUnits: 1_400_000,
    });
  }

  // ---- settler ----

  ixRecordClose(td: PublicKey, priceUpdate: PublicKey, official: { price: bigint; expo: number } | null): TransactionInstruction {
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("record_close", {
        settler: this.need("settler").publicKey,
        config: configPda(),
        ticker_day: td,
        price_update: priceUpdate,
        event_authority: eventAuthority(),
      }),
      data: coder.instruction.encode("record_close", {
        official: official ? { price: bn(official.price), expo: official.expo } : null,
      }),
    });
  }

  // ---- cranks (permissionless) ----

  async finalizeClose(td: TickerDayAccount): Promise<string> {
    const cfg = await this.config();
    const dp = disputePda(td.address);
    const dispute = await this.reader.getAccount(dp);
    let keys: Record<string, PublicKey | null> = { dispute: null, bond_vault: null, bond_authority: null, disputer_usdc: null, token_program: null };
    if (dispute) {
      const d = coder.accounts.decode("Dispute", Buffer.from(dispute.data)) as Decoded;
      keys = {
        dispute: dp,
        bond_vault: cfg.bondVault,
        bond_authority: bondAuthority(),
        disputer_usdc: ata(d.disputer, cfg.usdcMint),
        token_program: TOKEN_PROGRAM_ID,
      };
    }
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("finalize_close", { config: configPda(), ticker_day: td.address, ...keys, event_authority: eventAuthority() }),
      data: coder.instruction.encode("finalize_close", {}),
    });
    return this.send([ix], [this.keys.payer]);
  }

  ixSettleMarket(m: MarketAccount): TransactionInstruction {
    return new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("settle_market", {
        ticker_day: m.tickerDay, market: m.address, vault: m.vault, yes_mint: m.yesMint, no_mint: m.noMint,
        event_authority: eventAuthority(),
      }),
      data: coder.instruction.encode("settle_market", {}),
    });
  }

  async settleMarket(m: MarketAccount): Promise<string> {
    return this.send([this.ixSettleMarket(m)], [this.keys.payer]);
  }

  /**
   * The next prune batch: the first resting orders in book order whose remaining
   * accounts (owner ledger, plus the No ATA of a BUY_NO owner) fit in one transaction.
   */
  pruneBatch(m: MarketAccount, book: BookView, maxAccounts = 20, maxOrders = 64): { count: number; remaining: PublicKey[] } {
    const remaining: PublicKey[] = [];
    const seen = new Set<string>();
    let count = 0;
    for (const o of book.orders) {
      const add: PublicKey[] = [];
      const l = ledgerPda(m.address, o.owner);
      if (!seen.has(l.toBase58())) add.push(l);
      if (o.tag === TAG_BUY_NO) {
        const n = ata(o.owner, m.noMint);
        if (!seen.has(n.toBase58())) add.push(n);
      }
      if (count > 0 && (remaining.length + add.length > maxAccounts || count >= maxOrders)) break;
      for (const k of add) {
        seen.add(k.toBase58());
        remaining.push(k);
      }
      count++;
    }
    return { count, remaining };
  }

  async pruneOrders(m: MarketAccount, max: number, remaining: PublicKey[]): Promise<string> {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        ...metas("prune_orders", {
          ticker_day: m.tickerDay, market: m.address, book: m.book, base_vault: seeded("base", m.address),
          quote_vault: seeded("quote", m.address), vault: m.vault, yes_mint: m.yesMint, no_mint: m.noMint,
          event_authority: eventAuthority(),
        }),
        ...remaining.map((k) => ({ pubkey: k, isSigner: false, isWritable: true })),
      ],
      data: coder.instruction.encode("prune_orders", { max }),
    });
    return this.send([ix], [this.keys.payer], { computeUnits: 1_400_000 });
  }

  async closeBook(m: MarketAccount): Promise<string> {
    const cfg = await this.config();
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("close_book", {
        config: configPda(), market: m.address, book: m.book, rent_receiver: cfg.marketCreator,
        quote_vault: seeded("quote", m.address), fee_vault: cfg.feeVault, event_authority: eventAuthority(),
      }),
      data: coder.instruction.encode("close_book", {}),
    });
    return this.send([ix], [this.keys.payer]);
  }
}

/** Anchor's Borsh coder wants BN for 64-bit ints. */
function bn(v: number | bigint): BN {
  return new BN(v.toString());
}

// ---- RPC transport ----

/** RPC sender: v0 transactions, compute budget, fresh blockhash and raised fee on expiry (SJ-08). */
export class RpcSender implements TxSender {
  constructor(
    private readonly conn: Connection,
    private readonly o: { maxAttempts?: number; maxPriorityMicroLamports?: number } = {},
  ) {}

  async send(ixs: TransactionInstruction[], signers: Signer[], opts: SendOpts = {}): Promise<string> {
    let fee = opts.priorityMicroLamports ?? 0;
    const attempts = this.o.maxAttempts ?? 4;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
      const all = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits ?? 400_000 }),
        ...(fee > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: fee })] : []),
        ...ixs,
      ];
      const msg = new TransactionMessage({ payerKey: signers[0]!.publicKey, recentBlockhash: blockhash, instructions: all })
        .compileToV0Message(opts.lookupTables);
      const tx = new VersionedTransaction(msg);
      tx.sign(signers);
      try {
        const sig = await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 0 });
        const res = await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (res.value.err) throw parseProgramError(res.value.err) ?? new ChainError(JSON.stringify(res.value.err), false);
        return sig;
      } catch (e) {
        if (e instanceof ProgramError) throw e;
        const logs = (e as { logs?: string[] }).logs ?? [];
        const pe = parseProgramError(e, logs);
        if (pe) throw pe;
        const text = String((e as Error).message ?? e);
        last = e;
        if (/block height exceeded|Blockhash not found|expired/i.test(text)) {
          fee = Math.min(Math.max(fee * 2, 1_000), this.o.maxPriorityMicroLamports ?? 1_000_000);
          continue;
        }
        throw new ChainError(text, true);
      }
    }
    throw new ChainError(`not confirmed after ${attempts} attempts: ${String((last as Error)?.message ?? last)}`, true);
  }
}

/** RPC reader. findMarkets uses getProgramAccounts filtered on Market.ticker_day. */
export class RpcReader implements AccountReader {
  constructor(private readonly conn: Connection) {}

  async getAccount(key: PublicKey): Promise<RawAccount | null> {
    const a = await this.conn.getAccountInfo(key, "confirmed");
    return a ? { data: a.data, owner: a.owner, lamports: a.lamports } : null;
  }

  async findMarkets(td: PublicKey): Promise<PublicKey[]> {
    const disc = coder.accounts.memcmp("Market");
    const res = await this.conn.getProgramAccounts(PROGRAM_ID, {
      commitment: "confirmed",
      dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: disc.offset ?? 0, bytes: disc.bytes! } }, { memcmp: { offset: 8, bytes: td.toBase58() } }],
    });
    return res.map((r) => r.pubkey);
  }
}

export { marketPda, tickerDayPda };
