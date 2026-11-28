/**
 * MER-80 release smoke (agentic_architecture.md 2.1, DLC-04, DLC-05): what the Release agent runs
 * after a merge. Keeps a copy of the deployed binary, deploys the new one, runs the lifecycle, and
 * on a failed smoke redeploys the previous binary and opens a bug ticket naming the failed step.
 * Devnet only: the guard runs before anything is dumped, deployed or signed.
 */
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Cluster } from "./cluster.js";
import { deployDevnet, DeployOptions, DeploymentRecord, sha256 } from "./deploy.js";
import { formatReport, LifecycleOptions, LifecycleReport, runLifecycle, StepFailed } from "./lifecycle.js";

export interface Ticket {
  title: string;
  body: string;
  labels: string[];
}

export interface TicketSink {
  /** Opens the ticket; returns its URL or path. */
  open(t: Ticket): Promise<string>;
}

/** GitHub issue in the repository (the Release agent's token can only open issues). */
export class GitHubIssues implements TicketSink {
  constructor(private readonly repo: string, private readonly token: string, private readonly fetchFn: typeof fetch = fetch) {}
  async open(t: Ticket) {
    const r = await this.fetchFn(`https://api.github.com/repos/${this.repo}/issues`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: JSON.stringify({ title: t.title, body: t.body, labels: t.labels }),
    });
    if (!r.ok) throw new Error(`GitHub issue create failed: HTTP ${r.status}`);
    return ((await r.json()) as { html_url: string }).html_url;
  }
}

/** Markdown file per ticket, when no tracker token is configured. */
export class FileTickets implements TicketSink {
  constructor(private readonly dir: string) {}
  async open(t: Ticket) {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `bug-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    writeFileSync(path, `# ${t.title}\n\nLabels: ${t.labels.join(", ")}\n\n${t.body}\n`);
    return path;
  }
}

export interface ReleaseReport {
  ok: boolean;
  commit: string;
  programId: string;
  idlSha256: string;
  soSha256: string;
  /** "deploy" when the deploy itself failed, else the lifecycle step that failed. */
  failedStep?: string;
  error?: string;
  rolledBack: boolean;
  /** sha256 of the binary that is live after this run. */
  liveSoSha256: string | null;
  ticket?: string;
  deployment?: DeploymentRecord;
  lifecycle?: LifecycleReport;
}

export interface ReleaseOptions {
  deploy: Omit<DeployOptions, "cluster" | "log">;
  lifecycle: Omit<LifecycleOptions, "cluster" | "keys" | "deployment" | "log">;
  cluster: Cluster;
  tickets: TicketSink;
  workDir: string;
  log?: (m: string) => void;
}

export async function runRelease(o: ReleaseOptions): Promise<ReleaseReport> {
  const log = o.log ?? (() => {});
  await o.cluster.assertSafe();
  mkdirSync(o.workDir, { recursive: true });
  const prevPath = join(o.workDir, "previous-program.so");
  const hadPrev = await o.cluster.deployer.dump(prevPath);
  const prevSha = hadPrev ? sha256(prevPath) : null;
  log(hadPrev ? `kept the live binary (${prevSha!.slice(0, 12)}) for rollback` : "no live program: first deploy, nothing to roll back to");

  const base: ReleaseReport = {
    ok: false, commit: o.deploy.commit, programId: "", idlSha256: sha256(o.deploy.idlPath), soSha256: sha256(o.deploy.soPath),
    rolledBack: false, liveSoSha256: prevSha,
  };

  let deployment: DeploymentRecord;
  try {
    deployment = await deployDevnet({ ...o.deploy, cluster: o.cluster, log });
  } catch (e) {
    const report: ReleaseReport = { ...base, failedStep: "deploy", error: (e as Error).message };
    report.ticket = await o.tickets.open(ticketFor(report));
    return report;
  }
  const report: ReleaseReport = { ...base, programId: deployment.programId, deployment, liveSoSha256: base.soSha256 };

  try {
    const { report: lc } = await runLifecycle({ ...o.lifecycle, cluster: o.cluster, keys: o.deploy.keys, deployment, log });
    return { ...report, ok: true, lifecycle: lc };
  } catch (e) {
    report.failedStep = e instanceof StepFailed ? e.step : "lifecycle";
    report.error = (e as Error).message;
    if (e instanceof StepFailed) report.lifecycle = e.report;
    if (hadPrev) {
      log(`smoke failed at ${report.failedStep}: rolling back to ${prevSha!.slice(0, 12)}`);
      await o.cluster.deployer.deploy(prevPath);
      report.rolledBack = true;
      report.liveSoSha256 = prevSha;
    }
    report.ticket = await o.tickets.open(ticketFor(report));
    return report;
  }
}

export function ticketFor(r: ReleaseReport): Ticket {
  const body = [
    `The devnet release smoke failed at **${r.failedStep}**.`,
    "",
    `- Commit: \`${r.commit}\``,
    `- Program: \`${r.programId || "(not deployed)"}\``,
    `- New binary sha256: \`${r.soSha256}\`, IDL sha256: \`${r.idlSha256}\``,
    `- Rolled back: ${r.rolledBack ? `yes, devnet runs \`${r.liveSoSha256}\` again` : "no"}`,
    "",
    "Error:",
    "```",
    r.error ?? "",
    "```",
    ...(r.lifecycle ? ["", "Lifecycle report:", "```", formatReport(r.lifecycle), "```"] : []),
  ].join("\n");
  return { title: `Devnet release smoke failed at ${r.failedStep} (${r.commit.slice(0, 7)})`, body, labels: ["bug", "release-smoke"] };
}
