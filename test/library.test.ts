import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Architech } from "../src/architech.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import { ScoreLibrary, digestOf } from "../src/library.js";
import { ScheduleStore, Scheduler, isDue, validateSchedule } from "../src/schedules.js";
import { costOf, estimateCost } from "../src/usage.js";
import type { ScoreDraft } from "../src/brain.js";
import { ScriptedBrain, toolUse } from "./helpers.js";

const draft: ScoreDraft = {
  summary: "Write a report for a supplier",
  permissions: ["workspace.read", "workspace.write"],
  startUrl: null,
  steps: [{ title: "Write", instruction: "Write report-{{supplier}}.txt for {{supplier}}", instruments: ["workspace"], checkpoint: false }],
  successCriteria: ["report exists"],
};
const writeAndVerify = (file: string) => [
  () => [toolUse("workspace_write", { path: file, content: "ok" })],
  () => [toolUse("step_complete", { summary: "written" })],
  () => [toolUse("submit_verdict", { passed: true, summary: "ok", criteria: [{ criterion: "report exists", met: true, evidence: file }] })],
];

let dir: string;
let ws: WorkspaceInstrument;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architech-lib-"));
  ws = new WorkspaceInstrument(path.join(dir, "ws"));
  await mkdir(ws.root, { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("usage and spending limits", () => {
  it("prices tokens and estimates a range", () => {
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, "claude-opus-5-5")).toBe(4);
    expect(costOf({ inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, "claude-opus-5-5")).toBe(20);
    const est = estimateCost({ ...draft, id: "s", goal: "g", inputs: {}, createdAt: "", steps: draft.steps.map((s, i) => ({ ...s, id: `s${i}` })) } as never, "claude-opus-5-5");
    expect(est.lowUsd).toBeGreaterThan(0);
    expect(est.highUsd).toBeGreaterThan(est.lowUsd);
  });

  it("tracks cost and hands off when the limit is reached, then recovers with a higher limit", async () => {
    // Each turn: 10k input + 1k output on Opus 5.5 = $0.06. Compose: $0.018.
    const brain = new ScriptedBrain(draft, [
      () => [toolUse("workspace_list", {})],
      () => [toolUse("workspace_list", {})],
      () => [toolUse("workspace_list", {})],
    ]);
    const architech = new Architech({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
    const run = await architech.run("Report", { inputs: { supplier: "acme" }, budgetUsd: 0.1 });
    expect(run.status).toBe("handed_off");
    expect(run.usage.calls).toBe(3); // compose + 2 turns, then the limit stops the third
    expect(run.usage.costUsd).toBeCloseTo(0.138, 3);
    const handoff = await readFile(path.join(architech.store.runDir(run.id), "handoff", "HANDOFF.md"), "utf8");
    expect(handoff).toMatch(/Spending limit reached/);

    const brain2 = new ScriptedBrain(draft, writeAndVerify("report-acme.txt"));
    const c2 = new Architech({ brain: brain2, instruments: [ws], dataDir: path.join(dir, "data") });
    const recovered = await c2.recover(run.id, { budgetUsd: 5 });
    expect(recovered.status).toBe("succeeded");
    expect(recovered.usage.costUsd).toBeGreaterThan(run.usage.costUsd);
  });
});

describe("Score library", () => {
  it("saves a run's Score, finds its inputs, and plays it with new inputs", async () => {
    const architech = new Architech({ brain: new ScriptedBrain(draft, writeAndVerify("report-acme.txt")), instruments: [ws], dataDir: path.join(dir, "data") });
    const first = await architech.run("Report", { inputs: { supplier: "acme" } });
    expect(first.status).toBe("succeeded");

    const lib = new ScoreLibrary(path.join(dir, "data", "scores"));
    const saved = await lib.save("supplier-report", first.score);
    expect(saved.inputs).toEqual(["supplier"]);
    expect((await lib.list()).map((s) => s.name)).toEqual(["supplier-report"]);

    const c2 = new Architech({ brain: new ScriptedBrain(draft, writeAndVerify("report-globex.txt")), instruments: [ws], dataDir: path.join(dir, "data") });
    const run = await c2.prepare((await lib.get("supplier-report")).score, { inputs: { supplier: "globex" }, source: "score:supplier-report" });
    const played = await c2.perform(run);
    expect(played.status).toBe("succeeded");
    expect(played.source).toBe("score:supplier-report");
    expect(existsSync(path.join(ws.root, "report-globex.txt"))).toBe(true);
  });

  it("rejects tampered Marketplace packages and clamps permissions when played", async () => {
    const lib = new ScoreLibrary(path.join(dir, "scores"));
    const score = {
      id: "score_x",
      goal: "g",
      summary: "s",
      inputs: {},
      permissions: ["workspace.read", "standing.irreversible"] as const,
      steps: [{ id: "s1", title: "t", instruction: "i", instruments: ["workspace", "nuclear-launcher"], checkpoint: false }],
      successCriteria: ["c"],
      createdAt: "",
    };
    const pkg = { name: "shared-score", description: "d", score, digest: digestOf(score as never) };
    await expect(lib.import({ ...pkg, score: { ...score, goal: "something else" } })).rejects.toThrow(/digest/);
    await expect(lib.import({ ...pkg, name: "../escape" })).rejects.toThrow();
    const installed = await lib.import(pkg);

    const architech = new Architech({ brain: new ScriptedBrain(draft, []), instruments: [ws], dataDir: path.join(dir, "data") });
    const run = await architech.prepare(installed.score, { autonomy: "autopilot" });
    expect(run.score.permissions).toEqual(["workspace.read"]);
    expect(run.score.steps[0]!.instruments).toEqual(["workspace"]);
  });
});

describe("Autopilot schedules", () => {
  it("validates schedules", () => {
    expect(() => validateSchedule({ name: "x", score: "y" })).toThrow(/exactly one/);
    expect(() => validateSchedule({ name: "x", score: "y", everyMinutes: 1 })).toThrow(/at least 5/);
    expect(() => validateSchedule({ name: "x", score: "y", dailyAt: "25:00" })).toThrow(/HH:MM/);
    expect(validateSchedule({ name: "x", score: "y", everyMinutes: 60 }).autonomy).toBe("autopilot");
  });

  it("computes due times", () => {
    const at = new Date("2026-11-06T10:00:00");
    const every = validateSchedule({ name: "a", score: "s", everyMinutes: 60 });
    expect(isDue(every, at)).toBe(true);
    expect(isDue({ ...every, lastRunAt: new Date("2026-11-06T09:30:00").toISOString() }, at)).toBe(false);
    expect(isDue({ ...every, lastRunAt: new Date("2026-11-06T08:59:00").toISOString() }, at)).toBe(true);
    const daily = validateSchedule({ name: "b", score: "s", dailyAt: "09:00" });
    expect(isDue(daily, at)).toBe(true);
    expect(isDue({ ...daily, lastRunAt: new Date("2026-11-06T09:00:05").toISOString() }, at)).toBe(false);
    expect(isDue(daily, new Date("2026-11-06T08:00:00"))).toBe(false);
    expect(isDue({ ...every, enabled: false }, at)).toBe(false);
  });

  it("starts due schedules from saved Scores and records the run", async () => {
    const dataDir = path.join(dir, "data");
    const lib = new ScoreLibrary(path.join(dataDir, "scores"));
    const store = new ScheduleStore(dataDir);
    const architech = new Architech({ brain: new ScriptedBrain(draft, writeAndVerify("report-nightly.txt")), instruments: [ws], dataDir });
    await lib.save("supplier-report", {
      ...draft,
      id: "score_1",
      goal: "Report",
      inputs: {},
      createdAt: "",
      steps: draft.steps.map((s, i) => ({ ...s, id: `s${i + 1}` })),
    });
    await store.upsert(validateSchedule({ name: "nightly", score: "supplier-report", everyMinutes: 60, inputs: { supplier: "nightly" }, budgetUsd: 2 }));

    const scheduler = new Scheduler(architech, lib, store, () => {});
    const [runId] = await scheduler.tick();
    expect(runId).toBeDefined();
    expect(await scheduler.tick()).toEqual([]); // not due again for an hour

    for (let i = 0; i < 50 && architech.isActive(runId!); i++) await new Promise((r) => setTimeout(r, 20));
    const run = await architech.store.load(runId!);
    expect(run.status).toBe("succeeded");
    expect(run.autonomy).toBe("autopilot");
    expect(run.budgetUsd).toBe(2);
    expect(run.source).toBe("schedule:nightly");
    expect((await store.list())[0]!.lastRunId).toBe(runId);
  });
});
