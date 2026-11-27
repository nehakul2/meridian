/** A WebSocket test client that records every message with its arrival time. */
import { WebSocket } from "ws";

export interface Msg {
  type: string;
  channel?: string;
  seq?: string;
  prev_seq?: string;
  [k: string]: unknown;
}

export class Client {
  readonly msgs: (Msg & { at: number })[] = [];
  readonly ws: WebSocket;
  closed = false;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => this.msgs.push({ ...(JSON.parse(raw.toString()) as Msg), at: performance.now() }));
    this.ws.on("close", () => (this.closed = true));
    this.ws.on("error", () => (this.closed = true));
  }
  open(): Promise<void> {
    return new Promise((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
  }
  send(o: object) {
    this.ws.send(JSON.stringify(o));
  }
  of(type: string, channel?: string) {
    return this.msgs.filter((m) => m.type === type && (channel === undefined || m.channel === channel));
  }
  async waitFor(pred: (m: Msg) => boolean, ms = 2000): Promise<Msg & { at: number }> {
    const t0 = Date.now();
    for (;;) {
      const m = this.msgs.find(pred);
      if (m) return m;
      if (Date.now() - t0 > ms) throw new Error(`timed out; got ${JSON.stringify(this.msgs.map((x) => x.type))}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
