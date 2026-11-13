import { spawn } from "node:child_process";
import { glob, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { truncate } from "../policy.js";
import { evaluateCommand, policyFromEnv, riskOf, type CommandPolicy } from "../sandbox/execpolicy.js";
import {
  RuntimeSandbox,
  sandboxFor,
  scrubEnv,
  type CommandSandbox,
  type SandboxLimits,
  type SandboxMode,
} from "../sandbox/runtime.js";
import type { RunSupervisor } from "../supervisor.js";
import { lineDiff } from "./diff.js";
import type { Instrument, ToolContext, ToolOutput, ToolSpec } from "./types.js";

export { lineDiff };

export interface WorkspaceOptions {
  commandTimeoutMs?: number;
  /** Which commands run, need approval, or never run. Defaults to ARCHITECT_EXECPOLICY or the built-in rules. */
  policy?: CommandPolicy;
  /** A sandbox instance, or a mode for the shared one (default ARCHITECT_SANDBOX, then "auto"). */
  sandbox?: CommandSandbox | SandboxMode;
  /** Extra limits for the sandbox (more hosts, more read-only paths). */
  limits?: Partial<SandboxLimits>;
  /** Secret-looking environment variables that commands may still see (e.g. NPM_TOKEN). */
  passEnv?: string[];
  /** Give every run its own folder under this supervisor instead of sharing `root`. */
  supervisor?: RunSupervisor;
}

/** Files a coding agent reads as standing project instructions (Claude Code, Cursor, Codex, Grok conventions). */
export const RULE_FILES = ["ARCHITECT.md", "AGENTS.md", "CLAUDE.md", ".cursorrules", "GROK.md", ".github/copilot-instructions.md"];
const SKIP_DIRS = ["node_modules", ".git", "dist", "build", ".next", ".architect", "coverage", "target", ".venv", "__pycache__"];
const skip = (rel: string) => rel.split(/[\\/]/).some((part) => SKIP_DIRS.includes(part));

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Name of the sandbox the command ran in ("none" when unconfined). */
  sandbox: string;
}

/**
 * Files and commands, confined to one workspace directory.
 * This is how Architect builds things: write code, run the build and tests, read the output.
 * Commands pass the command policy first, then run inside the OS sandbox with the workspace
 * as the only writable folder and network limited to package registries and code hosts.
 */
export class WorkspaceInstrument implements Instrument {
  name = "workspace";
  description =
    "A project folder on disk. List, read and write files, and run shell commands (build, test, git) inside it.";
  readonly root: string;
  readonly policy: CommandPolicy;
  private sandbox?: Promise<CommandSandbox>;

  constructor(root: string, private opts: WorkspaceOptions = {}) {
    this.root = path.resolve(root);
    this.policy = opts.policy ?? policyFromEnv();
  }

  /** The sandbox commands run in, started on first use. */
  sandboxReady(): Promise<CommandSandbox> {
    const s = this.opts.sandbox;
    this.sandbox ??= typeof s === "object" ? Promise.resolve(s) : sandboxFor(s, this.opts.limits);
    return this.sandbox;
  }

  tools: ToolSpec[] = [
    {
      name: "workspace_list",
      description: "List files and folders at a path inside the workspace (default: the root).",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
      permission: "workspace.read",
      risk: "read",
    },
    {
      name: "workspace_read",
      description: "Read a text file inside the workspace.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      permission: "workspace.read",
      risk: "read",
    },
    {
      name: "workspace_write",
      description: "Create or overwrite a text file inside the workspace. Parent folders are created.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      permission: "workspace.write",
      risk: "write",
    },
    {
      name: "workspace_edit",
      description:
        "Edit a file by exact string replacement. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. " +
        "Prefer this over workspace_write for changes to existing files. Returns the diff.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
        required: ["path", "old_string", "new_string"],
      },
      permission: "workspace.write",
      risk: "write",
    },
    {
      name: "workspace_search",
      description:
        "Search file contents with a regular expression (like ripgrep). Optional path (folder) and glob (e.g. **/*.ts). Returns file:line: text, up to max results (default 100).",
      input_schema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" }, ignore_case: { type: "boolean" }, max: { type: "number" } },
        required: ["pattern"],
      },
      permission: "workspace.read",
      risk: "read",
    },
    {
      name: "workspace_glob",
      description: "Find files by glob pattern, e.g. src/**/*.tsx or **/package.json. Skips node_modules, .git and build output.",
      input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
      permission: "workspace.read",
      risk: "read",
    },
    {
      name: "workspace_diff",
      description: "Show uncommitted changes in the workspace's git repository (git status and git diff). Use it to review your work before finishing.",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
      permission: "workspace.read",
      risk: "read",
    },
    {
      name: "workspace_run",
      description:
        "Run a shell command with the workspace as the working directory. Returns exit code, stdout and stderr. Use for installs, builds, tests and git. " +
        "Commands run in a sandbox: only the workspace and the temp folder are writable, and network reaches package registries and code hosts only. " +
        "Deploys, publishing, pushes and recursive deletes need a person's approval; sudo and piping downloads into a shell are refused.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      permission: "shell",
      risk: (input) => riskOf(evaluateCommand(String(input.command), this.policy).decision),
    },
  ];

  rules(ctx?: Pick<ToolContext, "runId">): Promise<string> {
    return this.projectRules(ctx);
  }

  /** Standing project instructions from rule files at the workspace root, for the prompts. */
  async projectRules(ctx?: Pick<ToolContext, "runId">): Promise<string> {
    const root = await this.rootFor(ctx).catch(() => this.root);
    const parts: string[] = [];
    for (const name of RULE_FILES) {
      const text = await readFile(path.join(root, name), "utf8").catch(() => "");
      if (text.trim()) parts.push(`--- ${name} ---\n${truncate(text.trim(), 8_000)}`);
    }
    for (const rel of await this.files(root, ".cursor/rules/*", 20).catch(() => [])) {
      const text = await readFile(path.join(root, rel), "utf8").catch(() => "");
      if (text.trim()) parts.push(`--- ${rel} ---\n${truncate(text.trim(), 4_000)}`);
    }
    return parts.join("\n\n");
  }

  /** Files under root matching a glob, skipping dependency and build folders. */
  private async files(root: string, pattern: string, limit = 5_000): Promise<string[]> {
    const out: string[] = [];
    for await (const f of glob(pattern || "**/*", { cwd: root, exclude: (p: unknown) => skip(String(typeof p === "string" ? p : (p as { name: string }).name)) })) {
      const rel = String(f).replace(/\\/g, "/");
      if (skip(rel)) continue;
      out.push(rel);
      if (out.length >= limit) break;
    }
    return out.sort();
  }

  /** The folder a run works in: its own folder under the supervisor, or the shared root. */
  async rootFor(ctx?: Pick<ToolContext, "runId">): Promise<string> {
    const sup = this.opts.supervisor;
    if (!sup || !ctx) {
      await mkdir(this.root, { recursive: true });
      return this.root;
    }
    return (await sup.acquire(ctx.runId)).root;
  }

  /** Called by Architect when a run ends: the supervisor keeps or removes its folder. */
  async endRun(runId: string, outcome: string) {
    await this.opts.supervisor?.release(runId, outcome);
  }

  async handoff(ctx: ToolContext): Promise<Record<string, string>> {
    // Point at the folder without creating one for a run that never used the workspace.
    return { workspace: this.opts.supervisor ? this.opts.supervisor.rootFor(ctx.runId) : this.root };
  }

  /** Resolve a model-supplied path and refuse anything outside the workspace, including through a symlink. */
  async resolve(p: string, root: string = this.root): Promise<string> {
    const full = path.resolve(root, p || ".");
    const rel = path.relative(root, full);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`path "${p}" is outside the workspace`);
    }
    const rootReal = await realpath(root);
    let cursor = full;
    for (;;) {
      try {
        const real = await realpath(cursor);
        const relReal = path.relative(rootReal, real);
        if (relReal === ".." || relReal.startsWith(`..${path.sep}`) || path.isAbsolute(relReal)) {
          throw new Error(`path "${p}" is outside the workspace`);
        }
        return full;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const parent = path.dirname(cursor);
        if (parent === cursor) return full;
        cursor = parent;
      }
    }
  }

  async execute(tool: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    const root = await this.rootFor(ctx);
    switch (tool) {
      case "workspace_list": {
        const dir = await this.resolve(String(input.path ?? "."), root);
        const entries = await readdir(dir, { withFileTypes: true });
        const lines = entries
          .filter((e) => e.name !== "node_modules" && e.name !== ".git")
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { text: lines.join("\n") || "(empty)" };
      }
      case "workspace_read": {
        const file = await this.resolve(String(input.path), root);
        const info = await stat(file);
        if (info.size > 2_000_000) return { text: "File is larger than 2 MB; read a smaller file.", isError: true };
        return { text: truncate(await readFile(file, "utf8"), 40_000) };
      }
      case "workspace_write": {
        const file = await this.resolve(String(input.path), root);
        await mkdir(path.dirname(file), { recursive: true });
        const previous = await readFile(file, "utf8").catch(() => "");
        // Models write \n; keep a file's CRLF line endings (Windows checkouts) so only real changes show.
        const content = usesCrlf(previous) ? toCrlf(String(input.content)) : String(input.content);
        await writeFile(file, content, "utf8");
        const relw = path.relative(root, file).replace(/\\/g, "/");
        ctx.addEvidence({ kind: "file", label: `${previous ? "rewrote" : "created"} ${relw}`, content: truncate(lineDiff(previous, content, relw), 6_000) });
        return { text: `Wrote ${path.relative(root, file)} (${content.length} chars).` };
      }
      case "workspace_edit": {
        const file = await this.resolve(String(input.path), root);
        const rel = path.relative(root, file).replace(/\\/g, "/");
        const before = await readFile(file, "utf8").catch(() => undefined);
        if (before === undefined) return { text: `${rel} does not exist; create it with workspace_write.`, isError: true };
        let oldS = String(input.old_string);
        let newS = String(input.new_string);
        if (!oldS) return { text: "old_string is empty; use workspace_write to create or replace a whole file.", isError: true };
        if (oldS === newS) return { text: "old_string and new_string are the same; nothing to change.", isError: true };
        let count = before.split(oldS).length - 1;
        // Models write \n; a Windows checkout has CRLF. Match and replace in the file's own line endings.
        if (count === 0 && usesCrlf(before) && oldS.includes("\n")) {
          oldS = toCrlf(oldS);
          newS = toCrlf(newS);
          count = before.split(oldS).length - 1;
        }
        if (count === 0) return { text: `old_string was not found in ${rel}. Read the file and copy the text exactly, including indentation.`, isError: true };
        if (count > 1 && !input.replace_all) return { text: `old_string matches ${count} places in ${rel}. Add surrounding lines to make it unique, or set replace_all.`, isError: true };
        const after = input.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS);
        await writeFile(file, after, "utf8");
        const diff = lineDiff(before, after, rel);
        ctx.addEvidence({ kind: "file", label: `edited ${rel}`, content: truncate(diff, 6_000) });
        return { text: `Edited ${rel}${count > 1 ? ` (${count} replacements)` : ""}.\n${truncate(diff, 4_000)}` };
      }
      case "workspace_search": {
        let re: RegExp;
        try {
          re = new RegExp(String(input.pattern), input.ignore_case ? "i" : "");
        } catch (err) {
          return { text: `Invalid regular expression: ${String(err)}`, isError: true };
        }
        const base = String(input.path ?? "").replace(/\\/g, "/").replace(/^\.\/?/, "").replace(/\/$/, "");
        if (base) await this.resolve(base, root);
        const pattern = (base ? `${base}/` : "") + String(input.glob ?? "**/*");
        const max = Math.min(Math.max(Number(input.max) || 100, 1), 500);
        const hits: string[] = [];
        for (const rel of await this.files(root, pattern, 20_000)) {
          const full = path.join(root, rel);
          const info = await stat(full).catch(() => undefined);
          if (!info?.isFile() || info.size > 1_000_000) continue;
          const text = await readFile(full, "utf8").catch(() => "");
          if (text.includes("\u0000")) continue;
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && hits.length < max; i++) {
            if (re.test(lines[i]!)) hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 240)}`);
          }
          if (hits.length >= max) break;
        }
        return { text: hits.length ? hits.join("\n") + (hits.length >= max ? `\n…stopped at ${max} matches` : "") : "No matches." };
      }
      case "workspace_glob": {
        const found = await this.files(root, String(input.pattern), 1_000);
        return { text: found.length ? found.join("\n") + (found.length >= 1_000 ? "\n…first 1000 files" : "") : "No files match." };
      }
      case "workspace_diff": {
        const target = input.path ? ` -- "${String(input.path).replace(/"/g, "")}"` : "";
        const r = await this.run(`git status --short && git diff${target}`, { cwd: root, timeoutMs: 30_000 });
        if (r.code !== 0) return { text: `Not a git repository, or git failed: ${truncate(r.stderr, 1_000)}`, isError: true };
        return { text: truncate(r.stdout || "No uncommitted changes.", 30_000) };
      }
      case "workspace_run": {
        const command = String(input.command);
        const verdict = evaluateCommand(command, this.policy);
        if (verdict.decision === "deny") {
          ctx.addEvidence({ kind: "command", label: command, content: `refused by command policy: ${verdict.reason}` });
          return { text: `Refused by the command policy: ${verdict.reason}. This command never runs.`, isError: true };
        }
        const result = await this.run(command, { cwd: root });
        ctx.addEvidence({
          kind: "command",
          label: command,
          content: `exit ${result.code} · sandbox ${result.sandbox}\n${truncate(result.stdout + result.stderr, 4_000)}`,
        });
        return {
          text: `exit code: ${result.code}\n--- stdout ---\n${truncate(result.stdout, 12_000)}\n--- stderr ---\n${truncate(result.stderr, 6_000)}`,
          isError: result.code !== 0,
        };
      }
      default:
        throw new Error(`unknown workspace tool ${tool}`);
    }
  }

  /**
   * Run a command line in the workspace, through the sandbox. The command policy is not
   * consulted here: callers that take commands from a model go through `workspace_run`.
   */
  async run(
    command: string,
    opts: { cwd?: string; timeoutMs?: number; limits?: Partial<SandboxLimits>; passEnv?: string[] } = {},
  ): Promise<CommandResult> {
    const cwd = opts.cwd ?? this.root;
    const sandbox = await this.sandboxReady();
    let wrapped;
    try {
      wrapped = await sandbox.wrap(command, { cwd, limits: { ...this.opts.limits, ...opts.limits } });
    } catch (err) {
      return { code: 1, stdout: "", stderr: `[architect] sandbox refused the command: ${String(err)}`, sandbox: sandbox.name };
    }
    const timeoutMs = opts.timeoutMs ?? this.opts.commandTimeoutMs ?? 180_000;
    const env = { ...scrubEnv(process.env, [...(this.opts.passEnv ?? []), ...(opts.passEnv ?? [])]), ...wrapped.env };
    const result = await new Promise<CommandResult>((resolve) => {
      const child = spawn(wrapped.command, { cwd, shell: true, env });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        stderr += `\n[architect] command timed out after ${timeoutMs}ms`;
        child.kill();
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr, sandbox: sandbox.name });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr: String(err), sandbox: sandbox.name });
      });
    });
    wrapped.done();
    if (sandbox instanceof RuntimeSandbox) result.stderr = sandbox.annotate(command, result.stderr);
    if (!sandbox.isolating && sandbox.note && sandbox.note !== "sandboxing is off") {
      result.stderr = `[architect] ${sandbox.note}\n${result.stderr}`;
    }
    return result;
  }

  async dispose() {
    // The shared sandbox lives for the process; a sandbox passed in is the caller's to dispose.
  }
}

/** True when a file's line endings are CRLF (more \r\n than bare \n). */
export function usesCrlf(text: string): boolean {
  const crlf = text.split("\r\n").length - 1;
  return crlf > 0 && crlf >= text.split("\n").length - 1 - crlf;
}

/** Text with every line ending as CRLF. */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, "\r\n");
}
