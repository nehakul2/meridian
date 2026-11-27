/** The chain reads the Indexer makes (spec 3.1 C6: account subscribe, logs, backfill). */
import { Commitment, Connection, PublicKey } from "@solana/web3.js";
import { fromRpc, RawTx } from "./decoder.js";
import { coder, PROGRAM_ID } from "./idl.js";

export interface SigInfo {
  signature: string;
  slot: number;
  err: unknown;
}

export interface SigStatus {
  slot: number;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
  err: unknown;
}

export interface TickerDayInfo {
  address: string;
  ticker: string;
  date: number;
  openTime: number;
  closeTime: number;
  mintOpenTime: number;
}

export interface ChainSource {
  /** Newest first, like the RPC method. */
  getSignaturesForAddress(address: string, o: { before?: string; until?: string; limit?: number }): Promise<SigInfo[]>;
  getTransaction(signature: string): Promise<RawTx | null>;
  getSignatureStatuses(signatures: string[]): Promise<(SigStatus | null)[]>;
  getSlot(commitment: "confirmed" | "finalized"): Promise<number>;
  /** Program log notifications at `confirmed`; returns an unsubscribe function. */
  onLogs(cb: (signature: string, slot: number, err: unknown) => void): () => void;
  /** TickerDay account changes at `confirmed`. */
  onTickerDay?(cb: (td: TickerDayInfo) => void): () => void;
  /** Config account changes at `confirmed`. */
  onConfig?(cb: (c: ConfigInfo) => void): () => void;
}

export interface ConfigInfo {
  paused: boolean;
  feeBps: number;
  overrideDelayS: number;
  settleWindowS: number;
}

export class RpcSource implements ChainSource {
  constructor(private readonly conn: Connection, private readonly commitment: Commitment = "confirmed") {}

  async getSignaturesForAddress(address: string, o: { before?: string; until?: string; limit?: number }): Promise<SigInfo[]> {
    const r = await this.conn.getSignaturesForAddress(new PublicKey(address), o, "confirmed");
    return r.map((s) => ({ signature: s.signature, slot: s.slot, err: s.err }));
  }

  async getTransaction(signature: string): Promise<RawTx | null> {
    const r = await this.conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return r ? fromRpc(signature, r as never) : null;
  }

  async getSignatureStatuses(signatures: string[]): Promise<(SigStatus | null)[]> {
    const out: (SigStatus | null)[] = [];
    for (let i = 0; i < signatures.length; i += 256) {
      const r = await this.conn.getSignatureStatuses(signatures.slice(i, i + 256), { searchTransactionHistory: true });
      out.push(...r.value.map((v) => (v ? { slot: v.slot, confirmationStatus: v.confirmationStatus, err: v.err } : null)));
    }
    return out;
  }

  getSlot(commitment: "confirmed" | "finalized"): Promise<number> {
    return this.conn.getSlot(commitment);
  }

  onLogs(cb: (signature: string, slot: number, err: unknown) => void): () => void {
    const id = this.conn.onLogs(PROGRAM_ID, (l, ctx) => cb(l.signature, ctx.slot, l.err), this.commitment);
    return () => void this.conn.removeOnLogsListener(id);
  }

  onConfig(cb: (c: ConfigInfo) => void): () => void {
    const config = PublicKey.findProgramAddressSync([Buffer.from("config")], PROGRAM_ID)[0];
    const id = this.conn.onAccountChange(config, (a) => {
      try {
        const d = coder.accounts.decode("Config", a.data) as Record<string, unknown>;
        const n = (k: string) => Number((d[k] as { toString(): string }).toString());
        cb({ paused: Boolean(d.paused), feeBps: n("fee_bps"), overrideDelayS: n("override_delay_s"), settleWindowS: n("settle_window_s") });
      } catch {
        /* not decodable: ignore */
      }
    }, { commitment: this.commitment });
    return () => void this.conn.removeAccountChangeListener(id);
  }

  onTickerDay(cb: (td: TickerDayInfo) => void): () => void {
    const disc = Buffer.from((coder as unknown as { accounts: { accountDiscriminator(n: string): Buffer } }).accounts.accountDiscriminator("TickerDay"));
    const id = this.conn.onProgramAccountChange(PROGRAM_ID, (a) => {
      try {
        const d = coder.accounts.decode("TickerDay", a.accountInfo.data) as Record<string, unknown>;
        const n = (k: string) => Number((d[k] as { toString(): string }).toString());
        cb({
          address: a.accountId.toBase58(),
          ticker: Buffer.from(d.ticker as number[]).toString("utf8").replace(/\0+$/, ""),
          date: n("date"), openTime: n("open_time"), closeTime: n("close_time"), mintOpenTime: n("mint_open_time"),
        });
      } catch {
        /* not decodable: ignore */
      }
    }, { commitment: this.commitment, filters: [{ memcmp: { offset: 0, bytes: disc.toString("base64"), encoding: "base64" } }] });
    return () => void this.conn.removeProgramAccountChangeListener(id);
  }
}
