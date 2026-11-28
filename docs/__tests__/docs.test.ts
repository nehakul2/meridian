/**
 * MER-82: the docs stay true to the repo.
 * - Every command in a README code block exists: `make <target>` in the Makefile,
 *   `npm test` / `npm run <script>` in the package the block has `cd`-ed into,
 *   `node dist/...` has a source file, and `npx <bin>` is a dependency of that package.
 * - Every relative link in README.md and docs/*.md resolves to a file in the repo.
 * - The risks note (and the rationale) make no regulatory or compliance claims.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const readme = read("README.md");

const makeTargets = new Set(
  read("Makefile")
    .split("\n")
    .map((l) => /^([A-Za-z0-9_.-]+):/.exec(l)?.[1])
    .filter((x): x is string => !!x),
);

function pkg(dir: string): { scripts: Record<string, string>; deps: Set<string> } | null {
  const p = join(root, dir, "package.json");
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, "utf8")) as { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object };
  return { scripts: j.scripts ?? {}, deps: new Set([...Object.keys(j.dependencies ?? {}), ...Object.keys(j.devDependencies ?? {})]) };
}

/** Binaries `npx` may run, by the package that provides them. */
const BIN: Record<string, string> = { vitest: "vitest", tsc: "typescript", next: "next", playwright: "@playwright/test" };

/** Checks one shell line (possibly `a && b`) from a README block; returns problems. */
export function checkLine(line: string, cwd: string): { cwd: string; problems: string[] } {
  const problems: string[] = [];
  const code = line.replace(/#.*$/, "").trim();
  if (!code) return { cwd, problems };
  for (const part of code.split(/&&|\|\||;|\(|\)|&/).map((x) => x.trim()).filter(Boolean)) {
    const words = part.split(/\s+/).filter((w) => !/^[A-Z_]+=/.test(w)); // drop VAR=value prefixes
    const [cmd, a1, a2] = words;
    if (cmd === "cd") {
      cwd = normalize(join(cwd, a1!));
      if (!existsSync(join(root, cwd))) problems.push(`cd into missing ${cwd}`);
    } else if (cmd === "make") {
      if (!makeTargets.has(a1!)) problems.push(`make target "${a1}" not in Makefile`);
    } else if (cmd === "npm" && (a1 === "test" || a1 === "run")) {
      const p = pkg(cwd);
      const script = a1 === "test" ? "test" : a2!;
      if (!p) problems.push(`npm ${a1} in ${cwd}, which has no package.json`);
      else if (!(script in p.scripts)) problems.push(`npm script "${script}" missing in ${cwd}/package.json`);
    } else if (cmd === "npx") {
      const p = pkg(cwd);
      const dep = BIN[a1!];
      if (!dep) problems.push(`npx ${a1}: unknown binary, add it to BIN`);
      else if (!p?.deps.has(dep)) problems.push(`npx ${a1} in ${cwd}: ${dep} is not a dependency`);
    } else if (cmd === "node" && a1?.startsWith("dist/")) {
      // dist/<rel>.js comes from <rel>.ts in the package, or from ../<rel>.ts when rootDir is "..".
      const rel = a1.slice("dist/".length).replace(/\.js$/, ".ts");
      if (![join(cwd, rel), join(cwd, "..", rel)].some((p) => existsSync(join(root, p)))) problems.push(`no source for ${cwd}/${a1}`);
    } else if (cmd === "scripts/devnet/set-program-id.sh" || cmd?.startsWith("./scripts/")) {
      if (!existsSync(join(root, cmd.replace(/^\.\//, "")))) problems.push(`missing ${cmd}`);
    }
  }
  return { cwd, problems };
}

function readmeBlocks(md: string): string[][] {
  const out: string[][] = [];
  const re = /```(?:sh|bash)?\n([\s\S]*?)```/g;
  for (let m = re.exec(md); m; m = re.exec(md)) out.push(m[1]!.split("\n"));
  return out;
}

const docFiles = ["README.md", ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)];

describe("MER-82 docs", () => {
  it("every command in the README exists in the Makefile or package scripts", () => {
    const problems: string[] = [];
    let commands = 0;
    for (const block of readmeBlocks(readme)) {
      let cwd = ".";
      for (const line of block) {
        if (/^\s*(make|npm|npx|node|cd)\b/.test(line)) commands++;
        const r = checkLine(line, cwd);
        cwd = r.cwd;
        problems.push(...r.problems);
      }
    }
    expect(problems).toEqual([]);
    expect(commands).toBeGreaterThan(20);
  });

  it("the README covers setup, tests and the devnet lifecycle", () => {
    for (const t of ["make doctor", "make build", "make test", "make deploy-devnet", "make lifecycle-devnet", "make release-devnet", "make load-test"]) {
      expect(readme).toContain(t);
    }
  });

  it("the checker catches a wrong command", () => {
    expect(checkLine("make no-such-target", ".").problems).toHaveLength(1);
    expect(checkLine("cd services/api && npm run no-such-script", ".").problems).toHaveLength(1);
    expect(checkLine("node dist/nope/main.js", "services/api").problems).toHaveLength(1);
    expect(checkLine("make build   # comment", ".").problems).toEqual([]);
  });

  it("internal links in README.md and docs/*.md resolve", () => {
    const broken: string[] = [];
    for (const f of docFiles) {
      const md = read(f).replace(/```[\s\S]*?```/g, "");
      for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
        const href = m[1]!;
        if (/^[a-z]+:/i.test(href) || href.startsWith("#")) continue;
        const target = join(dirname(join(root, f)), href.split("#")[0]!);
        if (!existsSync(target)) broken.push(`${f}: ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("the rationale, risks and open-questions docs exist and are linked from the README", () => {
    for (const f of ["docs/architecture.md", "docs/risks.md", "docs/open-questions.md"]) {
      expect(existsSync(join(root, f))).toBe(true);
      expect(readme).toContain(`](${f})`);
    }
  });

  it("the rationale covers chain, order book, oracle and settlement choices and justifies dependencies", () => {
    const a = read("docs/architecture.md");
    for (const h of ["## Chain", "## Order book", "## Oracle", "## Settlement", "## Dependencies"]) expect(a).toContain(h);
    for (const dep of ["anchor-lang", "bytemuck", "LiteSVM", "pyth-solana-receiver", "fastify", "`ws`", "ioredis", "`pg`", "Next.js"]) expect(a).toContain(dep);
  });

  it("the risks note matches spec 11 and makes no compliance claims", () => {
    const risks = read("docs/risks.md");
    // Spec 11 topics.
    for (const t of ["Trust in roles", "Hot keys", "dispute", "override price has no on-chain bound", "app and API only", "State growth", "new code holding funds"]) {
      expect(risks).toContain(t);
    }
    const banned = /complian|regulat|licen[cs]|lawful|legal|securities|\bSEC\b|CFTC|FINRA|\bKYC\b|\bAML\b|registered|approved by|sanction|jurisdiction|permitted/i;
    for (const f of ["docs/risks.md", "docs/architecture.md"]) {
      const hits = read(f).split("\n").filter((l) => banned.test(l));
      expect(hits, f).toEqual([]);
    }
  });
});
