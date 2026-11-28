/**
 * The local validator stand-in for the devnet scripts: the real program (target/deploy/meridian.so)
 * in LiteSVM behind the same Cluster interface the scripts use on devnet. The chain clock is
 * test-controlled, so waiting for close or for the dispute window is instant.
 */
import {
  ComputeBudgetProgram, Keypair, PublicKey, Signer, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Clock as SvmClock, FailedTransactionMetadata, LiteSVM } from "litesvm";
import { AccountReader, ChainError, parseProgramError, RawAccount, SendOpts, TxSender } from "../../../services/automation/src/chain/client.js";
import { coder, IDL, PROGRAM_ID } from "../../../services/automation/src/chain/idl.js";
import { PYTH_RECEIVER_ID } from "../../../services/automation/src/chain/pdas.js";
import type { PriceUpdatePoster } from "../../../services/automation/src/chain/pyth.js";
import type { HermesUpdate } from "../../../services/automation/src/oracle/hermes.js";
import type { OracleUpdateRow } from "../../../services/automation/src/store/types.js";
import type { CloseOracle, Cluster, ProgramDeployer } from "../../devnet/cluster.js";

const here = dirname(fileURLToPath(import.meta.url));
export const SO_PATH = join(here, "../../../target/deploy/meridian.so");
export const IDL_PATH = join(here, "../../../programs/meridian/idl/meridian.json");
export const haveProgram = existsSync(SO_PATH);
if (process.env.REQUIRE_PROGRAM && !haveProgram) throw new Error(`REQUIRE_PROGRAM is set but ${SO_PATH} is missing: run \`make build\``);

const LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** PriceUpdateV2 account bytes as the Pyth receiver writes them (fully verified). */
export function priceUpdateBytes(u: { feed: Buffer; price: bigint; conf: bigint; expo: number; publishTime: number }): Uint8Array {
  const i64 = (v: bigint) => { const x = Buffer.alloc(8); x.writeBigInt64LE(v); return x; };
  const u64 = (v: bigint) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(v); return x; };
  const i32 = (v: number) => { const x = Buffer.alloc(4); x.writeInt32LE(v); return x; };
  return new Uint8Array(Buffer.concat([
    Buffer.from([34, 241, 35, 99, 157, 126, 244, 205]), Buffer.alloc(32, 7), Buffer.from([1]), u.feed,
    i64(u.price), u64(u.conf), i32(u.expo), i64(BigInt(u.publishTime)), i64(BigInt(u.publishTime - 1)), i64(u.price), u64(u.conf), u64(1n),
  ]));
}

/** Pyth stand-in: a price per feed that the test sets; updates are stamped at the requested second. */
export class FakeOracle implements CloseOracle {
  readonly prices = new Map<string, { price: bigint; conf: bigint; expo: number }>();
  /** Seconds after the requested time that the first update lands (0 = exactly at close). */
  lagS = 0;
  constructor(private readonly now: () => number) {}
  set(feedHex: string, price: bigint, conf = price / 10_000n, expo = -5) {
    this.prices.set(feedHex, { price, conf, expo });
  }
  private make(feedHex: string, t: number): HermesUpdate | null {
    const p = this.prices.get(feedHex);
    if (!p) return null;
    return { publishTime: t, priceRaw: p.price, expo: p.expo, conf: p.conf, vaa: priceUpdateBytes({ feed: Buffer.from(feedHex, "hex"), ...p, publishTime: t }) };
  }
  async latest(feedHex: string) {
    return this.make(feedHex, this.now());
  }
  async updateAtOrAfter(feedHex: string, t: number) {
    return this.make(feedHex, t + this.lagS);
  }
}

export class SvmCluster implements Cluster, AccountReader, TxSender, PriceUpdatePoster, ProgramDeployer {
  readonly kind = "litesvm" as const;
  readonly url = "litesvm://local";
  readonly svm = new LiteSVM();
  readonly oracle: FakeOracle;
  readonly reader = this;
  readonly sender = this;
  readonly poster = this;
  readonly deployer = this;
  /** Every program binary deployed, in order (sha prefix of the ELF). */
  readonly deployments: Buffer[] = [];
  /** Fail the next transaction containing this instruction name (DLC-05 "merge that breaks redeem"). */
  breakInstruction: string | null = null;
  private readonly seen = new Set<string>();
  t: number;

  constructor(start: number, readonly upgradeAuthority: PublicKey) {
    this.t = start;
    this.oracle = new FakeOracle(() => this.t);
    this.syncClock();
  }

  // ---- Cluster ----
  async assertSafe() {}
  async now() {
    return this.t;
  }
  async waitUntil(t: number) {
    if (t > this.t) this.t = t;
    this.syncClock();
  }
  async rentExempt(bytes: number) {
    return Number(this.svm.minimumBalanceForRentExemption(BigInt(bytes)));
  }
  async lamports(k: PublicKey) {
    return Number(this.svm.getBalance(k) ?? 0n) as number;
  }
  airdrop(k: PublicKey, sol: number) {
    this.svm.airdrop(k, BigInt(Math.round(sol * 1e9)));
  }
  advance(s: number) {
    this.t += s;
    this.syncClock();
  }
  private syncClock() {
    const c = this.svm.getClock();
    this.svm.setClock(new SvmClock(c.slot + 1n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, BigInt(this.t)));
  }

  // ---- ProgramDeployer ----
  async deploy(soPath: string) {
    const elf = readFileSync(soPath);
    const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER_UPGRADEABLE)[0];
    const meta = Buffer.alloc(45);
    meta.writeUInt32LE(3, 0);
    meta.writeBigUInt64LE(0n, 4);
    meta.writeUInt8(1, 12);
    this.upgradeAuthority.toBuffer().copy(meta, 13);
    this.put(programData, new Uint8Array(Buffer.concat([meta, elf])), LOADER_UPGRADEABLE);
    const prog = Buffer.alloc(36);
    prog.writeUInt32LE(2, 0);
    programData.toBuffer().copy(prog, 4);
    this.put(PROGRAM_ID, new Uint8Array(prog), LOADER_UPGRADEABLE, true);
    this.deployments.push(elf);
    return { signature: `deploy-${this.deployments.length}` };
  }
  async dump(outPath: string) {
    const last = this.deployments.at(-1);
    if (!last) return false;
    writeFileSync(outPath, last);
    return true;
  }
  private put(address: PublicKey, data: Uint8Array, owner: PublicKey, executable = false) {
    const lamports = Number(this.svm.minimumBalanceForRentExemption(BigInt(data.length)));
    this.svm.setAccount(address, { lamports, data, owner, executable, rentEpoch: 0 });
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
      if (Buffer.from(a.data.subarray(0, 8)).equals(disc) && Buffer.from(a.data.subarray(8, 40)).equals(td.toBuffer())) out.push(new PublicKey(k));
    }
    return out;
  }

  // ---- TxSender ----
  async send(ixs: TransactionInstruction[], signers: Signer[], opts: SendOpts = {}): Promise<string> {
    if (this.breakInstruction) {
      const names = ixs.filter((i) => i.programId.equals(PROGRAM_ID)).map((i) => coder.instruction.decode(Buffer.from(i.data))?.name);
      if (names.includes(this.breakInstruction)) throw new ChainError(`injected failure in ${this.breakInstruction}`, false);
    }
    this.syncClock();
    this.svm.expireBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.feePayer = signers[0]!.publicKey;
    if (opts.computeUnits) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnits }));
    tx.add(...ixs);
    tx.sign(...signers);
    for (const ix of ixs) for (const k of ix.keys) this.seen.add(k.pubkey.toBase58());
    const res = this.svm.sendTransaction(tx);
    if (res instanceof FailedTransactionMetadata) {
      const logs = res.meta().logs();
      const pe = parseProgramError(null, logs);
      if (pe) throw pe;
      const err = res.err() as unknown as { err?: () => { code?: number } };
      const inner = typeof err.err === "function" ? err.err() : undefined;
      if (inner && typeof inner.code === "number") throw parseProgramError({ InstructionError: [0, { Custom: inner.code }] }, logs)!;
      throw new ChainError(`transaction failed: ${String(err)}\n${logs.join("\n")}`, false);
    }
    return Buffer.from(res.signature()).toString("hex").slice(0, 32);
  }

  // ---- PriceUpdatePoster: the "VAA" is the PriceUpdateV2 account image ----
  async postAndConsume(update: OracleUpdateRow, _feed: string, signer: Keypair, consume: (a: PublicKey) => TransactionInstruction[]) {
    const acct = Keypair.generate().publicKey;
    this.put(acct, update.vaa, PYTH_RECEIVER_ID);
    return [await this.send(consume(acct), [signer])];
  }
}
