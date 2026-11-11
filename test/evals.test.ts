import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildProgram,
  execProgram,
  extractCode,
  fileSampler,
  formatReport,
  loadTasks,
  passAtK,
  runEval,
  type EvalTask,
} from "../src/evals/humaneval.js";
import { PassthroughSandbox, type CommandSandbox } from "../src/sandbox/runtime.js";

const SAMPLE = fileURLToPath(new URL("../evals/sample-tasks.jsonl", import.meta.url));

/** Marks itself isolating and checks the program text instead of running Python. */
function judgingSandbox(): CommandSandbox & { limits: unknown[] } {
  const limits: unknown[] = [];
  return {
    name: "fake",
    isolating: true,
    limits,
    async wrap(cmd, opts) {
      limits.push(opts.limits);
      const file = /'([^']+program\.py)'|"([^"]+program\.py)"|(\S+program\.py)/.exec(cmd)!;
      const text = await readFile(file[1] ?? file[2] ?? file[3]!, "utf8");
      const ok = text.includes("return max(low, min(value, high))");
      return { command: `node -e "process.exit(${ok ? 0 : 1})"`, done: () => {} };
    },
    async dispose() {},
  };
}

const hasPython = (() => {
  try {
    execFileSync(process.platform === "win32" ? "python" : "python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("pass@k", () => {
  it("matches the closed form 1 - C(n-c,k)/C(n,k)", () => {
    expect(passAtK(10, 0, 1)).toBe(0);
    expect(passAtK(10, 10, 1)).toBe(1);
    expect(passAtK(10, 3, 1)).toBeCloseTo(0.3, 10);
    // 1 - C(7,5)/C(10,5) = 1 - 21/252
    expect(passAtK(10, 3, 5)).toBeCloseTo(1 - 21 / 252, 10);
    expect(passAtK(5, 1, 5)).toBe(1);
    expect(() => passAtK(1, 0, 10)).toThrow(/at least 10/);
  });
});

describe("programs", () => {
  it("loads the sample tasks and builds prompt + completion + test + check()", async () => {
    const tasks = await loadTasks(SAMPLE);
    expect(tasks.map((t) => t.task_id)).toEqual(["architect/0", "architect/1", "architect/2"]);
    const program = buildProgram(tasks[0]!, "    return value\n");
    expect(program.startsWith(tasks[0]!.prompt)).toBe(true);
    expect(program.trimEnd().endsWith("check(clamp)")).toBe(true);
  });

  it("takes code out of a fenced reply", () => {
    expect(extractCode("Sure:\n```python\n    return 1\n```\nDone")).toBe("    return 1\n");
    expect(extractCode("    return 2")).toBe("    return 2\n");
  });
});

describe("sandboxed execution", () => {
  const task: EvalTask = {
    task_id: "t",
    entry_point: "clamp",
    prompt: "def clamp(value, low, high):\n",
    test: "def check(candidate):\n    assert candidate(5, 0, 3) == 3\n",
  };

  it("never runs model code without an isolating sandbox", async () => {
    const r = await execProgram(new PassthroughSandbox(), "import os\n");
    expect(r.passed).toBe(false);
    expect(r.result).toMatch(/isolating sandbox/);
    await expect(
      runEval({ tasks: [task], sampler: async () => "", sandbox: new PassthroughSandbox() }),
    ).rejects.toThrow(/isolating sandbox/);
  });

  it("runs with no network and writes only to its own folder", async () => {
    const sandbox = judgingSandbox();
    await execProgram(sandbox, "pass\n");
    const l = sandbox.limits[0] as { allowedDomains: string[]; allowWrite: string[] };
    expect(l.allowedDomains).toEqual([]);
    expect(l.allowWrite).toHaveLength(1);
    expect(l.allowWrite[0]).toMatch(/architect-eval-/);
  });

  it("scores samples and reports pass@k", async () => {
    const sampler = fileSampler([
      { task_id: "t", completion: "    return max(low, min(value, high))\n" },
      { task_id: "t", completion: "    return value\n" },
    ]);
    const report = await runEval({ tasks: [task], sampler, sandbox: judgingSandbox(), samplesPerTask: 2, ks: [1, 2] });
    expect(report.perTask[0]!.correct).toBe(1);
    expect(report.passAt["pass@1"]).toBeCloseTo(0.5);
    expect(report.passAt["pass@2"]).toBe(1);
    expect(formatReport(report)).toMatch(/pass@1 \| 50\.0%/);
  });

  it.skipIf(!hasPython)("runs real Python through an isolating sandbox", async () => {
    // A pass-through that claims isolation, only to exercise the real Python path in tests.
    const sandbox: CommandSandbox = { name: "test", isolating: true, wrap: async (command) => ({ command, done: () => {} }), dispose: async () => {} };
    const good = await execProgram(sandbox, buildProgram(task, "    return max(low, min(value, high))\n"));
    const bad = await execProgram(sandbox, buildProgram(task, "    return value\n"));
    const slow = await execProgram(sandbox, "while True:\n    pass\n", { timeoutMs: 1_000 });
    expect(good).toEqual({ passed: true, result: "passed" });
    expect(bad.passed).toBe(false);
    expect(bad.result).toMatch(/AssertionError/);
    expect(slow.result).toBe("timed out");
  }, 30_000); // three Python start-ups plus a 1 s timeout: more than vitest's 5 s default on Windows or a loaded runner
});
