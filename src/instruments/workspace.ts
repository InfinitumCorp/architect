import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyCommand, truncate } from "../policy.js";
import type { Instrument, ToolContext, ToolOutput, ToolSpec } from "./types.js";

/**
 * Files and commands, confined to one workspace directory.
 * This is how Architect builds things: write code, run the build and tests, read the output.
 */
export class WorkspaceInstrument implements Instrument {
  name = "workspace";
  description =
    "A project folder on disk. List, read and write files, and run shell commands (build, test, git) inside it.";
  readonly root: string;

  constructor(root: string, private opts: { commandTimeoutMs?: number } = {}) {
    this.root = path.resolve(root);
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
        "Run a shell command with the workspace as the working directory. Returns exit code, stdout and stderr. Use for installs, builds, tests and git.",
      input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      permission: "shell",
      risk: (input) => classifyCommand(String(input.command)),
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
        const result = await this.run(command);
        ctx.addEvidence({
          kind: "command",
          label: command,
          content: `exit ${result.code}\n${truncate(result.stdout + result.stderr, 4_000)}`,
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

  private run(command: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(command, { cwd: this.root, shell: true, env: process.env });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        stderr += `\n[architct] command timed out after ${this.opts.commandTimeoutMs ?? 180_000}ms`;
        child.kill();
      }, this.opts.commandTimeoutMs ?? 180_000);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: 1, stdout, stderr: String(err) });
      });
    });
  }
}
