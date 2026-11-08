/**
 * Safety checks for projects Architect builds. Each one wraps an external open-source scanner that
 * Architect does not install or ship; a check runs only when its tool is found on this machine.
 *
 *   osv-scanner   google/osv-scanner (Apache-2.0)   known vulnerabilities in dependencies
 *   git-secrets   awslabs/git-secrets (Apache-2.0)  secrets in files, plus a pre-commit hook
 *   skillspector  NVIDIA/SkillSpector (Apache-2.0)  risky patterns in agent skills and plugins
 *   garak         NVIDIA/garak (Apache-2.0)         LLM red-teaming, only when configured
 *
 * Scans run through the workspace sandbox, with network limited to what each scanner needs.
 * See docs/safety-scanning.md for installation.
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceInstrument } from "../instruments/workspace.js";

export type CheckStatus = "passed" | "findings" | "skipped" | "error";

export interface CheckResult {
  id: string;
  name: string;
  status: CheckStatus;
  /** One line for people. */
  summary: string;
  /** Scanner output, trimmed. */
  output?: string;
  /** How to install the tool, when it was not found. */
  install?: string;
}

interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SafetyCheck {
  id: string;
  name: string;
  install: string;
  /** Hosts the scanner may reach from inside the sandbox. */
  hosts: string[];
  /** Command that succeeds only when the tool is installed. */
  probe: string;
  /** Why the check does not apply to this project, or undefined to run it. */
  notApplicable?(root: string, env: NodeJS.ProcessEnv): Promise<string | undefined>;
  command(env: NodeJS.ProcessEnv): string;
  interpret(out: RunOutput): { status: CheckStatus; summary: string };
  /** Secret-looking environment variables the scanner needs (normally withheld from commands). */
  passEnv?(env: NodeJS.ProcessEnv): string[];
  /** More hosts from configuration (e.g. the model endpoint garak probes). */
  extraHosts?(env: NodeJS.ProcessEnv): string[];
}

const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const exists = (p: string) => stat(p).then(() => true, () => false);

/** True when a folder (to depth 3) holds agent skills, plugins or MCP server configs. */
export async function hasAgentExtensions(root: string, depth = 3): Promise<boolean> {
  const markers = new Set(["SKILL.md", ".mcp.json", "plugin.json", "marketplace.json"]);
  const dirs = new Set([".claude-plugin", "skills", ".claude"]);
  const walk = async (dir: string, d: number): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      if (e.isFile() && markers.has(e.name)) return true;
      if (e.isDirectory() && dirs.has(e.name)) return true;
    }
    if (d <= 0) return false;
    for (const e of entries) {
      if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git" && (await walk(path.join(dir, e.name), d - 1))) return true;
    }
    return false;
  };
  return walk(root, depth);
}

export const CHECKS: SafetyCheck[] = [
  {
    id: "osv-scanner",
    name: "Dependency vulnerabilities (osv-scanner)",
    install: "Download a release binary from https://github.com/google/osv-scanner/releases, or: go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest",
    hosts: ["api.osv.dev", "osv-vulnerabilities.storage.googleapis.com", "api.deps.dev"],
    probe: "osv-scanner --version",
    command: () => "osv-scanner scan source -r .",
    interpret: ({ code, stdout, stderr }) => {
      if (code === 0) return { status: "passed", summary: "no known vulnerabilities in dependencies" };
      if (code === 1) return { status: "findings", summary: "vulnerable dependencies found" };
      if (code === 128 || /no package sources found/i.test(stdout + stderr)) return { status: "passed", summary: "no lockfiles or manifests to scan" };
      return { status: "error", summary: `osv-scanner exited with ${code}` };
    },
  },
  {
    id: "git-secrets",
    name: "Secrets in files (git-secrets)",
    install: "macOS: brew install git-secrets. Linux: clone https://github.com/awslabs/git-secrets and run `make install`. Windows: run install.ps1 from that repository. Then register patterns, e.g. `git secrets --register-aws --global`.",
    hosts: [],
    probe: "git secrets --list",
    notApplicable: async (root) => ((await exists(path.join(root, ".git"))) ? undefined : "not a git repository"),
    command: () => "git secrets --scan --untracked",
    interpret: ({ code, stdout, stderr }) => {
      if (code === 0) return { status: "passed", summary: "no secrets matched the registered patterns" };
      if (/\[ERROR\] Matched one or more prohibited patterns/i.test(stdout + stderr) || code === 1) {
        return { status: "findings", summary: "files match a prohibited secret pattern" };
      }
      return { status: "error", summary: `git-secrets exited with ${code}` };
    },
  },
  {
    id: "skillspector",
    name: "Agent skills and plugins (SkillSpector)",
    install: "uv tool install git+https://github.com/NVIDIA/skillspector.git  (Python 3.12+)",
    hosts: ["api.osv.dev"],
    probe: "skillspector --help",
    notApplicable: async (root) => ((await hasAgentExtensions(root)) ? undefined : "no agent skills, plugins or MCP configs in this project"),
    // Static analysis only: the optional LLM stage would send project files to a model provider.
    command: () => "skillspector scan . --no-llm --format json",
    interpret: ({ code, stdout }) => {
      const severe = /"severity"\s*:\s*"(critical|high)"/i.test(stdout);
      if (code === 0 && !severe) return { status: "passed", summary: "no high or critical findings in skills or plugins" };
      if (severe || /"findings"\s*:\s*\[\s*\{/.test(stdout)) return { status: "findings", summary: "risky patterns found in skills or plugins" };
      return { status: "error", summary: `skillspector exited with ${code}` };
    },
  },
  {
    id: "garak",
    name: "LLM red-teaming (garak)",
    install: "python -m pip install -U garak  (then set ARCHITECT_GARAK_ARGS, e.g. \"--target_type openai --target_name <model> --probes promptinject\")",
    hosts: [],
    probe: "python -m garak --version",
    notApplicable: async (_root, env) =>
      env.ARCHITECT_GARAK_ARGS ? undefined : "set ARCHITECT_GARAK_ARGS to say which model endpoint to probe",
    command: (env) => `python -m garak ${env.ARCHITECT_GARAK_ARGS ?? ""}`.trim(),
    passEnv: (env) => list(env.ARCHITECT_GARAK_PASS_ENV),
    extraHosts: (env) => list(env.ARCHITECT_GARAK_HOSTS),
    interpret: ({ code, stdout, stderr }) => {
      if (code !== 0) return { status: "error", summary: `garak exited with ${code}` };
      const failed = /\bFAIL\b/.test(stdout + stderr);
      return failed
        ? { status: "findings", summary: "some probes got through; see the garak report" }
        : { status: "passed", summary: "no probe failures reported" };
    },
  },
];

export interface ScanOptions {
  /** Only these check ids. Default: all. */
  only?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const tail = (s: string, n = 6_000) => (s.length > n ? `…${s.slice(-n)}` : s);

/** Run every applicable, installed check in `root` through the workspace's sandbox. */
export async function runSafetyChecks(workspace: WorkspaceInstrument, root: string, opts: ScanOptions = {}): Promise<CheckResult[]> {
  const env = opts.env ?? process.env;
  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    if (opts.only?.length && !opts.only.includes(check.id)) continue;
    const base = { id: check.id, name: check.name };
    const na = await check.notApplicable?.(root, env);
    if (na) {
      results.push({ ...base, status: "skipped", summary: na });
      continue;
    }
    const probe = await workspace.run(check.probe, { cwd: root, timeoutMs: 30_000, limits: { allowedDomains: [] } });
    if (probe.code !== 0) {
      results.push({ ...base, status: "skipped", summary: "not installed", install: check.install });
      continue;
    }
    const out = await workspace.run(check.command(env), {
      cwd: root,
      timeoutMs: opts.timeoutMs ?? 600_000,
      limits: { allowedDomains: [...check.hosts, ...(check.extraHosts?.(env) ?? [])] },
      passEnv: check.passEnv?.(env),
    });
    const verdict = check.interpret(out);
    results.push({ ...base, ...verdict, output: tail(`${out.stdout}${out.stderr ? `\n${out.stderr}` : ""}`.trim()) });
  }
  return results;
}

export function formatResults(results: CheckResult[]): string {
  const mark: Record<CheckStatus, string> = { passed: "✓", findings: "✗", skipped: "–", error: "!" };
  return results
    .map((r) => `${mark[r.status]} ${r.name}: ${r.summary}${r.install ? `\n    install: ${r.install}` : ""}`)
    .join("\n");
}

/**
 * Install git-secrets' hooks (pre-commit, commit-msg, prepare-commit-msg) in a repository.
 * Run by a person from the CLI, not by the model: it writes to .git/hooks, which the sandbox
 * keeps read-only for commands.
 */
export function installGitSecretsHooks(repo: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["secrets", "--install", "-f"], { cwd: repo, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git secrets --install failed: ${stderr || err.message}. Is git-secrets installed?`));
      else resolve(`${stdout}${stderr}`.trim());
    });
  });
}
