// MER-46: scheduler fire times, single-runner lock and manual rerun.
import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/alerts.js";
import { NotRerunnable, planDay, RERUNNABLE, Scheduler } from "../src/scheduler.js";
import { MemoryStore } from "../src/store/memory.js";
import type { JobName } from "../src/store/types.js";
import { etToUnix } from "../src/time.js";
import { calendar2026, FakeClock } from "./helpers/fakes.js";

const utc = (iso: string) => Date.parse(iso) / 1000;
const at = (date: string, job: JobName) => planDay(calendar2026(), date).find((p) => p.job === job)!.at;

describe("scheduler", () => {
  it("CAL-03 DST start: morning 13:00 → 12:00 UTC, settle 21:05 → 20:05 UTC", () => {
    expect(at("2026-03-06", "MORNING")).toBe(utc("2026-03-06T13:00:00Z"));
    expect(at("2026-03-06", "SETTLE")).toBe(utc("2026-03-06T21:05:00Z"));
    expect(at("2026-03-09", "MORNING")).toBe(utc("2026-03-09T12:00:00Z"));
    expect(at("2026-03-09", "SETTLE")).toBe(utc("2026-03-09T20:05:00Z"));
  });

  it("CAL-04 DST end: Friday settle 20:05 UTC, Monday 21:05 UTC", () => {
    expect(at("2026-10-30", "SETTLE")).toBe(utc("2026-10-30T20:05:00Z"));
    expect(at("2026-11-02", "SETTLE")).toBe(utc("2026-11-02T21:05:00Z"));
  });

  it("half-day fires SETTLE at 13:05 ET and the cranks from 13:25; holidays fire nothing", () => {
    expect(at("2026-11-27", "SETTLE")).toBe(utc("2026-11-27T18:05:00Z"));
    expect(at("2026-11-27", "FINALIZE")).toBe(utc("2026-11-27T18:25:00Z"));
    expect(at("2026-11-27", "RECONCILE")).toBe(etToUnix("2026-11-27", 20, 0));
    expect(planDay(calendar2026(), "2026-11-26")).toEqual([]);
    expect(planDay(calendar2026(), "2026-11-28")).toEqual([]);
  });

  it("a day runs MORNING, SETTLE, the cranks until done, then RECONCILE, each once", async () => {
    const clock = new FakeClock(etToUnix("2026-11-25", 7, 59));
    const ran: string[] = [];
    let finalizeCalls = 0;
    const sched = new Scheduler(new MemoryStore(() => clock.now()), calendar2026(), clock, async (job) => {
      ran.push(job);
      if (job === "FINALIZE") return { done: ++finalizeCalls >= 3 };
      return { done: true };
    }, silentLogger);
    for (let t = clock.now(); t <= etToUnix("2026-11-25", 20, 1); t += 15) {
      clock.t = t;
      await sched.tick();
    }
    expect(ran.filter((j) => j === "MORNING")).toHaveLength(1);
    expect(ran.filter((j) => j === "SETTLE")).toHaveLength(1);
    expect(ran.filter((j) => j === "FINALIZE")).toHaveLength(3); // repeats every minute until done
    expect(ran.filter((j) => j === "STRIKE_CRANK")).toHaveLength(1);
    expect(ran.filter((j) => j === "RECONCILE")).toHaveLength(1);
    expect(ran[0]).toBe("MORNING");
    expect(ran.at(-1)).toBe("RECONCILE");
  });

  it("no fire on holidays", async () => {
    const clock = new FakeClock(etToUnix("2026-11-26", 7, 0));
    const ran: string[] = [];
    const sched = new Scheduler(new MemoryStore(), calendar2026(), clock, async (j) => { ran.push(j); return {}; }, silentLogger);
    for (let t = clock.now(); t <= etToUnix("2026-11-26", 21, 0); t += 300) {
      clock.t = t;
      await sched.tick();
    }
    expect(ran).toEqual([]);
  });

  it("CON-07 the lock prevents a double run across two replicas", async () => {
    const store = new MemoryStore();
    const clock = new FakeClock(etToUnix("2026-11-25", 16, 5));
    let release!: () => void;
    let runs = 0;
    const slow = async () => {
      runs++;
      await new Promise<void>((r) => (release = r));
      return {};
    };
    const a = new Scheduler(store, calendar2026(), clock, slow, silentLogger);
    const b = new Scheduler(store, calendar2026(), clock, slow, silentLogger);
    const first = a.runJob("SETTLE", "2026-11-25");
    await new Promise((r) => setImmediate(r));
    expect(await b.runJob("SETTLE", "2026-11-25")).toEqual({ status: "LOCKED" });
    release();
    expect((await first).status).toBe("RAN");
    expect(runs).toBe(1);
    // After release the lock is free again.
    const again = b.runJob("SETTLE", "2026-11-25");
    await new Promise((r) => setImmediate(r));
    release();
    expect((await again).status).toBe("RAN");
  });

  it("manual rerun of an idempotent job succeeds; a non-idempotent action is refused", async () => {
    const clock = new FakeClock(etToUnix("2026-11-25", 17, 0));
    const ran: string[] = [];
    const sched = new Scheduler(new MemoryStore(), calendar2026(), clock, async (j, d) => { ran.push(`${j} ${d}`); return { done: true }; }, silentLogger);
    expect((await sched.rerun("STRIKE_CRANK", "2026-11-24")).status).toBe("RAN");
    expect(ran).toEqual(["STRIKE_CRANK 2026-11-24"]);
    for (const bad of ["ADMIN_SETTLE", "RESOLVE_DISPUTE", "PAUSE", "ADD_STRIKE", "VOID_MARKET"]) {
      await expect(sched.rerun(bad, "2026-11-25")).rejects.toBeInstanceOf(NotRerunnable);
    }
    expect(RERUNNABLE).toEqual(["MORNING", "SETTLE", "FINALIZE", "STRIKE_CRANK", "PRUNE", "CLOSE_BOOK", "RECONCILE"]);
  });

  it("a job that throws is reported and does not stop the scheduler", async () => {
    const clock = new FakeClock(etToUnix("2026-11-25", 8, 0));
    const sched = new Scheduler(new MemoryStore(), calendar2026(), clock, async () => { throw new Error("boom"); }, silentLogger);
    const [r] = await sched.tick();
    expect(r).toEqual({ status: "ERROR", error: "boom" });
  });
});
