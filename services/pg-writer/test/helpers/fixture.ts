/** The Indexer's decoded day (services/indexer/test/fixtures/day.events.json) as stream input. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChainEvent, groupByInstruction } from "../../../shared/src/events.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../../../indexer/test/fixtures");
export const events: ChainEvent[] = JSON.parse(readFileSync(join(dir, "day.events.json"), "utf8"));
export const day = JSON.parse(readFileSync(join(dir, "day.json"), "utf8")) as {
  markets: { m680: string; m720: string; tickerDay: string };
  users: Record<"alice" | "bob" | "carol" | "dave" | "erin" | "frank" | "disputer", string>;
  txs: { signature: string; label: string }[];
};
export const groups = (): ChainEvent[][] => groupByInstruction(events);
export const sigOf = (label: string) => day.txs.find((t) => t.label === label)!.signature;
export const groupsOf = (label: string) => groups().filter((g) => g[0]!.sig === sigOf(label));

/** Instructions of every transaction up to and including `label`. */
export function groupsThrough(label: string): ChainEvent[][] {
  const i = day.txs.findIndex((t) => t.label === label);
  const sigs = new Set(day.txs.slice(0, i + 1).map((t) => t.signature));
  return groups().filter((g) => sigs.has(g[0]!.sig));
}
