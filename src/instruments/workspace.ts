import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
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
import type { Instrument, ToolContext, ToolOutput, ToolSpec } from "./types.js";

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
}

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

  /** Resolve a model-supplied path and refuse anything outside the workspace, including through a symlink. */
  async resolve(p: string): Promise<string> {
    const full = path.resolve(this.root, p || ".");
    const rel = path.relative(this.root, full);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      throw new Error(`path "${p}" is outside the workspace`);
    }
    const rootReal = await realpath(this.root);
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
    switch (tool) {
      case "workspace_list": {
        const dir = await this.resolve(String(input.path ?? "."));
        const entries = await readdir(dir, { withFileTypes: true });
        const lines = entries
          .filter((e) => e.name !== "node_modules" && e.name !== ".git")
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        return { text: lines.join("\n") || "(empty)" };
      }
      case "workspace_read": {
        const file = await this.resolve(String(input.path));
        const info = await stat(file);
        if (info.size > 2_000_000) return { text: "File is larger than 2 MB; read a smaller file.", isError: true };
        return { text: truncate(await readFile(file, "utf8"), 40_000) };
      }
      case "workspace_write": {
        const file = await this.resolve(String(input.path));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, String(input.content), "utf8");
        ctx.addEvidence({ kind: "file", label: "wrote", content: path.relative(this.root, file) });
        return { text: `Wrote ${path.relative(this.root, file)} (${String(input.content).length} chars).` };
      }
      case "workspace_run": {
        const command = String(input.command);
        const verdict = evaluateCommand(command, this.policy);
        if (verdict.decision === "deny") {
          ctx.addEvidence({ kind: "command", label: command, content: `refused by command policy: ${verdict.reason}` });
          return { text: `Refused by the command policy: ${verdict.reason}. This command never runs.`, isError: true };
        }
        const result = await this.run(command);
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
  async run(command: string, opts: { cwd?: string; timeoutMs?: number; limits?: Partial<SandboxLimits> } = {}): Promise<CommandResult> {
    const cwd = opts.cwd ?? this.root;
    const sandbox = await this.sandboxReady();
    let wrapped;
    try {
      wrapped = await sandbox.wrap(command, { cwd, limits: { ...this.opts.limits, ...opts.limits } });
    } catch (err) {
      return { code: 1, stdout: "", stderr: `[architect] sandbox refused the command: ${String(err)}`, sandbox: sandbox.name };
    }
    const timeoutMs = opts.timeoutMs ?? this.opts.commandTimeoutMs ?? 180_000;
    const env = { ...scrubEnv(process.env, this.opts.passEnv), ...wrapped.env };
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
