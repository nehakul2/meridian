/**
 * The local stack the load harness drives (MER-83): the real program on LiteSVM (the devnet
 * scripts' local validator stand-in), and in front of it the real Indexer, Redis read model, PG
 * Writer + Postgres, REST API, Tx Builder and WS gateway, each listening on a local port.
 *
 * Every transaction that lands on the stand-in is turned into the RPC `getTransaction` shape and
 * handed to the Indexer exactly as the live logs subscription would (or only recorded while the
 * Indexer is "down", for the outage scenario). Nothing is mocked between the chain and a client.
 */
import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import pg from "pg";
import type { TransactionMetadata } from "litesvm";
import { IDL_PATH, SO_PATH, SvmCluster } from "../../scripts/__tests__/helpers/svm-cluster.js";
import { deployDevnet, MAG7 } from "../../scripts/devnet/deploy.js";
import type { DevnetKeys } from "../../scripts/devnet/keys.js";
import { ixCreateAta, ixMintTo } from "../../scripts/devnet/spl.js";
import { MarketAccount, MeridianChain } from "../../services/automation/src/chain/client.js";
import { PROGRAM_ID } from "../../services/automation/src/chain/idl.js";
import { ata } from "../../services/automation/src/chain/pdas.js";
import { etToUnix } from "../../services/automation/src/time.js";
import { startTestDb, TestDb } from "../../services/automation/test/helpers/pg.js";
import { buildApi } from "../../services/api/src/app.js";
import { MemoryCursorStore } from "../../services/indexer/src/cursor.js";
import type { RawTx } from "../../services/indexer/src/decoder.js";
import { Indexer } from "../../services/indexer/src/indexer.js";
import { Projector } from "../../services/indexer/src/projector.js";
import type { ChainSource, SigInfo, SigStatus } from "../../services/indexer/src/source.js";
import { EventStream } from "../../services/indexer/src/stream.js";
import { startTestRedis, TestRedis } from "../../services/indexer/test/helpers/redis.js";
import { RedisBackfiller, StreamConsumer } from "../../services/pg-writer/src/consumer.js";
import { PgWriter } from "../../services/pg-writer/src/writer.js";
import { buildTxb } from "../../services/txb/src/app.js";
import { noAlts } from "../../services/txb/src/sources.js";
import { Gateway } from "../../services/ws/src/gateway.js";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const USDC = 1_000_000n;
const here = dirname(fileURLToPath(import.meta.url));
const quiet = { warn: () => undefined, info: () => undefined };

/** The Indexer's view of the chain: every landed transaction, in order (stands in for RPC). */
export class RecordedChain implements ChainSource {
  readonly txs: RawTx[] = [];
  private readonly listeners = new Set<(sig: string, slot: number, err: unknown) => void>();
  async getSignaturesForAddress(address: string, o: { before?: string; until?: string; limit?: number }): Promise<SigInfo[]> {
    let list = this.txs.filter((t) => t.accountKeys.includes(address)).reverse();
    if (o.before) list = list.slice(list.findIndex((t) => t.signature === o.before) + 1);
    if (o.until) {
      const i = list.findIndex((t) => t.signature === o.until);
      if (i >= 0) list = list.slice(0, i);
    }
    return list.slice(0, o.limit ?? 1000).map((t) => ({ signature: t.signature, slot: t.slot, err: null }));
  }
  async getTransaction(sig: string) {
    return this.txs.find((t) => t.signature === sig) ?? null;
  }
  async getSignatureStatuses(sigs: string[]): Promise<(SigStatus | null)[]> {
    return sigs.map((s) => {
      const t = this.txs.find((x) => x.signature === s);
      return t ? { slot: t.slot, err: null, confirmationStatus: "confirmed" as const } : null;
    });
  }
  async getSlot() {
    return this.txs.at(-1)?.slot ?? 0;
  }
  onLogs(cb: (sig: string, slot: number, err: unknown) => void) {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }
}

export interface StackOptions {
  date: string;
  withPg?: boolean;
}

export class Stack {
  cluster!: SvmCluster;
  keys!: DevnetKeys;
  usdc!: PublicKey;
  chain!: MeridianChain;
  redisSrv!: TestRedis;
  redis!: Redis;
  db: TestDb | null = null;
  pool: pg.Pool | null = null;
  source = new RecordedChain();
  projector!: Projector;
  indexer!: Indexer;
  consumer: StreamConsumer | null = null;
  apiByRoute: Record<string, number[]> = {};
  private pgLoop: Promise<void> = Promise.resolve();
  private stopping = false;
  api!: FastifyInstance;
  apiUrl = "";
  txb!: FastifyInstance;
  txbUrl = "";
  gw!: Gateway;
  wsUrl = "";
  /** Server-side durations (ms) of every API and Tx Builder request (Fastify's elapsedTime). */
  readonly apiTimes: number[] = [];
  readonly txbTimes: number[] = [];
  /** false = Indexer outage: landed transactions are only recorded. */
  live = true;
  private pipeline: Promise<unknown> = Promise.resolve();
  /** Signature (base58) -> time (performance.now) the stand-in confirmed it. */
  readonly confirmedAt = new Map<string, number>();
  readonly tickerDays: { address: string; ticker: string; date: number; openTime: number; closeTime: number; mintOpenTime: number }[] = [];

  static async start(o: StackOptions): Promise<Stack> {
    const s = new Stack();
    const deployer = Keypair.generate();
    s.cluster = new SvmCluster(etToUnix(o.date, 7, 0), deployer.publicKey);
    s.cluster.airdrop(deployer.publicKey, 10_000);
    s.keys = { deployer, admin: Keypair.generate(), creator: Keypair.generate(), settler: Keypair.generate(), payer: Keypair.generate() };
    const feeds = Object.fromEntries(MAG7.map((x, i) => [x, Buffer.alloc(32, i + 1).toString("hex")]));
    const rec = await deployDevnet({
      cluster: s.cluster, keys: s.keys, soPath: SO_PATH, idlPath: IDL_PATH, programKeypair: PROGRAM_ID, feeds, previous: null, commit: "load",
      settings: { disputeWindowS: 1_200, feeBps: 0 }, funding: { payer: 5_000, other: 10 },
    });
    s.usdc = new PublicKey(rec.usdcMint);
    s.chain = new MeridianChain(s.cluster, s.cluster, { payer: s.keys.payer, creator: s.keys.creator, settler: s.keys.settler });

    const r = await startTestRedis();
    if (!r) throw new Error("the load harness needs redis-server (or TEST_REDIS_URL)");
    s.redisSrv = r;
    await r.flush();
    s.redis = r.client();
    s.projector = new Projector(s.redis, { now: () => s.cluster.t * 1000 });
    await s.projector.applyConfig({ paused: false, feeBps: 0, overrideDelayS: 1800, settleWindowS: 5, maxQtyPerTrade: 500 });
    s.indexer = new Indexer({ redis: s.redis, source: s.source, cursor: new MemoryCursorStore(), projector: s.projector, stream: new EventStream(s.redis), log: quiet });
    s.cluster.onLanded = (tx, res) => s.landed(tx, res);

    if (o.withPg) {
      s.db = startTestDb();
      if (s.db) {
        s.pool = new pg.Pool({ connectionString: s.db.url, max: 8 });
        await s.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
        const dir = join(here, "../../db/migrations");
        for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) await s.pool.query(readFileSync(join(dir, f), "utf8"));
        for (const [i, t] of MAG7.entries()) await s.pool.query("INSERT INTO tickers (symbol, pyth_feed_id) VALUES ($1, $2)", [t, Buffer.alloc(32, i + 1)]);
        const writer = new PgWriter(s.pool, new RedisBackfiller(s.redis), { marketCreator: s.keys.creator.publicKey.toBase58(), log: quiet });
        s.consumer = new StreamConsumer(r.client(), writer, s.pool);
        s.consumer.trackLag = true;
        // The PG Writer runs alongside, as in production, so lag is measured live.
        const c = s.consumer;
        s.pgLoop = (async () => {
          while (!s.stopping) if ((await c.poll(20).catch(() => 0)) === 0) await new Promise((res) => setTimeout(res, 5));
        })();
      }
    }

    s.api = await buildApi({
      redis: s.redis, pgRead: null, pgWrite: null, now: () => s.cluster.t * 1000, jwtSecret: "load", adminSigners: new Set(), adminChain: null,
      rateLimit: { perSecond: 1_000_000, perMinute: 10_000_000 },
    });
    s.api.addHook("onResponse", async (q, reply) => {
      s.apiTimes.push(reply.elapsedTime);
      const route = q.routeOptions.url ?? q.url;
      (s.apiByRoute[route] ??= []).push(reply.elapsedTime);
    });
    s.apiUrl = await s.api.listen({ port: 0, host: "127.0.0.1" });
    s.txb = await buildTxb({
      redis: s.redis, blockhash: { get: () => ({ blockhash: s.cluster.svm.latestBlockhash(), lastValidBlockHeight: 1_000_000 }) }, alts: noAlts,
      usdcMint: s.usdc, bondVault: new PublicKey(rec.bondVault), now: () => s.cluster.t * 1000,
    });
    s.txb.addHook("onResponse", async (_q, reply) => void s.txbTimes.push(reply.elapsedTime));
    s.txbUrl = await s.txb.listen({ port: 0, host: "127.0.0.1" });
    s.gw = new Gateway({ redis: r.client(), sub: r.client(), jwtSecret: "load", maxSubscriptions: 1_000 });
    s.wsUrl = `ws://127.0.0.1:${await s.gw.listen(0, "127.0.0.1")}/v1/ws`;
    return s;
  }

  /** Stand-in confirmation -> RPC-shaped transaction -> Indexer (when live). */
  private landed(tx: Transaction, res: TransactionMetadata) {
    const sig = utils.bytes.bs58.encode(Buffer.from(res.signature()));
    this.confirmedAt.set(sig, performance.now());
    const raw: RawTx = {
      signature: sig, slot: Number(this.cluster.svm.getClock().slot), blockTime: this.cluster.t, err: null,
      accountKeys: tx.compileMessage().accountKeys.map((k) => k.toBase58()),
      innerInstructions: res.innerInstructions()
        .map((list, index) => ({
          index,
          instructions: list.map((ii) => ({ programIdIndex: ii.instruction().programIdIndex(), data: utils.bytes.bs58.encode(Buffer.from(ii.instruction().data())) })),
        }))
        .filter((g) => g.instructions.length > 0),
    };
    this.source.txs.push(raw);
    if (this.live) this.pipeline = this.pipeline.then(() => this.indexer.processTransaction(raw, "confirmed"));
  }

  /** Waits until the Indexer has processed everything that landed so far. */
  drain() {
    return this.pipeline;
  }

  /** Funds a wallet with SOL and test USDC, and tells the read model its balance (the md:bal feed). */
  async user(usdc: bigint): Promise<Keypair> {
    const kp = Keypair.generate();
    this.cluster.airdrop(kp.publicKey, 10);
    await this.cluster.send([ixCreateAta(this.keys.payer.publicKey, kp.publicKey, this.usdc), ixMintTo(this.usdc, ata(kp.publicKey, this.usdc), this.keys.payer.publicKey, usdc)], [this.keys.payer]);
    await this.projector.applyBalance(kp.publicKey.toBase58(), usdc);
    return kp;
  }

  /** The morning job's on-chain work for `tickers` x `strikes`, then the ticker-days into the read model. */
  async morning(date: string, key: number, tickers: string[], strikesFor: (t: string) => bigint[], close = etToUnix(date, 16, 0)): Promise<MarketAccount[]> {
    const out: MarketAccount[] = [];
    for (const t of tickers) {
      const mintOpen = etToUnix(date, 8, 30), open = etToUnix(date, 9, 30);
      await this.chain.createTickerDay(t, key, mintOpen, open, close);
      for (const s of strikesFor(t)) await this.chain.createStrikeMarket(t, key, s);
      const td = (await this.chain.tickerDay(t, key))!;
      const info = { address: td.address.toBase58(), ticker: t, date: key, openTime: open, closeTime: close, mintOpenTime: mintOpen };
      this.tickerDays.push(info);
      out.push(...(await this.chain.markets(td.address)));
    }
    await this.drain();
    for (const td of this.tickerDays.filter((x) => x.date === key)) await this.projector.applyTickerDay(td);
    return out;
  }

  send(ixs: TransactionInstruction[], signers: Keypair[], computeUnits?: number) {
    return this.cluster.send(ixs, signers, computeUnits ? { computeUnits } : {});
  }

  async stop() {
    this.stopping = true;
    await this.pgLoop;
    await this.pipeline.catch(() => undefined);
    await this.gw?.close().catch(() => undefined);
    await this.api?.close().catch(() => undefined);
    await this.txb?.close().catch(() => undefined);
    await this.pool?.end().catch(() => undefined);
    this.db?.stop();
    await this.redisSrv?.stop();
  }
}
