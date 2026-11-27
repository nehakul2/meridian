/**
 * The recorded META day (services/indexer/test/fixtures, recorded from the real program on
 * LiteSVM) replayed through the real Indexer projector into a test Redis, so the API is
 * tested against the read model the Indexer actually writes. The projector has no runtime
 * dependency outside services/shared, so it is imported from its source.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";
import { ChainEvent, groupByInstruction } from "../../../shared/src/events.js";
import { Projector } from "../../../indexer/src/projector.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../indexer/test/fixtures");
const events: ChainEvent[] = JSON.parse(readFileSync(join(dir, "day.events.json"), "utf8"));
export const day = JSON.parse(readFileSync(join(dir, "day.json"), "utf8")) as {
  markets: { m680: string; m720: string; tickerDay: string };
  users: Record<"alice" | "bob" | "carol" | "dave" | "erin" | "frank" | "disputer", string>;
  txs: { signature: string; label: string; blockTime: number }[];
};

export const DATE = 20261125;
/** 2026-11-25 in UTC: mint opens 08:30 ET, book 09:30 ET, close 16:00 ET (D26). */
export const T = {
  mintOpen: 1795613400,
  open: 1795617000,
  close: 1795640400,
};
export const M680 = day.markets.m680;
export const M720 = day.markets.m720;
export const U = day.users;

/** Replays every instruction up to and including the last transaction labelled `label` (or all). */
export async function replay(redis: Redis, label?: string, o: { closeTime?: number } = {}): Promise<void> {
  const p = new Projector(redis, { now: () => T.open * 1000 });
  await p.applyConfig({ paused: false, feeBps: 100, overrideDelayS: 1800, settleWindowS: 5 });
  let sigs: Set<string> | null = null;
  if (label) {
    const i = day.txs.map((t) => t.label).lastIndexOf(label);
    if (i < 0) throw new Error(`no fixture tx ${label}`);
    sigs = new Set(day.txs.slice(0, i + 1).map((t) => t.signature));
  }
  const td = { address: day.markets.tickerDay, ticker: "META", date: DATE, openTime: T.open, closeTime: o.closeTime ?? T.close, mintOpenTime: T.mintOpen };
  await p.applyTickerDay(td);
  for (const g of groupByInstruction(events)) {
    if (sigs && !sigs.has(g[0]!.sig)) continue;
    await p.applyInstruction(g);
  }
  await p.applyTickerDay(td); // markets created during the replay pick up the times
}
