/** WS Gateway entrypoint. Env: REDIS_URL, JWT_SECRET, PORT. Reads Redis only (spec 3.1 C5). */
import { Redis } from "ioredis";
import { Gateway } from "./gateway.js";

const url = process.env.REDIS_URL;
const secret = process.env.JWT_SECRET;
if (!url || !secret) throw new Error("REDIS_URL and JWT_SECRET are required");
const redis = new Redis(url);
const sub = new Redis(url);
const log = {
  info: (msg: string, o?: object) => console.log(JSON.stringify({ level: "info", msg, ...o })),
  warn: (msg: string, o?: object) => console.log(JSON.stringify({ level: "warn", msg, ...o })),
};
const gw = new Gateway({ redis, sub, jwtSecret: secret, log });
const port = await gw.listen(Number(process.env.PORT ?? 8082));
log.info("ws gateway listening", { port });
const stop = async () => {
  await gw.close();
  await Promise.all([redis.quit(), sub.quit()]);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
