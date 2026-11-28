/** Latency stats and the pass/fail budget report the nightly run posts (MER-83). */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

export interface BudgetRow {
  case: string;
  metric: string;
  value: number;
  budget: number;
  unit: string;
  /** "lt": value must be below budget; "eq": equal; "gte": at least. */
  op: "lt" | "eq" | "gte";
  pass: boolean;
  note?: string;
}

export class Report {
  readonly rows: BudgetRow[] = [];
  readonly facts: Record<string, unknown> = {};

  budget(c: string, metric: string, value: number, budget: number, unit: string, op: BudgetRow["op"] = "lt", note?: string): boolean {
    const pass = op === "lt" ? value < budget : op === "eq" ? value === budget : value >= budget;
    this.rows.push({ case: c, metric, value: Math.round(value * 100) / 100, budget, unit, op, pass, note });
    return pass;
  }

  markdown(): string {
    const sym = { lt: "<", eq: "=", gte: ">=" };
    return [
      "| Case | Metric | Value | Budget | Result |",
      "|---|---|---|---|---|",
      ...this.rows.map((r) => `| ${r.case} | ${r.metric}${r.note ? ` (${r.note})` : ""} | ${r.value} ${r.unit} | ${sym[r.op]} ${r.budget} ${r.unit} | ${r.pass ? "pass" : "**FAIL**"} |`),
    ].join("\n");
  }

  write(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ generatedAt: new Date().toISOString(), rows: this.rows, facts: this.facts }, null, 2));
    writeFileSync(path.replace(/\.json$/, ".md"), `# Meridian load report\n\n${this.markdown()}\n\n\`\`\`json\n${JSON.stringify(this.facts, null, 2)}\n\`\`\`\n`);
  }
}

/** Runs `fn` with `concurrency` workers until `total` calls are done; returns each call's latency (ms). */
export async function drive(total: number, concurrency: number, fn: (i: number) => Promise<void>): Promise<number[]> {
  const times: number[] = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= total) return;
      const t0 = performance.now();
      await fn(i);
      times.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return times;
}

export interface Req {
  url: string;
  method?: "GET" | "POST";
  body?: string;
}

/**
 * Open-loop load at a fixed rate from a worker thread, so the load generator does not share
 * the server's event loop. Sends `reqs` in order at `rps` (the matrix states rates, not
 * concurrency) and returns client latencies and the count of non-200 answers.
 */
export async function openLoop(reqs: Req[], rps: number): Promise<{ latencies: number[]; errors: number; firstError: string | null; seconds: number }> {
  const { Worker } = await import("node:worker_threads");
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    const { reqs, rps } = workerData;
    const lat = []; let errors = 0, done = 0, firstError = null;
    const t0 = performance.now();
    const fire = async (r) => {
      const s = performance.now();
      try {
        const res = await fetch(r.url, { method: r.method ?? "GET", body: r.body, headers: r.body ? { "content-type": "application/json" } : undefined });
        const text = await res.text();
        if (res.status !== 200) { errors++; firstError ??= res.status + " " + text.slice(0, 300); }
      } catch { errors++; }
      lat.push(performance.now() - s);
      if (++done === reqs.length) parentPort.postMessage({ latencies: lat, errors, firstError, seconds: (performance.now() - t0) / 1000 });
    };
    let i = 0;
    const tick = () => {
      const due = Math.min(reqs.length, Math.floor(((performance.now() - t0) / 1000) * rps) + 1);
      while (i < due) fire(reqs[i++]);
      if (i < reqs.length) setTimeout(tick, 1);
    };
    tick();
  `;
  const w = new Worker(code, { eval: true, workerData: { reqs, rps } });
  try {
    return await new Promise((res, rej) => {
      w.once("message", res);
      w.once("error", rej);
    });
  } finally {
    await w.terminate();
  }
}
