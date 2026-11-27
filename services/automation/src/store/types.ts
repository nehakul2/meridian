/**
 * Persistence used by Automation. Automation writes only `oracle_updates`,
 * `official_closes`, `strike_inputs`, `job_runs`, `alerts`, `reconcile_reports` and the
 * calendar loader's `trading_calendar` (spec 5 write ownership). Everything else is read.
 */
import type { CalendarRow, CorporateActionRow } from "../calendar.js";
import type { StrikePolicy, Tier, VolBasis } from "../strikes.js";
import type { IsoDate } from "../time.js";

export type JobName = "MORNING" | "SETTLE" | "FINALIZE" | "STRIKE_CRANK" | "PRUNE" | "CLOSE_BOOK" | "RECONCILE";
export type JobStatus = "RUNNING" | "OK" | "RETRY" | "FAILED" | "SKIPPED";
export type Severity = "INFO" | "WARN" | "PAGE";
export type Purpose = "PREV_CLOSE" | "SETTLE";

export interface TickerRow {
  symbol: string;
  /** 32-byte Pyth feed id, hex without 0x. */
  pythFeedId: string;
  liquidityTierOverride: Tier | null;
  enabled: boolean;
}

export interface OracleUpdateRow {
  symbol: string;
  tradingDate: IsoDate;
  purpose: Purpose;
  /** Unix seconds. */
  targetTime: number;
  publishTime: number;
  priceRaw: bigint;
  expo: number;
  conf: bigint;
  /** The signed Hermes payload (accumulator update), byte for byte. */
  vaa: Uint8Array;
  fetchedAt: number;
}

export interface OfficialCloseRow {
  symbol: string;
  tradingDate: IsoDate;
  priceCents: bigint;
  massiveCents: bigint;
  massiveAt: number;
  databentoCents: bigint;
  databentoAt: number;
}

export interface StrikeInputsRow {
  symbol: string;
  tradingDate: IsoDate;
  prevCloseCents: bigint;
  ivBps: bigint | null;
  ivSource: string | null;
  rv20Bps: bigint;
  volUsedBps: bigint;
  volBasis: VolBasis;
  liquidityContracts5d: bigint;
  liquidityTier: Tier;
  move1dCents: bigint;
  stepCents: bigint;
  perSide: bigint;
  strikesCents: bigint[];
  policyId: number;
  computedAt: number;
}

export interface JobRunRow {
  id: number;
  job: JobName;
  tradingDate: IsoDate;
  symbol: string | null;
  attempt: number;
  status: JobStatus;
  detail: Record<string, unknown> | null;
  txSigs: string[];
  startedAt: number;
  finishedAt: number | null;
}

export interface AlertRow {
  id: number;
  severity: Severity;
  code: string;
  symbol: string | null;
  tradingDate: IsoDate | null;
  message: string;
  createdAt: number;
}

export interface FillRow {
  signature: string;
  eventIndex: number;
  marketPda: string;
  seq: bigint;
  qty: bigint;
  priceCents: number;
  blockTime: number;
}

export interface ReconcileReport {
  tradingDate: IsoDate;
  missingCount: number;
  mismatchCount: number;
  invariantBreaks: number;
  diff: Record<string, unknown>;
}

export interface Store {
  // reference
  enabledTickers(): Promise<TickerRow[]>;
  activePolicy(): Promise<StrikePolicy>;
  policy(id: number): Promise<StrikePolicy>;
  corporateActions(date: IsoDate): Promise<CorporateActionRow[]>;

  // calendar
  upsertCalendar(rows: CalendarRow[]): Promise<number>;
  calendarRows(): Promise<CalendarRow[]>;

  // oracle and official close (first write wins: D2, spec 4.7 rule 2)
  getOracleUpdate(symbol: string, date: IsoDate, purpose: Purpose): Promise<OracleUpdateRow | null>;
  /** Inserts unless a row exists; always returns the stored row. */
  putOracleUpdate(row: OracleUpdateRow): Promise<OracleUpdateRow>;
  getOfficialClose(symbol: string, date: IsoDate): Promise<OfficialCloseRow | null>;
  putOfficialClose(row: OfficialCloseRow): Promise<OfficialCloseRow>;
  /** Up to `n` official closes strictly before `date`, newest first. */
  officialClosesBefore(symbol: string, date: IsoDate, n: number): Promise<OfficialCloseRow[]>;

  // strike inputs (frozen once per ticker-day)
  getStrikeInputs(symbol: string, date: IsoDate): Promise<StrikeInputsRow | null>;
  putStrikeInputs(row: StrikeInputsRow): Promise<StrikeInputsRow>;

  // liquidity: contracts traded per ET trading date, for the dates given
  contractsByDate(symbol: string, dates: IsoDate[]): Promise<Map<IsoDate, bigint>>;
  hasAnyFills(symbol: string): Promise<boolean>;

  // jobs and alerts
  startJobRun(job: JobName, date: IsoDate, symbol: string | null): Promise<JobRunRow>;
  finishJobRun(id: number, status: JobStatus, detail?: Record<string, unknown>, txSigs?: string[]): Promise<void>;
  jobRuns(date: IsoDate, job?: JobName): Promise<JobRunRow[]>;
  /** Raises an alert unless an unacked one with the same (code, symbol, date) exists. */
  raiseAlert(a: Omit<AlertRow, "id" | "createdAt">): Promise<AlertRow>;
  alerts(): Promise<AlertRow[]>;

  // single-runner lock (CON-07, MER-46): null if another runner holds it
  tryLock(key: string): Promise<(() => Promise<void>) | null>;

  // reconcile (reads PG Writer tables)
  chainSignatures(date: IsoDate): Promise<Set<string>>;
  fills(date: IsoDate): Promise<FillRow[]>;
  putReconcileReport(r: ReconcileReport): Promise<void>;
}
