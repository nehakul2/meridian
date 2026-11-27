/** In-memory Store for unit tests and dry runs. Same semantics as PgStore. */
import type { CalendarRow, CorporateActionRow } from "../calendar.js";
import { DEFAULT_POLICY, StrikePolicy } from "../strikes.js";
import { etDate, IsoDate } from "../time.js";
import type {
  AlertRow, FillRow, JobName, JobRunRow, JobStatus, OfficialCloseRow, OracleUpdateRow, Purpose,
  ReconcileReport, Store, StrikeInputsRow, TickerRow,
} from "./types.js";

export class MemoryStore implements Store {
  tickers: TickerRow[] = [];
  policies: StrikePolicy[] = [DEFAULT_POLICY];
  corpActions: CorporateActionRow[] = [];
  calendar = new Map<IsoDate, CalendarRow>();
  oracle = new Map<string, OracleUpdateRow>();
  closes = new Map<string, OfficialCloseRow>();
  inputs = new Map<string, StrikeInputsRow>();
  fillRows: (FillRow & { symbol: string })[] = [];
  signatures = new Map<IsoDate, Set<string>>();
  runs: JobRunRow[] = [];
  alertRows: (AlertRow & { acked: boolean })[] = [];
  reports: ReconcileReport[] = [];
  locks = new Set<string>();
  /** Time source for created_at / started_at (tests share the fake clock). */
  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  async enabledTickers() {
    return this.tickers.filter((t) => t.enabled);
  }
  async activePolicy() {
    return this.policies[this.policies.length - 1]!;
  }
  async policy(id: number) {
    const p = this.policies.find((x) => x.id === id);
    if (!p) throw new Error(`no strike_policy ${id}`);
    return p;
  }
  async corporateActions(date: IsoDate) {
    return this.corpActions.filter((c) => c.effectiveDate === date);
  }
  async upsertCalendar(rows: CalendarRow[]) {
    for (const r of rows) this.calendar.set(r.tradingDate, r);
    return rows.length;
  }
  async calendarRows() {
    return [...this.calendar.values()];
  }
  async getOracleUpdate(symbol: string, date: IsoDate, purpose: Purpose) {
    return this.oracle.get(`${symbol}|${date}|${purpose}`) ?? null;
  }
  async putOracleUpdate(row: OracleUpdateRow) {
    const k = `${row.symbol}|${row.tradingDate}|${row.purpose}`;
    if (!this.oracle.has(k)) this.oracle.set(k, { ...row, vaa: new Uint8Array(row.vaa) });
    return this.oracle.get(k)!;
  }
  async getOfficialClose(symbol: string, date: IsoDate) {
    return this.closes.get(`${symbol}|${date}`) ?? null;
  }
  async putOfficialClose(row: OfficialCloseRow) {
    if (row.massiveCents !== row.priceCents || row.databentoCents !== row.priceCents) {
      throw new Error("official close must match both vendors");
    }
    const k = `${row.symbol}|${row.tradingDate}`;
    if (!this.closes.has(k)) this.closes.set(k, row);
    return this.closes.get(k)!;
  }
  async officialClosesBefore(symbol: string, date: IsoDate, n: number) {
    return [...this.closes.values()]
      .filter((c) => c.symbol === symbol && c.tradingDate < date)
      .sort((a, b) => (a.tradingDate < b.tradingDate ? 1 : -1))
      .slice(0, n);
  }
  async getStrikeInputs(symbol: string, date: IsoDate) {
    return this.inputs.get(`${symbol}|${date}`) ?? null;
  }
  async putStrikeInputs(row: StrikeInputsRow) {
    const k = `${row.symbol}|${row.tradingDate}`;
    if (!this.inputs.has(k)) this.inputs.set(k, row);
    return this.inputs.get(k)!;
  }
  async contractsByDate(symbol: string, dates: IsoDate[]) {
    const out = new Map<IsoDate, bigint>();
    for (const d of dates) out.set(d, 0n);
    for (const f of this.fillRows) {
      const d = etDate(f.blockTime);
      if (f.symbol === symbol && out.has(d)) out.set(d, out.get(d)! + f.qty);
    }
    return out;
  }
  async hasAnyFills(symbol: string) {
    return this.fillRows.some((f) => f.symbol === symbol);
  }
  async startJobRun(job: JobName, date: IsoDate, symbol: string | null) {
    const attempt = this.runs.filter((r) => r.job === job && r.tradingDate === date && r.symbol === symbol).length + 1;
    const row: JobRunRow = {
      id: this.runs.length + 1, job, tradingDate: date, symbol, attempt, status: "RUNNING",
      detail: null, txSigs: [], startedAt: this.now(), finishedAt: null,
    };
    this.runs.push(row);
    return { ...row };
  }
  async finishJobRun(id: number, status: JobStatus, detail?: Record<string, unknown>, txSigs?: string[]) {
    const r = this.runs.find((x) => x.id === id);
    if (!r) throw new Error(`no job run ${id}`);
    r.status = status;
    r.detail = detail ?? null;
    r.txSigs = txSigs ?? [];
    r.finishedAt = this.now();
  }
  async jobRuns(date: IsoDate, job?: JobName) {
    return this.runs.filter((r) => r.tradingDate === date && (!job || r.job === job)).map((r) => ({ ...r }));
  }
  async raiseAlert(a: Omit<AlertRow, "id" | "createdAt">) {
    const open = this.alertRows.find(
      (x) => !x.acked && x.code === a.code && x.symbol === a.symbol && x.tradingDate === a.tradingDate && x.severity === a.severity,
    );
    if (open) return open;
    const row = { ...a, id: this.alertRows.length + 1, createdAt: this.now(), acked: false };
    this.alertRows.push(row);
    return row;
  }
  async alerts() {
    return this.alertRows.map(({ acked: _a, ...r }) => r);
  }
  async tryLock(key: string) {
    if (this.locks.has(key)) return null;
    this.locks.add(key);
    return async () => {
      this.locks.delete(key);
    };
  }
  async chainSignatures(date: IsoDate) {
    return new Set(this.signatures.get(date) ?? []);
  }
  async fills(date: IsoDate) {
    return this.fillRows.filter((f) => etDate(f.blockTime) === date);
  }
  async putReconcileReport(r: ReconcileReport) {
    this.reports.push(r);
  }
}
