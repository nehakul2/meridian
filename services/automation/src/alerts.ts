/** Alerts (spec 5 `alerts`): stored once per open (code, symbol, date, severity), and logged. */
import type { Severity, Store } from "./store/types.js";
import type { IsoDate } from "./time.js";

export interface Logger {
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
}

function big(_k: string, v: unknown) {
  return typeof v === "bigint" ? v.toString() : v;
}

export const jsonLogger: Logger = {
  info: (msg, f) => console.log(JSON.stringify({ level: "info", msg, ...f }, big)),
  warn: (msg, f) => console.warn(JSON.stringify({ level: "warn", msg, ...f }, big)),
  error: (msg, f) => console.error(JSON.stringify({ level: "error", msg, ...f }, big)),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export class Alerter {
  constructor(private readonly store: Store, private readonly log: Logger) {}

  async raise(severity: Severity, code: string, message: string, symbol: string | null = null, date: IsoDate | null = null) {
    const row = await this.store.raiseAlert({ severity, code, message, symbol, tradingDate: date });
    const f = severity === "PAGE" ? this.log.error : severity === "WARN" ? this.log.warn : this.log.info;
    f(`alert ${code}`, { severity, symbol, date, message });
    return row;
  }
}
