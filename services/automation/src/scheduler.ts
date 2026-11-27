/**
 * MER-46: scheduler, single-runner lock and manual rerun (spec 3.1 C8, 7.6, 8).
 *
 * Fire times come from `trading_calendar` in UTC, so DST and half-days need no special
 * case (CAL-03, CAL-04, CAL-02); holidays have no row and fire nothing (CAL-01).
 *
 *   MORNING      08:00 ET
 *   SETTLE       close + 5 min
 *   FINALIZE     close + 25 min, then every minute until every ticker-day is FINAL
 *   STRIKE_CRANK } same cadence, each until its `done` flag is set; they read chain state,
 *   PRUNE        } so they act on CloseFinalized without depending on event delivery
 *   CLOSE_BOOK   }
 *   RECONCILE    20:00 ET
 *
 * Every run takes a Postgres advisory lock on (job, date), so two automation replicas
 * never run the same job at once (CON-07). Manual reruns (the admin route and ops agents)
 * go through `rerun`, which accepts only the idempotent jobs above.
 */
import type { Logger } from "./alerts.js";
import type { TradingCalendar } from "./calendar.js";
import type { JobName, Store } from "./store/types.js";
import { Clock, etDate, etToUnix, IsoDate } from "./time.js";

export const RERUNNABLE: readonly JobName[] = ["MORNING", "SETTLE", "FINALIZE", "STRIKE_CRANK", "PRUNE", "CLOSE_BOOK", "RECONCILE"];

/** Cranks that repeat until they report done. */
const REPEATING: readonly JobName[] = ["FINALIZE", "STRIKE_CRANK", "PRUNE", "CLOSE_BOOK"];

export interface PlannedJob {
  job: JobName;
  date: IsoDate;
  /** First fire time, UTC unix seconds. */
  at: number;
  /** Repeat interval while not done (cranks), seconds. */
  repeatS?: number;
  /** Stop repeating after this time. */
  until?: number;
}

export function planDay(calendar: TradingCalendar, date: IsoDate): PlannedJob[] {
  if (!calendar.isTradingDay(date)) return [];
  const close = calendar.closeTime(date);
  const night = etToUnix(date, 20, 0);
  const crank = (job: JobName, offset: number): PlannedJob => ({ job, date, at: close + offset, repeatS: 60, until: night });
  return [
    { job: "MORNING", date, at: etToUnix(date, 8, 0) },
    { job: "SETTLE", date, at: close + 300 },
    crank("FINALIZE", 1_500),
    crank("STRIKE_CRANK", 1_500),
    crank("PRUNE", 1_560),
    crank("CLOSE_BOOK", 1_620),
    { job: "RECONCILE", date, at: night },
  ];
}

export class NotRerunnable extends Error {
  constructor(job: string) {
    super(`${job} is not an idempotent job and cannot be rerun; it needs the multisig path`);
  }
}

export type JobRunner = (job: JobName, date: IsoDate) => Promise<{ done?: boolean } | unknown>;

export type RunOutcome = { status: "RAN"; done: boolean; result: unknown } | { status: "LOCKED" } | { status: "ERROR"; error: string };

export class Scheduler {
  /** (job|date) → done. In memory; a restart re-runs jobs, which is safe because all are idempotent. */
  private readonly finished = new Set<string>();
  private readonly lastFire = new Map<string, number>();
  private stopped = false;

  constructor(
    private readonly store: Store,
    private readonly calendar: TradingCalendar,
    private readonly clock: Clock,
    private readonly runner: JobRunner,
    private readonly log: Logger,
  ) {}

  /** Runs a job under the single-runner lock. */
  async runJob(job: JobName, date: IsoDate): Promise<RunOutcome> {
    const release = await this.store.tryLock(`automation:${job}:${date}`);
    if (!release) {
      this.log.info("job already running elsewhere", { job, date });
      return { status: "LOCKED" };
    }
    try {
      const result = await this.runner(job, date);
      const done = REPEATING.includes(job) ? Boolean((result as { done?: boolean } | undefined)?.done) : true;
      if (done) this.finished.add(`${job}|${date}`);
      return { status: "RAN", done, result };
    } catch (e) {
      this.log.error("job failed", { job, date, error: (e as Error).message });
      return { status: "ERROR", error: (e as Error).message };
    } finally {
      await release();
    }
  }

  /** Manual rerun of an idempotent job (`POST /v1/admin/jobs/{job}/run`, ops agents). */
  async rerun(job: string, date: IsoDate): Promise<RunOutcome> {
    if (!(RERUNNABLE as readonly string[]).includes(job)) throw new NotRerunnable(job);
    this.finished.delete(`${job}|${date}`);
    return this.runJob(job as JobName, date);
  }

  /** Jobs due at `now` for today's ET date (and yesterday's, for anything still repeating). */
  due(now: number): PlannedJob[] {
    const today = etDate(now);
    const out: PlannedJob[] = [];
    for (const p of planDay(this.calendar, today)) {
      const k = `${p.job}|${p.date}`;
      if (this.finished.has(k) || now < p.at) continue;
      if (p.until !== undefined && now > p.until) continue;
      const last = this.lastFire.get(k);
      if (last !== undefined) {
        if (!p.repeatS || now < last + p.repeatS) continue;
      }
      out.push(p);
    }
    return out;
  }

  private readonly running = new Set<string>();

  /**
   * One scheduling pass: starts every due job that is not already running in this
   * process (jobs run concurrently; SETTLE does not hold up a crank). Resolves when the
   * jobs started by this pass finish.
   */
  tick(): Promise<RunOutcome[]> {
    const now = this.clock.now();
    const started: Promise<RunOutcome>[] = [];
    for (const p of this.due(now)) {
      const k = `${p.job}|${p.date}`;
      if (this.running.has(k)) continue;
      this.lastFire.set(k, now);
      this.running.add(k);
      started.push(
        this.runJob(p.job, p.date).then((r) => {
          this.running.delete(k);
          if (r.status === "RAN" && !REPEATING.includes(p.job)) this.finished.add(k);
          return r;
        }),
      );
    }
    return Promise.all(started);
  }

  async loop(pollS = 15): Promise<void> {
    while (!this.stopped) {
      void this.tick();
      await this.clock.sleep(pollS);
    }
  }

  stop(): void {
    this.stopped = true;
  }
}
