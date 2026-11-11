import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostRefusal, knowledgePrompt, parseGoal, planReview, relatedKnowledge, walkthrough } from "../src/agentic.js";
import { Architect } from "../src/architect.js";
import type { ScoreDraft } from "../src/brain.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import type { Instrument } from "../src/instruments/types.js";
import type { Run, Score } from "../src/types.js";
import { ScriptedBrain, toolUse } from "./helpers.js";

const score = (over: Partial<Score> = {}): Score => ({
  id: "score_1",
  goal: "Get a supplier quote for steel brackets",
  summary: "Ask the supplier for a quote",
  inputs: {},
  permissions: ["browser"],
  steps: [{ id: "s1", title: "Open the quote form", instruction: "Open it", instruments: ["browser"], checkpoint: false }],
  successCriteria: ["a quote number is recorded"],
  createdAt: "2026-11-08T00:00:00Z",
  ...over,
});

describe("slash commands", () => {
  it("sets review and autonomy and leaves the goal", () => {
    expect(parseGoal("/plan /autopilot book a room")).toEqual({ goal: "book a room", review: "request_review", autonomy: "autopilot" });
    expect(parseGoal("/fast check the weather")).toMatchObject({ goal: "check the weather", review: "always_proceed" });
    expect(parseGoal("/unknown keep me")).toEqual({ goal: "/unknown keep me" });
    expect(parseGoal("compare /plan prices")).toEqual({ goal: "compare /plan prices" });
  });
});

describe("plan review policy", () => {
  it("follows the policy, and Agent decides asks for risky or long plans", () => {
    expect(planReview(score(), "request_review", "accompaniment").required).toBe(true);
    expect(planReview(score({ permissions: ["shell"] }), "always_proceed", "accompaniment").required).toBe(false);
    expect(planReview(score(), "agent_decides", "accompaniment").required).toBe(false);
    expect(planReview(score({ permissions: ["browser", "http.write"] }), "agent_decides", "accompaniment")).toMatchObject({ required: true });
    expect(planReview(score({ permissions: ["shell"] }), "agent_decides", "rehearsal").required).toBe(false);
    const long = score({ steps: Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, title: "t", instruction: "i", instruments: [], checkpoint: false })) });
    expect(planReview(long, "agent_decides", "autopilot").required).toBe(true);
  });
});

describe("host lists", () => {
  it("blocks listed hosts and anything off the allow list", () => {
    expect(hostRefusal({ url: "https://ads.example.com/x" }, { block: ["example.com"] })).toMatch(/block list/);
    expect(hostRefusal({ url: "https://shop.acme.io/" }, { allow: ["acme.io"] })).toBeUndefined();
    expect(hostRefusal({ url: "https://evil.test/" }, { allow: ["acme.io"] })).toMatch(/allow list/);
    expect(hostRefusal({ url: "https://evil.test/" }, undefined)).toBeUndefined();
    expect(hostRefusal({ content: "see https://evil.test/" }, { allow: ["acme.io"] })).toBeUndefined();
    expect(hostRefusal({ endpoint: "https://evil.test/api" }, { allow: ["acme.io"] })).toMatch(/allow list/);
  });
});

const run = (over: Partial<Run>): Run => ({
  id: "run_a",
  score: score(),
  autonomy: "accompaniment",
  status: "succeeded",
  steps: [{ id: "s1", status: "done", summary: "Opened", attempts: 1 }],
  actions: [],
  evidence: [{ id: "ev_1", stepId: "s1", kind: "text", label: "Quote", content: "Q-123", at: "x" }],
  verdict: { passed: true, summary: "Quote Q-123 recorded", criteria: [{ criterion: "a quote number is recorded", met: true, evidence: "Q-123" }], at: "x" },
  usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, costUsd: 0.01 },
  createdAt: "x",
  updatedAt: "x",
  ...over,
});

describe("knowledge and walkthrough", () => {
  it("finds verified runs of similar goals only", () => {
    const items = relatedKnowledge("supplier quote for aluminium brackets", [run({}), run({ id: "run_b", status: "failed" })]);
    expect(items.map((k) => k.runId)).toEqual(["run_a"]);
    expect(knowledgePrompt(items)).toContain("Open the quote form");
    expect(relatedKnowledge("bake a cake", [run({})])).toEqual([]);
  });

  it("renders steps, evidence and the verdict", () => {
    const md = walkthrough(run({}));
    expect(md).toContain("- [x] **Open the quote form** (done) — Opened");
    expect(md).toContain("**Quote** (text): Q-123");
    expect(md).toContain("## Verification: passed");
  });
});

describe("Architect agent features", () => {
  let dir: string;
  let ws: WorkspaceInstrument;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "architect-ag-"));
    ws = new WorkspaceInstrument(path.join(dir, "ws"));
    await mkdir(ws.root, { recursive: true });
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const draft: ScoreDraft = {
    summary: "Write a file",
    permissions: ["workspace.read", "workspace.write", "shell"],
    startUrl: null,
    steps: [{ title: "Write", instruction: "Write a.txt", instruments: ["workspace"], checkpoint: false }],
    successCriteria: ["a.txt exists"],
  };

  it("holds a risky plan for review and delivers comments to the performer", async () => {
    const brain = new ScriptedBrain(draft, [
      (req) => {
        expect(JSON.stringify(req.messages.at(-1))).toContain("person_feedback");
        expect(JSON.stringify(req.messages.at(-1))).toContain("write it in capitals");
        return [toolUse("workspace_write", { path: "a.txt", content: "HI" })];
      },
      () => [toolUse("step_complete", { summary: "Wrote a.txt in capitals" })],
      () => [toolUse("submit_verdict", { passed: true, summary: "ok", criteria: [{ criterion: "a.txt exists", met: true, evidence: "HI" }] })],
    ]);
    const a = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
    const started = await a.start("write a file", { review: "agent_decides" });
    expect(started.planReview).toMatchObject({ required: true });
    expect(a.awaitingPlanReview(started)).toBe(true);
    await a.comment(started.id, "step:s1", "write it in capitals");
    await expect(a.comment(started.id, "step:nope", "x")).rejects.toThrow(/unknown comment target/);
    const approved = await a.approvePlan(started.id, "pat");
    expect(a.awaitingPlanReview(approved)).toBe(false);
    const done = await a.perform(approved);
    expect(done.status).toBe("succeeded");
    expect(done.comments?.[0]?.deliveredAt).toBeTruthy();
    expect((await a.knowledge("write a file please")).map((k) => k.runId)).toEqual([done.id]);
  });

  it("blocks tool calls to hosts outside the run's lists", async () => {
    const fetcher: Instrument = {
      name: "fetcher",
      description: "fetch",
      tools: [{ name: "fetch_url", description: "fetch", permission: "http.read", risk: "read", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } }],
      execute: async () => ({ text: "fetched" }),
    };
    const brain = new ScriptedBrain({ ...draft, permissions: ["http.read"], steps: [{ title: "Fetch", instruction: "Fetch", instruments: ["fetcher"], checkpoint: false }] }, [
      () => [toolUse("fetch_url", { url: "https://blocked.test/page" })],
      (req) => {
        expect(JSON.stringify(req.messages.at(-1))).toContain("block list");
        return [toolUse("step_failed", { reason: "host blocked" })];
      },
    ]);
    const a = new Architect({ brain, instruments: [fetcher], dataDir: path.join(dir, "data") });
    const r = await a.run("write a file", { hosts: { block: ["blocked.test"] }, review: "always_proceed" });
    expect(r.actions[0]?.outcome).toBe("blocked");
    expect(r.status).toBe("failed");
  });
});

describe("follow-ups in a session", () => {
  it("carries the earlier task, outcome and changed files after a marker", async () => {
    const { followUpGoal, FOLLOW_UP_MARK } = await import("../src/agentic.js");
    const parent = {
      id: "run_1", status: "succeeded", score: { goal: "Fix the login bug" }, error: undefined,
      verdict: { passed: true, summary: "login works", criteria: [], at: "" },
      steps: [{ id: "s1", status: "done", summary: "Patched auth.ts", attempts: 1 }],
      evidence: [{ id: "e1", stepId: "s1", kind: "file", label: "edited src/auth.ts", content: "+x", at: "" }],
    } as unknown as import("../src/types.js").Run;
    const goal = followUpGoal("Now add a test", parent);
    const [own, context] = goal.split(FOLLOW_UP_MARK);
    expect(own).toBe("Now add a test");
    expect(context).toContain("Task: Fix the login bug");
    expect(context).toContain("Outcome: succeeded (login works)");
    expect(context).toContain("Files changed: src/auth.ts");
    // A follow-up of a follow-up keeps only the first part of the earlier goal as its task.
    const again = followUpGoal("And docs", { ...parent, score: { goal } } as never);
    expect(again.split(FOLLOW_UP_MARK)[1]).toContain("Task: Now add a test");
  });
});
