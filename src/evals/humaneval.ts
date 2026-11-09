/**
 * Code-writing evals in the HumanEval format (openai/human-eval, MIT), reported the way
 * openai/simple-evals (MIT) reports them. Written for Architect; no code or data was copied.
 *
 * A task is one JSON line: { task_id, prompt, test, entry_point }. The model completes `prompt`;
 * the program `prompt + completion + test + check(entry_point)` passes when it exits with 0.
 *
 * Model-written code is untrusted. It only ever runs inside an isolating sandbox with no
 * network, writing only to its own temporary folder; with no such sandbox, nothing runs.
 * Datasets are not shipped (the openai/evals datasets are CC-BY-SA or GFDL). Bring a
 * HumanEval-format file, or use the small original sample in evals/sample-tasks.jsonl.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Brain } from "../brain.js";
import type { CommandSandbox } from "../sandbox/runtime.js";
import { scrubEnv, shellQuote } from "../sandbox/runtime.js";

export const EvalTaskSchema = z.object({
  task_id: z.string().min(1),
  prompt: z.string(),
  test: z.string(),
  entry_point: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "entry_point must be a Python identifier"),
});
export type EvalTask = z.infer<typeof EvalTaskSchema>;

/** Completions supplied ahead of time: { task_id, completion } per line. */
export const CompletionSchema = z.object({ task_id: z.string(), completion: z.string() });

export async function readJsonl<T>(file: string, schema: z.ZodType<T>): Promise<T[]> {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  const out: T[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${path.basename(file)} line ${i + 1}`;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(`${where}: not valid JSON (${err instanceof Error ? err.message : err})`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error(`${where}: ${parsed.error.issues[0]?.message}`);
    out.push(parsed.data);
  });
  return out;
}

export const loadTasks = (file: string) => readJsonl(file, EvalTaskSchema);

/**
 * Unbiased pass@k for one task: the chance that at least one of k samples, drawn from n with c
 * correct, passes. 1 - C(n-c, k) / C(n, k), computed as a product to stay stable.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass@${k} needs at least ${k} samples, got ${n}`);
  if (n - c < k) return 1;
  let fail = 1;
  for (let i = n - c + 1; i <= n; i++) fail *= 1 - k / i;
  return 1 - fail;
}

/** Take the code out of a model reply: the first fenced block if there is one, else the text. */
export function extractCode(reply: string): string {
  const fence = /```(?:python|py)?[^\n]*\n([\s\S]*?)```/i.exec(reply);
  return (fence ? fence[1]! : reply).replace(/\s+$/, "") + "\n";
}

export function buildProgram(task: EvalTask, completion: string): string {
  return `${task.prompt}${completion}\n\n${task.test}\n\ncheck(${task.entry_point})\n`;
}

export interface ExecResult {
  passed: boolean;
  /** "passed", "failed: <last error line>", "timed out", or why it did not run. */
  result: string;
}

export interface ExecOptions {
  timeoutMs?: number;
  /** Python interpreter. Default ARCHITECT_EVAL_PYTHON, then "python3" (or "python" on Windows). */
  python?: string;
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Run one program inside the sandbox. Refuses to run anything without an isolating sandbox. */
export async function execProgram(sandbox: CommandSandbox, program: string, opts: ExecOptions = {}): Promise<ExecResult> {
  if (!sandbox.isolating) {
    return { passed: false, result: `not run: model-written code needs an isolating sandbox (${sandbox.note ?? sandbox.name})` };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "architect-eval-"));
  try {
    const file = path.join(dir, "program.py");
    await writeFile(file, program, "utf8");
    const python = opts.python ?? process.env.ARCHITECT_EVAL_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const wrapped = await sandbox.wrap(`${python} -I -B ${shellQuote(file)}`, {
      cwd: dir,
      limits: { allowWrite: [dir], allowedDomains: [] },
    });
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const { code, stderr, timedOut } = await new Promise<{ code: number; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn(wrapped.command, {
        cwd: dir,
        shell: true,
        env: { ...scrubEnv(process.env), ...wrapped.env },
        // Own process group on POSIX, so a timeout kills the program and anything it started.
        detached: process.platform !== "win32",
      });
      let stderr = "";
      let settled = false;
      const finish = (r: { code: number; stderr: string; timedOut: boolean }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        killTree(child.pid);
        finish({ code: 1, stderr, timedOut: true });
      }, timeoutMs);
      child.stdout.resume();
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4_000)));
      child.on("close", (c) => finish({ code: c ?? 1, stderr, timedOut: false }));
      child.on("error", (err) => finish({ code: 1, stderr: String(err), timedOut: false }));
    });
    wrapped.done();
    if (timedOut) return { passed: false, result: "timed out" };
    if (code === 0) return { passed: true, result: "passed" };
    const last = stderr.trim().split(/\r?\n/).pop() ?? `exit ${code}`;
    return { passed: false, result: `failed: ${last}` };
  } finally {
    // A killed program may still hold the folder open for a moment on Windows.
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

/** Produces one completion for a task. */
export type Sampler = (task: EvalTask, sample: number) => Promise<string>;

const SYSTEM =
  "Complete the Python function. Reply with only the code that continues the given prompt (the function body), in one ```python block. No explanations.";

/** A sampler that asks an Architect brain, with no tools. */
export function brainSampler(brain: Brain): Sampler {
  return async (task) => {
    const res = await brain.turn({ system: SYSTEM, messages: [{ role: "user", content: task.prompt }], tools: [] });
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return extractCode(text);
  };
}

/** A sampler that replays completions from a file (for scoring outputs produced elsewhere). */
export function fileSampler(completions: { task_id: string; completion: string }[]): Sampler {
  const byTask = new Map<string, string[]>();
  for (const c of completions) byTask.set(c.task_id, [...(byTask.get(c.task_id) ?? []), c.completion]);
  return async (task, sample) => {
    const list = byTask.get(task.task_id);
    if (!list?.length) throw new Error(`no completion for ${task.task_id}`);
    return list[sample % list.length]!;
  };
}

export interface TaskReport {
  task_id: string;
  samples: { passed: boolean; result: string }[];
  correct: number;
}

export interface EvalReport {
  model: string;
  tasks: number;
  samplesPerTask: number;
  /** pass@k averaged over tasks, for each k <= samplesPerTask. */
  passAt: Record<string, number>;
  sandbox: string;
  perTask: TaskReport[];
}

export interface RunEvalOptions extends ExecOptions {
  tasks: EvalTask[];
  sampler: Sampler;
  sandbox: CommandSandbox;
  samplesPerTask?: number;
  ks?: number[];
  model?: string;
  onTask?(r: TaskReport): void;
}

export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  if (!opts.sandbox.isolating) {
    throw new Error(`refusing to run model-written code without an isolating sandbox (${opts.sandbox.note ?? opts.sandbox.name}); see docs/evals.md`);
  }
  const n = opts.samplesPerTask ?? 1;
  const ks = (opts.ks ?? [1, 10, 100]).filter((k) => k <= n);
  const perTask: TaskReport[] = [];
  for (const task of opts.tasks) {
    const samples: TaskReport["samples"] = [];
    for (let s = 0; s < n; s++) {
      let completion: string;
      try {
        completion = await opts.sampler(task, s);
      } catch (err) {
        samples.push({ passed: false, result: `no completion: ${err instanceof Error ? err.message : err}` });
        continue;
      }
      samples.push(await execProgram(opts.sandbox, buildProgram(task, completion), opts));
    }
    const report = { task_id: task.task_id, samples, correct: samples.filter((x) => x.passed).length };
    perTask.push(report);
    opts.onTask?.(report);
  }
  const passAt: Record<string, number> = {};
  for (const k of ks) {
    const total = perTask.reduce((sum, t) => sum + passAtK(n, t.correct, k), 0);
    passAt[`pass@${k}`] = perTask.length ? total / perTask.length : 0;
  }
  return { model: opts.model ?? "unknown", tasks: perTask.length, samplesPerTask: n, passAt, sandbox: opts.sandbox.name, perTask };
}

/** A short Markdown report, one metric per line, then the tasks that failed. */
export function formatReport(r: EvalReport): string {
  const lines = [
    `# Eval: ${r.model}`,
    "",
    `${r.tasks} tasks · ${r.samplesPerTask} sample(s) each · sandbox ${r.sandbox}`,
    "",
    "| Metric | Score |",
    "|---|---|",
    ...Object.entries(r.passAt).map(([k, v]) => `| ${k} | ${(v * 100).toFixed(1)}% |`),
  ];
  const failed = r.perTask.filter((t) => t.correct < t.samples.length);
  if (failed.length) {
    lines.push("", "## Failures", "");
    for (const t of failed) {
      const why = t.samples.find((s) => !s.passed)?.result ?? "";
      lines.push(`- ${t.task_id}: ${t.correct}/${t.samples.length} passed. ${why}`);
    }
  }
  return lines.join("\n");
}
