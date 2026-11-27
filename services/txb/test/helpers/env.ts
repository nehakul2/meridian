/** A Tx Builder wired to LiteSVM (blockhash) and a test Redis, plus decode helpers. */
import { ComputeBudgetProgram, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { K } from "../../../shared/src/keys.js";
import { buildTxb } from "../../src/app.js";
import { PROGRAM_ID } from "../../src/chain/idl.js";
import { decodeIx } from "../../src/chain/ixs.js";
import { noAlts } from "../../src/sources.js";
import { Market, Svm, T } from "./svm.js";

export interface Env {
  svm: Svm;
  app: FastifyInstance;
  redis: Redis;
  m: Market;
  mid: string;
  clock: { t: number };
}

export async function makeEnv(redis: Redis): Promise<Env> {
  const svm = new Svm();
  const m = svm.createMarket("META", 68000n);
  const clock = { t: T.open + 3600 };
  await redis.hset(K.cfg, { paused: "0", fee_bps: "0", override_delay_s: "1800", settle_window_s: "5", max_qty_per_trade: "500" });
  const app = await buildTxb({
    redis, blockhash: { get: () => svm.blockhash() }, alts: noAlts, usdcMint: svm.usdcMint, bondVault: svm.bondVault, now: () => clock.t * 1000,
  });
  return { svm, app, redis, m, mid: m.address.toBase58(), clock };
}

export async function post(app: FastifyInstance, url: string, body: unknown) {
  const res = await app.inject({ method: "POST", url, payload: body as object });
  return { status: res.statusCode, body: res.json() };
}

export interface Decoded {
  tx: VersionedTransaction;
  /** Program instructions (compute budget left out), decoded by the IDL coder. */
  ixs: { name: string; data: Record<string, unknown>; accounts: PublicKey[] }[];
}

export function decodeTx(b64: string): Decoded {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const keys = tx.message.staticAccountKeys;
  const ixs = tx.message.compiledInstructions
    .filter((ix) => keys[ix.programIdIndex]!.equals(PROGRAM_ID))
    .map((ix) => ({ ...decodeIx(Buffer.from(ix.data))!, accounts: ix.accountKeyIndexes.map((i) => keys[i]!) }));
  return { tx, ixs };
}

export const isCompute = (tx: VersionedTransaction, i: number) =>
  tx.message.staticAccountKeys[tx.message.compiledInstructions[i]!.programIdIndex]!.equals(ComputeBudgetProgram.programId);

export const str = (v: unknown) => String(v);

export function trade(owner: Keypair, mid: string, intent: string, orderType: string, qty: number, priceCents?: number) {
  return { owner: owner.publicKey.toBase58(), marketId: mid, intent, orderType, qty, ...(priceCents !== undefined ? { priceCents } : {}) };
}
