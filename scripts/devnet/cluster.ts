/**
 * What the devnet scripts need from a cluster, behind one interface so the same lifecycle runs
 * on devnet (RPC + Hermes + the Pyth receiver) and on the LiteSVM stand-in the tests use.
 * Nothing here talks to a Meridian server: trades go wallet -> RPC -> program (spec 2.1, E2E-06).
 */
import { spawn } from "node:child_process";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { AccountReader, RpcReader, RpcSender, TxSender } from "../../services/automation/src/chain/client.js";
import { PriceUpdatePoster, PythReceiverPoster } from "../../services/automation/src/chain/pyth.js";
import { HermesApi, HermesClient, HermesUpdate } from "../../services/automation/src/oracle/hermes.js";
import { assertDevnet, ClusterKind } from "./guard.js";

/** Pyth prices: the latest (to pick strikes) and the first update at or after a time (to settle). */
export interface CloseOracle extends HermesApi {
  latest(feedIdHex: string): Promise<HermesUpdate | null>;
}

/** Program binary management: deploy (or upgrade) and dump the currently deployed binary. */
export interface ProgramDeployer {
  deploy(soPath: string): Promise<{ signature: string | null }>;
  /** Writes the deployed program's ELF to `outPath`; false if the program is not deployed yet. */
  dump(outPath: string): Promise<boolean>;
}

export interface Cluster {
  kind: ClusterKind | "litesvm";
  url: string;
  reader: AccountReader;
  sender: TxSender;
  poster: PriceUpdatePoster;
  oracle: CloseOracle;
  deployer: ProgramDeployer;
  /** Throws unless this is devnet or a local stand-in (DLC-04). */
  assertSafe(): Promise<void>;
  /** The chain's clock (unix seconds), which is what the program checks. */
  now(): Promise<number>;
  /** Returns once the chain clock is at or past `t`. */
  waitUntil(t: number, log?: (m: string) => void): Promise<void>;
  rentExempt(bytes: number): Promise<number>;
  lamports(k: PublicKey): Promise<number>;
}

// ---- devnet / local validator over RPC ----

export class HermesOracle extends HermesClient implements CloseOracle {
  private readonly baseUrl: string;
  constructor(opts: { baseUrl: string }) {
    super({ baseUrl: opts.baseUrl, timeoutMs: 10_000 });
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
  }

  async latest(feedIdHex: string): Promise<HermesUpdate | null> {
    const feed = feedIdHex.replace(/^0x/, "");
    const r = await fetch(`${this.baseUrl}/v2/updates/price/latest?ids[]=${feed}&encoding=base64&parsed=true`);
    if (!r.ok) return null;
    const body = (await r.json()) as { parsed?: { price: { price: string; conf: string; expo: number; publish_time: number } }[]; binary?: { data: string[] } };
    const p = body.parsed?.[0];
    if (!p || !body.binary?.data[0]) return null;
    return {
      publishTime: Number(p.price.publish_time), priceRaw: BigInt(p.price.price), expo: Number(p.price.expo), conf: BigInt(p.price.conf),
      vaa: new Uint8Array(Buffer.from(body.binary.data[0], "base64")),
    };
  }

  /** Pyth feed ids for US equities, from Hermes's catalogue (`Equity.US.<SYM>/USD`). */
  async equityFeedIds(symbols: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const s of symbols) {
      const r = await fetch(`${this.baseUrl}/v2/price_feeds?query=${encodeURIComponent(s)}&asset_type=equity`);
      if (!r.ok) throw new Error(`Hermes price_feeds ${s}: HTTP ${r.status}`);
      const feeds = (await r.json()) as { id: string; attributes: { symbol?: string } }[];
      const f = feeds.find((x) => x.attributes.symbol === `Equity.US.${s}/USD`);
      if (!f) throw new Error(`no Pyth feed Equity.US.${s}/USD in Hermes`);
      out[s] = f.id.replace(/^0x/, "");
    }
    return out;
  }
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** `solana program deploy` / `solana program dump` with the deployer as fee payer and upgrade authority. */
export class SolanaCliDeployer implements ProgramDeployer {
  constructor(private readonly o: { url: string; deployerKeypair: string; programKeypair: string; programId: PublicKey; solana?: string }) {}

  async deploy(soPath: string) {
    const r = await run(this.o.solana ?? "solana", [
      "program", "deploy", soPath, "--url", this.o.url, "--keypair", this.o.deployerKeypair,
      "--program-id", this.o.programKeypair, "--upgrade-authority", this.o.deployerKeypair, "--output", "json",
    ]);
    if (r.code !== 0) throw new Error(`solana program deploy failed:\n${r.out}`);
    const m = /"signature"\s*:\s*"(\w+)"/.exec(r.out);
    return { signature: m?.[1] ?? null };
  }

  async dump(outPath: string) {
    const r = await run(this.o.solana ?? "solana", ["program", "dump", this.o.programId.toBase58(), outPath, "--url", this.o.url]);
    if (r.code === 0) return true;
    if (/not found|does not exist|AccountNotFound|not an upgradeable program/i.test(r.out)) return false;
    throw new Error(`solana program dump failed:\n${r.out}`);
  }
}

export class RpcCluster implements Cluster {
  readonly conn: Connection;
  readonly reader: AccountReader;
  readonly sender: TxSender;
  readonly poster: PriceUpdatePoster;
  kind: ClusterKind = "devnet";

  constructor(readonly url: string, readonly oracle: CloseOracle, readonly deployer: ProgramDeployer) {
    this.conn = new Connection(url, "confirmed");
    this.reader = new RpcReader(this.conn);
    this.sender = new RpcSender(this.conn);
    this.poster = new PythReceiverPoster(this.conn);
  }

  async assertSafe() {
    this.kind = await assertDevnet(this.url, () => this.conn.getGenesisHash());
  }

  async now() {
    const slot = await this.conn.getSlot("confirmed");
    const t = await this.conn.getBlockTime(slot);
    return t ?? Math.floor(Date.now() / 1000);
  }

  async waitUntil(t: number, log?: (m: string) => void) {
    for (;;) {
      const now = await this.now();
      if (now >= t) return;
      const wait = Math.min(15, t - now);
      log?.(`waiting ${t - now}s for the chain clock to reach ${new Date(t * 1000).toISOString()}`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }

  rentExempt(bytes: number) {
    return this.conn.getMinimumBalanceForRentExemption(bytes);
  }

  lamports(k: PublicKey) {
    return this.conn.getBalance(k, "confirmed");
  }
}

/** SOL transfer from the fee payer (devnet faucets are rate limited, so users are funded by transfer). */
export function ixFund(from: Keypair, to: PublicKey, lamports: number) {
  return SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports });
}
