import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import type { ToolContext } from "../src/instruments/types.js";
import { PassthroughSandbox } from "../src/sandbox/runtime.js";
import { RunSupervisor, supervisorFromEnv, workspaceKey } from "../src/supervisor.js";

const ctxFor = (runId: string) =>
  ({ runId, stepId: "s", runDir: ".", putFile: async () => {}, addEvidence: () => ({}) }) as unknown as ToolContext;

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("run supervisor", () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("gives each run its own folder and keeps runs apart", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "architect-sup-"));
    const sup = new RunSupervisor({ baseDir: dir });
    const ws = new WorkspaceInstrument(path.join(dir, "shared"), { supervisor: sup, sandbox: new PassthroughSandbox() });

    await ws.execute("workspace_write", { path: "a.txt", content: "from run A" }, ctxFor("run_a"));
    await ws.execute("workspace_write", { path: "b.txt", content: "from run B" }, ctxFor("run_b"));

    expect(await readFile(path.join(dir, "runs", "run_a", "a.txt"), "utf8")).toBe("from run A");
    expect(await exists(path.join(dir, "runs", "run_a", "b.txt"))).toBe(false);
    const listing = await ws.execute("workspace_list", {}, ctxFor("run_b"));
    expect(listing.text).toBe("b.txt");
    await expect(ws.execute("workspace_read", { path: "../run_a/a.txt" }, ctxFor("run_b"))).rejects.toThrow(/outside the workspace/);

    const out = await ws.execute("workspace_run", { command: "node -p 'process.cwd()'" }, ctxFor("run_a"));
    expect(path.resolve(out.text.split("\n")[2]!.trim())).toBe(path.join(dir, "runs", "run_a"));
    expect(sup.active().map((l) => l.runId).sort()).toEqual(["run_a", "run_b"]);
  });

  it("keeps failed runs' folders, removes successful ones, and returns the same folder on recovery", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "architect-sup-"));
    const sup = new RunSupervisor({ baseDir: dir });
    const a = await sup.acquire("ok_run");
    const b = await sup.acquire("bad_run");
    await writeFile(path.join(b.root, "progress.txt"), "half done");

    await sup.release("ok_run", "succeeded");
    await sup.release("bad_run", "failed");
    expect(await exists(a.root)).toBe(false);
    expect(await exists(b.root)).toBe(true);
    expect(await readdir(path.join(dir, "leases"))).toEqual([]);

    const again = await sup.acquire("bad_run");
    expect(again.root).toBe(b.root);
    expect(await readFile(path.join(again.root, "progress.txt"), "utf8")).toBe("half done");
  });

  it("bounds how many runs hold a folder at once", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "architect-sup-"));
    const sup = new RunSupervisor({ baseDir: dir, maxConcurrent: 1, retain: "never" });
    await sup.acquire("first");
    let second = false;
    const p = sup.acquire("second").then(() => (second = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(second).toBe(false);
    await sup.release("first", "succeeded");
    await p;
    expect(second).toBe(true);
  });

  it("seeds new folders from a template, skipping node_modules and .git", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "architect-sup-"));
    const tpl = path.join(dir, "template");
    await mkdir(path.join(tpl, "node_modules", "x"), { recursive: true });
    await mkdir(path.join(tpl, "src"), { recursive: true });
    await writeFile(path.join(tpl, "src", "index.ts"), "export {}");
    const sup = new RunSupervisor({ baseDir: path.join(dir, "base"), seed: { kind: "copy", from: tpl } });
    const lease = await sup.acquire("seeded");
    expect(await readFile(path.join(lease.root, "src", "index.ts"), "utf8")).toBe("export {}");
    expect(await exists(path.join(lease.root, "node_modules"))).toBe(false);
  });

  it("reclaims leases left by a process that is gone", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "architect-sup-"));
    await mkdir(path.join(dir, "leases"), { recursive: true });
    await writeFile(
      path.join(dir, "leases", "old.json"),
      JSON.stringify({ runId: "old", root: path.join(dir, "runs", "old"), pid: 2 ** 22 + 12345, startedAt: "", seed: "empty" }),
    );
    const sup = new RunSupervisor({ baseDir: dir });
    expect(await sup.reclaimStale()).toEqual(["old"]);
  });

  it("refuses run ids that cannot name a folder, and reads settings from the environment", () => {
    expect(workspaceKey("run_abc123")).toBe("run_abc123");
    expect(workspaceKey("../../etc")).toBe("______etc");
    expect(() => workspaceKey("///")).toThrow();
    expect(supervisorFromEnv("/tmp/x", {})).toBeUndefined();
    expect(supervisorFromEnv("/tmp/x", { ARCHITECT_ISOLATION: "per-run", ARCHITECT_MAX_CONCURRENT_RUNS: "2" })?.maxConcurrent).toBe(2);
  });
});
