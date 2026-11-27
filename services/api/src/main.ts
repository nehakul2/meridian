/**
 * REST API entrypoint. Env: REDIS_URL, PG_READ_URL (replica), PG_URL (primary), JWT_SECRET,
 * ADMIN_SIGNERS (comma-separated wallets), ADMIN_AUTHORITY, USDC_MINT, FEE_VAULT, BOND_VAULT,
 * SIWS_DOMAIN, PORT. No RPC URL: the API never talks to the chain (spec 3.1 C4).
 */
import { PublicKey } from "@solana/web3.js";
import { Redis } from "ioredis";
import pg from "pg";
import { buildApi } from "./app.js";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`${k} is required`);
  return v;
};

const redis = new Redis(env("REDIS_URL"));
const pgWrite = process.env.PG_URL ? new pg.Pool({ connectionString: process.env.PG_URL, max: 5 }) : null;
const pgRead = process.env.PG_READ_URL ? new pg.Pool({ connectionString: process.env.PG_READ_URL, max: 20 }) : pgWrite;
const pk = (k: string) => (process.env[k] ? new PublicKey(process.env[k]!) : null);
const adminAuthority = pk("ADMIN_AUTHORITY");
const app = await buildApi({
  redis, pgRead, pgWrite, logger: true,
  jwtSecret: env("JWT_SECRET"),
  domain: process.env.SIWS_DOMAIN,
  adminSigners: new Set((process.env.ADMIN_SIGNERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  adminChain: adminAuthority ? { adminAuthority, usdcMint: pk("USDC_MINT")!, feeVault: pk("FEE_VAULT")!, bondVault: pk("BOND_VAULT")! } : null,
});
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8080) });
const stop = async () => {
  await app.close();
  await redis.quit();
  await pgWrite?.end();
  if (pgRead !== pgWrite) await pgRead?.end();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
