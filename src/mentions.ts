/**
 * Local-project helpers for the Podium composer, like Claude Code, Codex and Cursor:
 *   @-mentions  – find files to mention, and attach the mentioned files' contents to the request
 *   ! commands  – run one shell command in the project and show its output
 * Node only: the cloud Worker has no project folder (it works on GitHub repositories).
 */
import { exec } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Separates the person's words from the attached file contents in a goal. */
export const MENTION_MARK = "\n\n--- Files mentioned ---\n";

const SKIP = new Set([".git", "node_modules", ".architect", "dist", "build", ".next", ".turbo", ".cache", "coverage", "__pycache__", ".venv", "venv", "target"]);
const MAX_FILES = 20_000;
const PER_FILE = 20_000;
const TOTAL = 60_000;

let cache: { root: string; at: number; files: string[] } | undefined;

/** Every file under root (relative, forward slashes), skipping dependency and build folders. Cached for 10 s. */
export async function projectFiles(root: string): Promise<string[]> {
  if (cache && cache.root === root && Date.now() - cache.at < 10_000) return cache.files;
  const files: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    if (files.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(path.join(dir, e.name), r);
      } else if (e.isFile()) files.push(r);
    }
  };
  await walk(root, "");
  files.sort();
  cache = { root, at: Date.now(), files };
  return files;
}

/** Files matching what the person typed after @: the file name first, then anywhere in the path. */
export async function findFiles(root: string, query: string, limit = 30): Promise<string[]> {
  const files = await projectFiles(root);
  const q = query.toLowerCase().replace(/\\/g, "/");
  if (!q) return files.slice(0, limit);
  const scored: Array<[number, string]> = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    const score = base.startsWith(q) ? 0 : base.includes(q) ? 1 : lower.startsWith(q) ? 2 : lower.includes(q) ? 3 : -1;
    if (score >= 0) scored.push([score * 1000 + f.length, f]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, f]) => f);
}

/** The @path mentions in a goal (paths without spaces, as the composer inserts them). */
export function mentionedPaths(goal: string): string[] {
  const out = new Set<string>();
  for (const m of goal.matchAll(/(?:^|\s)@([\w./-]+[\w/-])/g)) out.add(m[1]!.replace(/^\.\//, ""));
  return [...out];
}

/** The file inside root, or undefined when the path escapes it. */
function inside(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? abs : undefined;
}

/** Append the contents of the files the goal @-mentions (text files, size-capped). Unknown paths are left as written. */
export async function expandMentions(goal: string, root: string): Promise<string> {
  const parts: string[] = [];
  let total = 0;
  for (const rel of mentionedPaths(goal)) {
    const abs = inside(root, rel);
    if (!abs) continue;
    const info = await stat(abs).catch(() => undefined);
    if (!info) continue;
    if (info.isDirectory()) {
      const files = (await projectFiles(root)).filter((f) => f.startsWith(`${rel.replace(/\/$/, "")}/`));
      parts.push(`@${rel} (folder):\n${files.slice(0, 200).join("\n")}${files.length > 200 ? `\n… ${files.length - 200} more` : ""}`);
      continue;
    }
    const buf = await readFile(abs).catch(() => undefined);
    if (!buf || buf.includes(0)) continue; // missing or binary
    const room = Math.min(PER_FILE, TOTAL - total);
    if (room <= 0) break;
    const text = buf.toString("utf8");
    const clipped = text.length > room ? `${text.slice(0, room)}\n… (${text.length - room} more characters)` : text;
    total += clipped.length;
    parts.push(`@${rel}:\n\`\`\`\n${clipped}\n\`\`\``);
  }
  return parts.length ? `${goal}${MENTION_MARK}${parts.join("\n\n")}` : goal;
}

export interface ShellResult {
  command: string;
  code: number | null;
  output: string;
  timedOut: boolean;
  ms: number;
}

/** Run one shell command in the project folder, like `!` in Claude Code. Output is capped. */
export function runShell(command: string, cwd: string, timeoutMs = 120_000): Promise<ShellResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 4_000_000, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: number | string; killed?: boolean; signal?: string }) | null;
      let output = `${stdout}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
      if (output.length > 100_000) output = `… (${output.length - 100_000} earlier characters)\n${output.slice(-100_000)}`;
      resolve({
        command,
        code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
        output,
        timedOut: Boolean(e?.killed && e.signal),
        ms: Date.now() - started,
      });
    });
  });
}
