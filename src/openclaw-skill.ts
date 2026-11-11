/**
 * OpenClaw integration: Architect becomes the coding agent behind your OpenClaw assistant.
 * Message OpenClaw on Telegram, WhatsApp, Discord or any channel it bridges ("fix the failing
 * test in the shop repo"), and it hands the task to Architect over MCP, then reports back.
 *
 *   architect openclaw [--workspace <openclaw workspace>] [--url <architect server>]
 *
 * installs two things:
 *   1. the `architect` skill (SKILL.md): when and how OpenClaw should delegate coding work;
 *   2. the `architect` MCP server in OpenClaw's registry (`openclaw mcp add`), which runs
 *      `architect mcp` and talks to an Architect server (`architect serve`, or rchtch.app).
 *
 * Approvals stay with people: the MCP server cannot approve Architect's risky actions, so a
 * chat assistant can never wave through its own pushes, deploys or deletions.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const OPENCLAW_SKILL_NAME = "architect";
export const OPENCLAW_SERVER_NAME = "architect";
export const DEFAULT_ARCHITECT_URL = "http://localhost:7337";

export const OPENCLAW_SKILL = `---
name: architect
description: Delegate software work (fix bugs, build features, write tests, refactor, review or explain code) to :\\ARCHITECT\\, Infinitum's coding agent, and report the verified result.
homepage: https://rchtch.app
metadata:
  { "openclaw": { "emoji": "🏛️", "homepage": "https://rchtch.app" } }
---

# :\\ARCHITECT\\™ — coding agent

Use this skill whenever the person asks for work on code: fixing a bug or a failing test, building
or changing a feature, writing tests, refactoring, reviewing a change, or explaining how code works.
Architect plans the work, edits and runs code in its own workspace, runs the project's tests, and
verifies the outcome before it reports back. Do not write or edit the code yourself when Architect
is available: hand it the task.

## Tools (from the \`architect\` MCP server)

- \`architect_run\` — start a task. Pass the person's request as \`goal\`, in their own words plus
  any detail they gave (repository, file, error message). Use \`wait: true\` and \`wait_seconds: 600\`
  so you can report the result in the same reply when it is quick.
  - \`autonomy\`: \`accompaniment\` (default: risky actions wait for a person), \`rehearsal\` (plan
    only, change nothing: use it when the person asks "what would you do"), \`autopilot\` (only when
    the person explicitly asks Architect to go ahead on its own).
  - \`follow_up\`: the id of the earlier run when the person continues the same task
    ("now add a test for it", "also handle the empty cart").
  - \`budget_usd\`: pass it when the person names a spending limit.
- \`architect_get_run\` — check a run (\`wait: true\` to wait for it to finish).
- \`architect_list_runs\` — recent runs, when the person asks what Architect has been doing.
- \`architect_pending_approvals\` — actions waiting for a person.
- \`architect_recover\` — resume a failed or handed-off run when the person asks to retry.
- \`architect_cancel\` — stop a run when the person asks to stop.

## Reporting back

- Say whether the work was verified (\`verdict.passed\`), what changed (the step summaries), what
  it cost (\`spendUsd\`) and the run id, briefly, in the person's language.
- If a run is \`awaiting_approval\`, tell the person what is waiting and that they approve or decline
  it in the Architect app or the \`architect\` CLI. **Never try to approve it yourself**, and never
  ask Architect to skip its approvals.
- If it is still running after the wait, say so and offer to check again with \`architect_get_run\`.
- If the tools fail with a connection error, the Architect server is not running: suggest
  \`architect serve --workspace <project folder>\`.
`;

export interface OpenClawInstallOptions {
  /** OpenClaw workspace; the skill goes in <workspace>/skills. Default: the shared ~/.openclaw/skills. */
  workspace?: string;
  /** OpenClaw's home folder (for tests). Default: ~/.openclaw. */
  home?: string;
}

/** Where the skill folder goes: a workspace's own skills, or the skills shared by every local agent. */
export function skillDir(opts: OpenClawInstallOptions = {}): string {
  const root = opts.workspace ? path.join(path.resolve(opts.workspace), "skills") : path.join(opts.home ?? path.join(homedir(), ".openclaw"), "skills");
  return path.join(root, OPENCLAW_SKILL_NAME);
}

/** Write (or refresh) the architect skill. Returns the SKILL.md path. */
export async function installSkill(opts: OpenClawInstallOptions = {}): Promise<string> {
  const dir = skillDir(opts);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  await writeFile(file, OPENCLAW_SKILL);
  return file;
}

export interface McpRegistration {
  /** Path of this build's cli.js. */
  cli: string;
  /** The Architect server `architect mcp` talks to. */
  url: string;
  /** Pass ARCHITECT_API_TOKEN through to the server definition (value never printed). */
  token?: string;
  /** Node executable. */
  node?: string;
}

/** Arguments for `openclaw mcp add architect ...`. */
export function mcpAddArgs(r: McpRegistration): string[] {
  const args = ["mcp", "add", OPENCLAW_SERVER_NAME, "--command", r.node ?? process.execPath, "--arg", r.cli, "--arg", "mcp", "--env", `ARCHITECT_URL=${r.url}`];
  if (r.token) args.push("--env", `ARCHITECT_API_TOKEN=${r.token}`);
  return args;
}

/** Double-quote an argument with spaces or shell characters; backslashes stay as they are (Windows paths). */
export function shellQuote(a: string): string {
  return /[\s"'&|<>^;]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

/** The same command for a person to read or paste, with the token replaced by a placeholder. */
export function printableMcpAdd(r: McpRegistration): string {
  return ["openclaw", ...mcpAddArgs({ ...r, token: r.token ? "<your ARCHITECT_API_TOKEN>" : undefined })].map(shellQuote).join(" ");
}

export interface OpenClawResult {
  skill: string;
  /** "added" when the MCP server was registered; otherwise why not, with the command to run. */
  mcp: { status: "added" | "no-openclaw" | "failed"; command: string; detail?: string };
}

/** Install the skill and register the MCP server (when the openclaw CLI is on PATH). */
export async function installOpenClaw(
  opts: OpenClawInstallOptions & McpRegistration,
  run: (cmd: string, args: string[]) => { status: number | null; error?: Error; stderr?: string } = (cmd, args) => {
    // On Windows the openclaw shim is a .cmd, which needs a shell; quote arguments with spaces
    // (C:\Program Files\nodejs\node.exe) so the shell keeps each one whole.
    const r =
      process.platform === "win32"
        ? spawnSync([cmd, ...args].map(shellQuote).join(" "), { encoding: "utf8", shell: true })
        : spawnSync(cmd, args, { encoding: "utf8" });
    return { status: r.status, error: r.error, stderr: r.stderr };
  },
): Promise<OpenClawResult> {
  const skill = await installSkill(opts);
  const command = printableMcpAdd(opts);
  const r = run("openclaw", mcpAddArgs(opts));
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") return { skill, mcp: { status: "no-openclaw", command } };
  if (r.status !== 0) {
    const why = String(r.stderr ?? "").trim().split("\n").slice(-3).join(" ");
    // Never echo a token the CLI might have repeated back.
    const safe = opts.token ? why.split(opts.token).join("<token>") : why;
    return { skill, mcp: { status: r.status === 127 || /not (found|recognized)/i.test(safe) ? "no-openclaw" : "failed", command, detail: safe || undefined } };
  }
  return { skill, mcp: { status: "added", command } };
}
