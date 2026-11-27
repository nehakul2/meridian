/**
 * MER-47: nightly reconcile (spec 5 "Reorgs / missed events", spec 8 RECONCILE).
 *
 * At 20:00 ET: replay the day's program signatures, diff them and their Fill events
 * against `chain_events` and `fills` (PG Writer's tables), check the spec 4.3 invariants
 * per market from chain state, store a diff report and alert when anything differs.
 * Missing signatures can be handed to an idempotent backfill (the PG Writer's, Phase 5).
 * Automation never writes the chain-derived tables itself.
 */
import { utils } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { coder, PROGRAM_ID } from "../chain/idl.js";
import type { FillRow } from "../store/types.js";
import { dateKey, etToUnix, addDays, IsoDate } from "../time.js";
import { Deps } from "./common.js";

export interface ChainSig {
  signature: string;
  slot: number;
  blockTime: number;
}

/** The day's program history from chain (RPC in production). */
export interface ChainHistory {
  signatures(date: IsoDate): Promise<ChainSig[]>;
  /** Fill events in one transaction, in emission order. */
  fills(sig: ChainSig): Promise<FillRow[]>;
}

/** Idempotent backfill of missing signatures (PG Writer, MER-52/53). Returns rows inserted. */
export interface Backfiller {
  backfill(signatures: string[]): Promise<number>;
}

export interface ReconcileResult {
  missingSignatures: string[];
  missingFills: string[];
  mismatchedFills: string[];
  invariantBreaks: string[];
  backfilled: number;
}

const tokenAmount = (d: Uint8Array) => Buffer.from(d).readBigUInt64LE(64);
const mintSupply = (d: Uint8Array) => Buffer.from(d).readBigUInt64LE(36);
const MICRO_PER_PAIR = 1_000_000n;

export async function runReconcile(
  deps: Deps,
  history: ChainHistory,
  date: IsoDate,
  o: { backfiller?: Backfiller } = {},
): Promise<ReconcileResult> {
  const run = await deps.store.startJobRun("RECONCILE", date, null);
  const sigs = await history.signatures(date);
  const known = await deps.store.chainSignatures(date);
  const missingSignatures = sigs.filter((s) => !known.has(s.signature)).map((s) => s.signature);

  const pgFills = new Map((await deps.store.fills(date)).map((f) => [`${f.signature}:${f.eventIndex}`, f]));
  const missingFills: string[] = [];
  const mismatchedFills: string[] = [];
  for (const s of sigs) {
    for (const f of await history.fills(s)) {
      const k = `${f.signature}:${f.eventIndex}`;
      const p = pgFills.get(k);
      if (!p) missingFills.push(k);
      else if (p.qty !== f.qty || p.priceCents !== f.priceCents || p.marketPda !== f.marketPda || p.seq !== f.seq) mismatchedFills.push(k);
    }
  }

  // Spec 4.3 invariants from chain state, per market of the day.
  const invariantBreaks: string[] = [];
  const cfg = await deps.chain.config();
  for (const t of cfg.tickers) {
    const td = await deps.chain.tickerDay(t.symbol, dateKey(date));
    if (!td) continue;
    for (const m of await deps.chain.markets(td.address)) {
      const [vault, yes, no] = await Promise.all([m.vault, m.yesMint, m.noMint].map((k) => deps.chain.reader.getAccount(k)));
      const id = `${t.symbol} ${m.strikeCents}`;
      if (!vault || !yes || !no) {
        invariantBreaks.push(`${id}: vault or mint account missing`);
        continue;
      }
      if (tokenAmount(vault.data) < m.collateralAccounted) invariantBreaks.push(`${id}: vault < collateral_accounted`);
      if (m.status === "Trading" || m.status === "Halted") {
        const ys = mintSupply(yes.data);
        const ns = mintSupply(no.data);
        if (ys !== ns || ys !== m.pairsOutstanding) invariantBreaks.push(`${id}: Yes ${ys} / No ${ns} / pairs ${m.pairsOutstanding} differ`);
        if (m.collateralAccounted !== m.pairsOutstanding * MICRO_PER_PAIR) invariantBreaks.push(`${id}: collateral_accounted != pairs x $1`);
      }
    }
  }

  let backfilled = 0;
  const toBackfill = [...new Set([...missingSignatures, ...missingFills.map((k) => k.split(":")[0]!), ...mismatchedFills.map((k) => k.split(":")[0]!)])];
  if (o.backfiller && toBackfill.length > 0) backfilled = await o.backfiller.backfill(toBackfill);

  const diffCount = missingSignatures.length + missingFills.length + mismatchedFills.length;
  await deps.store.putReconcileReport({
    tradingDate: date,
    missingCount: missingSignatures.length + missingFills.length,
    mismatchCount: mismatchedFills.length,
    invariantBreaks: invariantBreaks.length,
    diff: { missingSignatures, missingFills, mismatchedFills, invariantBreaks, backfilled },
  });
  if (invariantBreaks.length > 0) {
    await deps.alerter.raise("PAGE", "INVARIANT_BREAK", `Reconcile ${date}: ${invariantBreaks.join("; ")}`, null, date);
  }
  if (diffCount > 0) {
    await deps.alerter.raise("WARN", "RECONCILE_DIFF",
      `Reconcile ${date}: ${missingSignatures.length} missing signatures, ${missingFills.length} missing fills, ${mismatchedFills.length} mismatched fills; backfilled ${backfilled}`, null, date);
  }
  await deps.store.finishJobRun(run.id, diffCount + invariantBreaks.length === 0 ? "OK" : "FAILED", {
    missingSignatures: missingSignatures.length, missingFills: missingFills.length, mismatchedFills: mismatchedFills.length,
    invariantBreaks: invariantBreaks.length, backfilled,
  });
  return { missingSignatures, missingFills, mismatchedFills, invariantBreaks, backfilled };
}

/**
 * RPC history: getSignaturesForAddress(program) paged back to the ET day's start, and
 * Fill events decoded from `emit_cpi!` inner instructions (8-byte event-ix tag, then the
 * event's discriminator and Borsh body).
 */
export class RpcChainHistory implements ChainHistory {
  constructor(private readonly conn: Connection, private readonly program: PublicKey = PROGRAM_ID) {}

  async signatures(date: IsoDate): Promise<ChainSig[]> {
    const from = etToUnix(date, 0, 0);
    const to = etToUnix(addDays(date, 1), 0, 0);
    const out: ChainSig[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.conn.getSignaturesForAddress(this.program, { before, limit: 1000 }, "finalized");
      if (page.length === 0) break;
      for (const s of page) {
        if (s.err || s.blockTime == null) continue;
        if (s.blockTime >= from && s.blockTime < to) out.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime });
      }
      const last = page[page.length - 1]!;
      if ((last.blockTime ?? 0) < from) break;
      before = last.signature;
    }
    return out.reverse();
  }

  async fills(sig: ChainSig): Promise<FillRow[]> {
    const tx = await this.conn.getTransaction(sig.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    if (!tx?.meta?.innerInstructions) return [];
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    const out: FillRow[] = [];
    let eventIndex = 0;
    for (const group of tx.meta.innerInstructions) {
      for (const ix of group.instructions) {
        if (!keys.get(ix.programIdIndex)?.equals(this.program)) continue;
        const raw = Buffer.from(utils.bytes.bs58.decode(ix.data));
        if (raw.length < 16) continue;
        const ev = coder.events.decode(raw.subarray(8).toString("base64"));
        if (!ev) continue;
        const idx = eventIndex++;
        if (ev.name !== "Fill") continue;
        const d = ev.data as Record<string, any>;
        out.push({
          signature: sig.signature, eventIndex: idx, marketPda: (d.market as PublicKey).toBase58(),
          seq: BigInt(d.seq.toString()), qty: BigInt(d.qty.toString()), priceCents: Number(d.price), blockTime: sig.blockTime,
        });
      }
    }
    return out;
  }
}
