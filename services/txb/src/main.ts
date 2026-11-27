/**
 * Tx Builder entrypoint. Env: REDIS_URL, RPC_URL (background blockhash and ALT refresh only,
 * never on a request path), USDC_MINT, BOND_VAULT, PORT.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { Redis } from "ioredis";
import { buildTxb } from "./app.js";
import { RpcAltCache, RpcBlockhashCache } from "./sources.js";

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const redis = new Redis(env("REDIS_URL"));
const conn = new Connection(env("RPC_URL"), "confirmed");
const blockhash = new RpcBlockhashCache(conn);
await blockhash.start();
const app = await buildTxb({
  redis, blockhash, alts: new RpcAltCache(conn, redis), logger: true,
  usdcMint: new PublicKey(env("USDC_MINT")), bondVault: new PublicKey(env("BOND_VAULT")),
});
await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 8081) });
const stop = async () => {
  blockhash.stop();
  await app.close();
  await redis.quit();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
