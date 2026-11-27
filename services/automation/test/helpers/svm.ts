/**
 * LiteSVM harness: the real Meridian program (target/deploy/meridian.so) behind the same
 * AccountReader / TxSender / PriceUpdatePoster interfaces the service uses on RPC. The
 * SVM clock follows the test's fake clock, so jobs, chain and alerts share one timeline.
 */
import { BorshCoder } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, Signer, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Clock as SvmClock, FailedTransactionMetadata, LiteSVM, TransactionMetadata } from "litesvm";
import {
  AccountReader, ChainError, MeridianChain, parseProgramError, RawAccount, SendOpts, TxSender,
} from "../../src/chain/client.js";
import { coder, IDL, metas, PROGRAM_ID } from "../../src/chain/idl.js";
import {
  ata, ATA_PROGRAM_ID, configPda, eventAuthority, ledgerPda, PYTH_RECEIVER_ID, seeded, TOKEN_PROGRAM_ID,
} from "../../src/chain/pdas.js";
import type { PriceUpdatePoster } from "../../src/chain/pyth.js";
import type { OracleUpdateRow } from "../../src/store/types.js";
import type { Clock } from "../../src/time.js";

export const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
export const feedId = (i: number) => Buffer.alloc(32, i + 1);
export const feedHex = (sym: string) => feedId(MAG7.indexOf(sym)).toString("hex");

const here = dirname(fileURLToPath(import.meta.url));
export const SO_PATH = join(here, "../../../../target/deploy/meridian.so");
export const haveProgram = existsSync(SO_PATH);
if (process.env.REQUIRE_PROGRAM && !haveProgram) {
  throw new Error(`REQUIRE_PROGRAM is set but ${SO_PATH} is missing: run \`make build\` first`);
}

const LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** PriceUpdateV2 bytes as the receiver writes them; tests use these as the Hermes "VAA". */
export function priceUpdateBytes(u: { feed: Buffer; price: bigint; conf: bigint; expo: number; publishTime: number; partial?: boolean }): Uint8Array {
  const b: Buffer[] = [];
  b.push(Buffer.from([34, 241, 35, 99, 157, 126, 244, 205])); // discriminator
  b.push(Buffer.alloc(32, 7)); // write_authority
  b.push(u.partial ? Buffer.from([0, 3]) : Buffer.from([1])); // verification level
  b.push(u.feed);
  const i64 = (v: bigint) => { const x = Buffer.alloc(8); x.writeBigInt64LE(v); return x; };
  const u64 = (v: bigint) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(v); return x; };
  const i32 = (v: number) => { const x = Buffer.alloc(4); x.writeInt32LE(v); return x; };
  b.push(i64(u.price), u64(u.conf), i32(u.expo), i64(BigInt(u.publishTime)), i64(BigInt(u.publishTime - 1)), i64(u.price), u64(u.conf), u64(1n));
  return new Uint8Array(Buffer.concat(b));
}

function mintData(authority: PublicKey | null, decimals: number, supply = 0n): Uint8Array {
  const d = Buffer.alloc(82);
  if (authority) {
    d.writeUInt32LE(1, 0);
    authority.toBuffer().copy(d, 4);
  }
  d.writeBigUInt64LE(supply, 36);
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

export class SvmEnv implements AccountReader, TxSender, PriceUpdatePoster {
  readonly svm: LiteSVM;
  readonly deployer = Keypair.generate();
  readonly admin = Keypair.generate();
  readonly creator = Keypair.generate();
  readonly settler = Keypair.generate();
  readonly payer = Keypair.generate();
  readonly usdcMint = Keypair.generate().publicKey;
  readonly feeVault = Keypair.generate().publicKey;
  readonly bondVault = Keypair.generate().publicKey;
  /** Every account key seen in a sent transaction (stands in for getProgramAccounts). */
  private readonly seen = new Set<string>();
  /** Fault injection for the next sends: throw after executing, or before. */
  faults: { kind: "TIMEOUT_AFTER_LANDING" | "FAIL_BEFORE" | "EXPIRED_BLOCKHASH"; match?: (ixs: TransactionInstruction[]) => boolean }[] = [];
  /** Every successful send, with its instructions and priority fee. */
  readonly sent: { ixs: TransactionInstruction[]; priority?: number; signers: string[] }[] = [];
  /** Every record_close price-update payload posted (SJ-02). */
  readonly posted: Uint8Array[] = [];

  constructor(readonly clock: Clock) {
    this.svm = new LiteSVM();
    this.deploy();
    for (const k of [this.deployer, this.admin, this.creator, this.settler, this.payer]) {
      this.svm.airdrop(k.publicKey, 1_000_000_000_000n);
    }
    this.putAccount(this.usdcMint, mintData(Keypair.generate().publicKey, 6), TOKEN_PROGRAM_ID);
    this.putAccount(this.feeVault, tokenAccountData(this.usdcMint, this.admin.publicKey, 0n), TOKEN_PROGRAM_ID);
    const bondAuth = PublicKey.findProgramAddressSync([Buffer.from("bond")], PROGRAM_ID)[0];
    this.putAccount(this.bondVault, tokenAccountData(this.usdcMint, bondAuth, 0n), TOKEN_PROGRAM_ID);
    this.syncClock();
    this.initializeConfig();
  }

  private deploy() {
    const elf = readFileSync(SO_PATH);
    const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER_UPGRADEABLE)[0];
    const meta = Buffer.alloc(45);
    meta.writeUInt32LE(3, 0); // ProgramData
    meta.writeBigUInt64LE(0n, 4); // slot
    meta.writeUInt8(1, 12); // Some(authority)
    this.deployer.publicKey.toBuffer().copy(meta, 13);
    this.putAccount(programData, new Uint8Array(Buffer.concat([meta, elf])), LOADER_UPGRADEABLE);
    const prog = Buffer.alloc(36);
    prog.writeUInt32LE(2, 0); // Program
    programData.toBuffer().copy(prog, 4);
    this.putAccount(PROGRAM_ID, new Uint8Array(prog), LOADER_UPGRADEABLE, true);
  }

  putAccount(address: PublicKey, data: Uint8Array, owner: PublicKey, executable = false) {
    const lamports = Number(this.svm.minimumBalanceForRentExemption(BigInt(data.length)));
    this.svm.setAccount(address, { lamports, data, owner, executable, rentEpoch: 0 });
  }

  syncClock() {
    const c = this.svm.getClock();
    const now = BigInt(this.clock.now());
    this.svm.setClock(new SvmClock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, now));
  }

  private initializeConfig() {
    const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER_UPGRADEABLE)[0];
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("initialize_config", {
        deployer: this.deployer.publicKey, config: configPda(), usdc_mint: this.usdcMint,
        program: PROGRAM_ID, program_data: programData, system_program: SystemProgram.programId,
      }),
      data: coder.instruction.encode("initialize_config", {
        args: {
          admin: this.admin.publicKey, market_creator: this.creator.publicKey, settler: this.settler.publicKey,
          fee_vault: this.feeVault, bond_vault: this.bondVault,
          tickers: MAG7.map((s, i) => ({ symbol: s, feed_id: [...feedId(i)] })),
        },
      }),
    });
    this.sendSync([ix], [this.deployer]);
  }

  chain(opts: { priorityMicroLamports?: number } = {}): MeridianChain {
    return new MeridianChain(this, this, { payer: this.payer, creator: this.creator, settler: this.settler }, opts);
  }

  // ---- AccountReader ----
  async getAccount(key: PublicKey): Promise<RawAccount | null> {
    const a = this.svm.getAccount(key);
    if (!a || (a.lamports === 0 && a.data.length === 0)) return null;
    return { data: a.data, owner: a.owner, lamports: a.lamports };
  }

  async findMarkets(td: PublicKey): Promise<PublicKey[]> {
    const disc = Buffer.from((IDL.accounts ?? []).find((a) => a.name === "Market")!.discriminator);
    const out: PublicKey[] = [];
    for (const k of this.seen) {
      const a = this.svm.getAccount(new PublicKey(k));
      if (!a || !a.owner.equals(PROGRAM_ID) || a.data.length < 40) continue;
      if (Buffer.from(a.data.subarray(0, 8)).equals(disc) && Buffer.from(a.data.subarray(8, 40)).equals(td.toBuffer())) {
        out.push(new PublicKey(k));
      }
    }
    return out;
  }

  // ---- TxSender ----
  sendSync(ixs: TransactionInstruction[], signers: Signer[]): TransactionMetadata {
    this.syncClock();
    this.svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = signers[0]!.publicKey;
    tx.add(...ixs);
    tx.sign(...signers);
    for (const ix of ixs) for (const k of ix.keys) this.seen.add(k.pubkey.toBase58());
    const res = this.svm.sendTransaction(tx);
    if (res instanceof FailedTransactionMetadata) {
      // Read the error from the logs first and touch the native error objects only when the
      // logs do not name it: on GitHub's runners, formatting a failed result (toString) aborted
      // the Vitest worker with std::bad_alloc.
      const mode = process.env.SVM_ERR_MODE;
      if (mode === "none") throw new ChainError("transaction failed (SVM_ERR_MODE=none)", false);
      if (mode === "string") {
        const text = res.toString();
        throw parseProgramError(null, [text]) ?? new ChainError(`transaction failed: ${text}`, false);
      }
      const logs = res.meta().logs();
      const fromLogs = parseProgramError(null, logs);
      if (fromLogs) throw fromLogs;
      const err = res.err() as unknown as { err?: () => { code?: number } };
      const inner = typeof err.err === "function" ? err.err() : undefined;
      if (inner && typeof inner.code === "number") {
        throw parseProgramError({ InstructionError: [0, { Custom: inner.code }] }, logs)!;
      }
      throw new ChainError(`transaction failed: ${String(err)}\n${logs.join("\n")}`, false);
    }
    return res;
  }

  async send(ixs: TransactionInstruction[], signers: Signer[], opts: SendOpts = {}): Promise<string> {
    const fi = this.faults.findIndex((f) => !f.match || f.match(ixs));
    const fault = fi >= 0 ? this.faults.splice(fi, 1)[0] : undefined;
    if (fault?.kind === "FAIL_BEFORE") throw new ChainError("injected RPC failure", true);
    if (fault?.kind === "EXPIRED_BLOCKHASH") throw new ChainError("Blockhash not found", true);
    const res = this.sendSync(ixs, signers);
    this.sent.push({ ixs, priority: opts.priorityMicroLamports, signers: signers.map((s) => s.publicKey.toBase58()) });
    if (fault?.kind === "TIMEOUT_AFTER_LANDING") throw new ChainError("confirmation timed out", true);
    return Buffer.from(res.signature()).toString("hex").slice(0, 32);
  }

  // ---- PriceUpdatePoster: the stored "VAA" bytes are a PriceUpdateV2 account image ----
  async postAndConsume(update: OracleUpdateRow, _feed: string, signer: Keypair, consume: (a: PublicKey) => TransactionInstruction[]): Promise<string[]> {
    this.posted.push(new Uint8Array(update.vaa));
    const acct = Keypair.generate().publicKey;
    this.putAccount(acct, update.vaa, PYTH_RECEIVER_ID);
    return [await this.send(consume(acct), [signer])];
  }

  // ---- user-side helpers for crank tests ----
  user(usdc: bigint): Keypair {
    const kp = Keypair.generate();
    this.svm.airdrop(kp.publicKey, 10_000_000_000n);
    this.putAccount(ata(kp.publicKey, this.usdcMint), tokenAccountData(this.usdcMint, kp.publicKey, usdc), TOKEN_PROGRAM_ID);
    return kp;
  }

  private tradeKeys(user: PublicKey, m: { address: PublicKey; tickerDay: PublicKey; yesMint: PublicKey; noMint: PublicKey; vault: PublicKey; book: PublicKey }) {
    return {
      user, config: configPda(), ticker_day: m.tickerDay, market: m.address, book: m.book,
      base_vault: seeded("base", m.address), quote_vault: seeded("quote", m.address), vault: m.vault,
      yes_mint: m.yesMint, no_mint: m.noMint, ledger: ledgerPda(m.address, user),
      user_usdc: ata(user, this.usdcMint), user_yes: ata(user, m.yesMint), user_no: ata(user, m.noMint),
      token_program: TOKEN_PROGRAM_ID, associated_token_program: ATA_PROGRAM_ID, system_program: SystemProgram.programId,
      event_authority: eventAuthority(),
    };
  }

  mintPair(user: Keypair, m: Parameters<SvmEnv["tradeKeys"]>[1], n: bigint) {
    const k = this.tradeKeys(user.publicKey, m);
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("mint_pair", k),
      data: coder.instruction.encode("mint_pair", { n: new BN(n.toString()) }),
    });
    this.sendSync([ix], [user]);
  }

  /** A resting GTC order (no makers passed, so it must not cross). */
  place(user: Keypair, m: Parameters<SvmEnv["tradeKeys"]>[1], side: "bid" | "ask", price: number, qty: bigint) {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("place_order", this.tradeKeys(user.publicKey, m)),
      data: coder.instruction.encode("place_order", {
        side: side === "bid" ? { Bid: {} } : { Ask: {} }, price, qty: new BN(qty.toString()), tif: { Gtc: {} }, client_id: new BN(1),
      }),
    });
    this.sendSync([ix], [user]);
  }

  buyNoLimit(user: Keypair, m: Parameters<SvmEnv["tradeKeys"]>[1], yesPrice: number, qty: bigint) {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: metas("buy_no_limit", this.tradeKeys(user.publicKey, m)),
      data: coder.instruction.encode("buy_no_limit", { qty: new BN(qty.toString()), yes_price: yesPrice }),
    });
    this.sendSync([ix], [user]);
  }

  tokenBalance(k: PublicKey): bigint {
    const a = this.svm.getAccount(k);
    return a ? Buffer.from(a.data).readBigUInt64LE(64) : 0n;
  }
}

export { BorshCoder };
