/**
 * Devnet commands (MER-80). Run through the Makefile:
 *
 *   make deploy-devnet       deploy or upgrade, initialise Config, write deployments/devnet.json
 *   make lifecycle-devnet    one full trading day on devnet; prints the report
 *   make release-devnet      deploy + lifecycle smoke, roll back and open a ticket on failure
 *
 * Environment:
 *   DEVNET_RPC_URL     default https://api.devnet.solana.com (mainnet is refused: URL and genesis)
 *   DEPLOYER_KEYPAIR   funded devnet wallet, fee payer and upgrade authority (default ~/.config/solana/id.json)
 *   PROGRAM_KEYPAIR    keypair of the program id in declare_id! (default target/deploy/meridian-keypair.json)
 *   KEYS_DIR           role keys, generated once (default .devnet/keys)
 *   HERMES_URL         default https://hermes.pyth.network
 *   FEEDS_FILE         optional JSON {"AAPL": "<feed id hex>", ...}; otherwise resolved from Hermes
 *   TICKER, DATE, TRADE_WINDOW_S   lifecycle options (default AAPL, first free date, 240 s)
 *   GITHUB_TOKEN + GITHUB_REPOSITORY   release tickets as GitHub issues (else .devnet/tickets/*.md)
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROGRAM_ID } from "../../services/automation/src/chain/idl.js";
import { HermesOracle, RpcCluster, SolanaCliDeployer } from "./cluster.js";
import { deployDevnet, DeploymentRecord, MAG7 } from "./deploy.js";
import { loadDevnetKeys, loadKeypair } from "./keys.js";
import { formatReport, runLifecycle, StepFailed } from "./lifecycle.js";
import { FileTickets, GitHubIssues, runRelease } from "./release.js";

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "programs/meridian/idl/meridian.json"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repository root not found");
}

const root = repoRoot();
const env = (k: string, d: string) => process.env[k] || d;
const recordPath = join(root, "deployments/devnet.json");
const log = (m: string) => console.error(m);

function commit(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
  } catch {
    return "unknown";
  }
}

function readRecord(): DeploymentRecord | null {
  return existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, "utf8")) as DeploymentRecord) : null;
}

function writeJson(path: string, v: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
}

function usHoursWarning() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const mins = et.getHours() * 60 + et.getMinutes();
  if (et.getDay() === 0 || et.getDay() === 6 || mins < 9 * 60 + 30 || mins >= 16 * 60) {
    log("warning: outside US regular hours Pyth equity feeds may not publish at close_time; record-close can fail. Run 09:30-16:00 ET.");
  }
}

/** Returns the process exit code: 0 ok, 1 refused or failed (the failed step is printed), 2 usage. */
export async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!["deploy", "lifecycle", "release"].includes(cmd ?? "")) {
    log("usage: cli.js deploy | lifecycle | release");
    return 2;
  }
  const url = env("DEVNET_RPC_URL", "https://api.devnet.solana.com");
  const devnetDir = resolve(root, env("DEVNET_DIR", ".devnet"));
  const hermes = new HermesOracle({ baseUrl: env("HERMES_URL", "https://hermes.pyth.network") });
  const deployerPath = resolve(root, env("DEPLOYER_KEYPAIR", join(homedir(), ".config/solana/id.json")));
  const programKeypairPath = resolve(root, env("PROGRAM_KEYPAIR", "target/deploy/meridian-keypair.json"));
  const cluster = new RpcCluster(url, hermes, new SolanaCliDeployer({
    url, deployerKeypair: deployerPath, programKeypair: programKeypairPath, programId: PROGRAM_ID,
  }));
  // Refuse mainnet before reading anything else (DLC-04).
  await cluster.assertSafe();
  const keys = loadDevnetKeys(join(devnetDir, "keys"), deployerPath);

  const deployInputs = async () => {
    const previous = readRecord();
    const feeds = process.env.FEEDS_FILE
      ? (JSON.parse(readFileSync(process.env.FEEDS_FILE, "utf8")) as Record<string, string>)
      : previous?.tickers && Object.keys(previous.tickers).length ? previous.tickers : await hermes.equityFeedIds(MAG7);
    if (!existsSync(programKeypairPath)) throw new Error(`program keypair ${programKeypairPath} not found (PROGRAM_KEYPAIR)`);
    return {
      keys, previous, feeds, commit: commit(),
      soPath: join(root, "target/deploy/meridian.so"), idlPath: join(root, "programs/meridian/idl/meridian.json"),
      programKeypair: loadKeypair(programKeypairPath).publicKey,
    };
  };
  const lifecycleInputs = () => ({
    ticker: env("TICKER", "AAPL"),
    date: process.env.DATE ? Number(process.env.DATE) : undefined,
    tradeWindowS: Number(env("TRADE_WINDOW_S", "240")),
  });

  if (cmd === "deploy") {
    const rec = await deployDevnet({ ...(await deployInputs()), cluster, log });
    writeJson(recordPath, rec);
    console.log(JSON.stringify({ programId: rec.programId, idlSha256: rec.idlSha256, soSha256: rec.soSha256, record: recordPath }, null, 2));
    return 0;
  }
  if (cmd === "lifecycle") {
    const rec = readRecord();
    if (!rec) throw new Error(`${recordPath} not found: run make deploy-devnet first`);
    usHoursWarning();
    try {
      const { report } = await runLifecycle({ ...lifecycleInputs(), cluster, keys, deployment: rec, log });
      writeJson(join(devnetDir, "reports", `lifecycle-${report.date}-${Date.now()}.json`), report);
      console.log(formatReport(report));
      return 0;
    } catch (e) {
      if (e instanceof StepFailed) {
        writeJson(join(devnetDir, "reports", `lifecycle-failed-${Date.now()}.json`), e.report);
        console.log(formatReport(e.report));
        log(e.message);
        return 1;
      }
      throw e;
    }
  }
  if (cmd === "release") {
    usHoursWarning();
    const tickets = process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY
      ? new GitHubIssues(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN)
      : new FileTickets(join(devnetDir, "tickets"));
    const r = await runRelease({ cluster, deploy: await deployInputs(), lifecycle: lifecycleInputs(), tickets, workDir: join(devnetDir, "release"), log });
    if (r.deployment && (r.ok || !r.rolledBack)) writeJson(recordPath, r.deployment);
    writeJson(join(devnetDir, "reports", `release-${Date.now()}.json`), r);
    if (r.lifecycle) console.log(formatReport(r.lifecycle));
    console.log(JSON.stringify({ ok: r.ok, commit: r.commit, programId: r.programId, idlSha256: r.idlSha256, failedStep: r.failedStep, rolledBack: r.rolledBack, ticket: r.ticket }, null, 2));
    return r.ok ? 0 : 1;
  }
  return 2;
}

/** main() with errors printed and turned into exit code 1. */
export async function runCli(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (e) {
    log((e as Error).message ?? String(e));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
