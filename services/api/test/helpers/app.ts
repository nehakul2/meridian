/** Builds the API against the test Redis / Postgres with a controllable clock and wallets. */
import { Keypair, PublicKey } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { signJwt } from "../../../shared/src/auth.js";
import { b58encode } from "../../../shared/src/base58.js";
import { ApiDeps, buildApi, Db } from "../../src/app.js";

export const SECRET = "test-secret";

export interface Clock {
  t: number;
}

export interface Wallet {
  pubkey: string;
  signMessage(msg: string): string;
}

/** An ed25519 wallet that signs like a wallet adapter (base58 signature over the UTF-8 bytes). */
export function wallet(): Wallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return {
    pubkey: b58encode(raw),
    signMessage: (msg) => b58encode(sign(null, Buffer.from(msg, "utf8"), createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" })))),
  };
}

export const adminVault = Keypair.generate().publicKey;
export const adminChain = {
  adminAuthority: adminVault,
  usdcMint: Keypair.generate().publicKey,
  feeVault: Keypair.generate().publicKey,
  bondVault: Keypair.generate().publicKey,
};

export async function makeApp(redis: Redis, pg: Db | null, clock: Clock, extra: Partial<ApiDeps> = {}): Promise<FastifyInstance> {
  return buildApi({
    redis, pgRead: pg, pgWrite: pg, now: () => clock.t * 1000, jwtSecret: SECRET, adminSigners: new Set(), adminChain,
    rateLimit: { perSecond: 10_000, perMinute: 100_000 }, ...extra,
  });
}

export function token(sub: string, clock: Clock, o: { adm?: boolean; ttl?: number } = {}): string {
  return signJwt({ sub, iat: clock.t, exp: clock.t + (o.ttl ?? 900), ...(o.adm ? { adm: true } : {}) }, SECRET);
}

export const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** Every money-like field is a string of integer micro-USDC; every *Cents / bid / ask / last an integer (API-13). */
export function checkUnits(v: unknown, path = "$"): string[] {
  const bad: string[] = [];
  const money = /^(maxCost|payoutIfWin|unrealizedPnl|realizedPnl|redeemable|freeUsdc|ledgerUsdc|fee|bond|usdc|minProceeds)$/;
  const cents = /(Cents$|^bid$|^ask$|^last$)/;
  const walk = (x: unknown, p: string, key: string) => {
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, `${p}[${i}]`, key));
    if (x && typeof x === "object") return Object.entries(x).forEach(([k, y]) => walk(y, `${p}.${k}`, k));
    if (money.test(key) && x !== null && !(typeof x === "string" && /^-?\d+$/.test(x))) bad.push(`${p}=${JSON.stringify(x)}`);
    if (cents.test(key) && key !== "avgEntryCents" && key !== "markCents" && x !== null && !Number.isInteger(x)) bad.push(`${p}=${JSON.stringify(x)}`);
  };
  walk(v, path, "");
  return bad;
}

export { PublicKey };
