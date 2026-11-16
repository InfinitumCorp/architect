import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Architect } from "../src/architect.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import type { ScoreDraft } from "../src/brain.js";
import { ScriptedBrain, text, toolUse } from "./helpers.js";

const draft = (overrides: Partial<ScoreDraft> = {}): ScoreDraft => ({
  summary: "Write a greeting file and prove it exists",
  permissions: ["workspace.read", "workspace.write", "shell"],
  startUrl: null,
  steps: [{ title: "Write greeting", instruction: "Write hello.txt containing {{greeting}}", instruments: ["workspace"], checkpoint: false }],
  successCriteria: ["hello.txt contains the greeting"],
  ...overrides,
});

let dir: string;
let ws: WorkspaceInstrument;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architect-"));
  ws = new WorkspaceInstrument(path.join(dir, "ws"));
  await import("node:fs/promises").then((fs) => fs.mkdir(ws.root, { recursive: true }));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("Architect end to end", () => {
  it("composes, performs, verifies and records evidence", async () => {
    const brain = new ScriptedBrain(draft(), [
      (req) => {
        // The step instruction is interpolated with inputs.
        expect(JSON.stringify(req.messages[0])).toContain("Write hello.txt containing hi there");
        return [text("Writing the file."), toolUse("workspace_write", { path: "hello.txt", content: "hi there" })];
      },
      (req) => {
        const last = JSON.stringify(req.messages.at(-1));
        expect(last).toContain('trust=\\"untrusted\\"');
        return [toolUse("step_complete", { summary: "Wrote hello.txt" })];
      },
      // verification: read-only tools only
      (req) => {
        const names = req.tools.map((t) => t.name);
        expect(names).toContain("workspace_read");
        expect(names).not.toContain("workspace_write");
        expect(names).not.toContain("workspace_run");
        return [toolUse("workspace_read", { path: "hello.txt" })];
      },
      () => [
        toolUse("submit_verdict", {
          passed: true,
          summary: "File present with greeting",
          criteria: [{ criterion: "hello.txt contains the greeting", met: true, evidence: "read: hi there" }],
        }),
      ],
    ]);
    const architect = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
    const events: string[] = [];
    architect.on("event", (e) => events.push(e.type));

    const run = await architect.run("Greet", { inputs: { greeting: "hi there" }, autonomy: "accompaniment" });

    expect(run.status).toBe("succeeded");
    expect(run.verdict?.passed).toBe(true);
    expect(await readFile(path.join(ws.root, "hello.txt"), "utf8")).toBe("hi there");
    expect(run.actions.map((a) => `${a.tool}:${a.outcome}`)).toEqual(["workspace_write:executed", "workspace_read:executed"]);
    expect(run.evidence.some((e) => e.kind === "file")).toBe(true);
    expect(events).toContain("run.verified");
    const stored = await architect.store.load(run.id);
    expect(stored.status).toBe("succeeded");
  });

  it("rehearsal drafts writes without executing them", async () => {
    const brain = new ScriptedBrain(draft(), [
      () => [toolUse("workspace_write", { path: "hello.txt", content: "x" })],
      () => [toolUse("step_complete", { summary: "Would write hello.txt" })],
    ]);
    const architect = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
    const run = await architect.run("Greet", { autonomy: "rehearsal" });
    expect(run.status).toBe("rehearsed");
    expect(run.actions[0]?.outcome).toBe("simulated");
    expect(existsSync(path.join(ws.root, "hello.txt"))).toBe(false);
  });

  it("asks before irreversible actions and respects a decline", async () => {
    const asked: string[] = [];
    const brain = new ScriptedBrain(draft(), [
      () => [toolUse("workspace_run", { command: "git push origin main" })],
      (req) => {
        expect(JSON.stringify(req.messages.at(-1))).toContain("declined");
        return [toolUse("step_failed", { reason: "push was declined" })];
      },
    ]);
    const architect = new Architect({
      brain,
      instruments: [ws],
      dataDir: path.join(dir, "data"),
      approvalHandler: async (req) => {
        asked.push(`${req.tool}:${req.risk}`);
        return { approved: false, note: "not today" };
      },
    });
    const run = await architect.run("Ship it");
    expect(asked).toEqual(["workspace_run:irreversible"]);
    expect(run.actions[0]?.outcome).toBe("denied");
    expect(run.status).toBe("failed");
  });

  it("never expands permissions beyond the account ceiling or the Score", async () => {
    const brain = new ScriptedBrain(draft({ permissions: ["workspace.read", "shell", "standing.irreversible"] }), [
      (req) => {
        expect(req.tools.map((t) => t.name)).not.toContain("workspace_write");
        // A tool the model invents or was not offered is blocked, not run.
        return [toolUse("workspace_write", { path: "x.txt", content: "pwned" })];
      },
      () => [toolUse("step_failed", { reason: "cannot write" })],
    ]);
    const architect = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
    const run = await architect.run("Try to write", { autonomy: "autopilot" });
    // standing.irreversible is outside the default ceiling, so it is dropped at compose time.
    expect(run.score.permissions).toEqual(["workspace.read", "shell"]);
    expect(run.actions[0]?.outcome).toBe("blocked");
    expect(existsSync(path.join(ws.root, "x.txt"))).toBe(false);
  });

  it("lets a plan that writes or runs commands read the workspace too", async () => {
    const brain = new ScriptedBrain(draft({ permissions: ["workspace.write", "shell"] }), [
      (req) => {
        expect(req.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["workspace_read", "workspace_glob", "workspace_write"]));
        return [toolUse("workspace_write", { path: "hello.txt", content: "hi" })];
      },
      () => [toolUse("workspace_read", { path: "hello.txt" })],
      () => [toolUse("step_complete", { summary: "wrote and read hello.txt" })],
    ]);
    const architect = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
    const run = await architect.run("Write and check", { autonomy: "autopilot" });
    expect(run.score.permissions).toEqual(["workspace.read", "workspace.write", "shell"]);
    expect(run.actions.map((a) => a.outcome)).toEqual(["executed", "executed"]);
  });

  it("recovers a failed run without repeating completed steps, and hands off when asked", async () => {
    const twoSteps = draft({
      steps: [
        { title: "A", instruction: "write a.txt", instruments: ["workspace"], checkpoint: false },
        { title: "B", instruction: "write b.txt", instruments: ["workspace"], checkpoint: false },
      ],
    });
    const script = [
      () => [toolUse("workspace_write", { path: "a.txt", content: "a" })],
      () => [toolUse("step_complete", { summary: "a done" })],
      () => [toolUse("request_handoff", { reason: "needs sign-in", instructions_for_person: "Sign in, then recover" })],
    ];
    const brain = new ScriptedBrain(twoSteps, script);
    const architect = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
    const first = await architect.run("Two files");
    expect(first.status).toBe("handed_off");
    expect(existsSync(path.join(architect.store.runDir(first.id), "handoff", "HANDOFF.md"))).toBe(true);

    const brain2 = new ScriptedBrain(twoSteps, [
      (req) => {
        expect(JSON.stringify(req.messages[0])).toContain("Perform step s2");
        return [toolUse("workspace_write", { path: "b.txt", content: "b" })];
      },
      () => [toolUse("step_complete", { summary: "b done" })],
      () => [toolUse("submit_verdict", { passed: true, summary: "ok", criteria: [{ criterion: "c", met: true, evidence: "e" }] })],
    ]);
    const architect2 = new Architect({ brain: brain2, instruments: [ws], dataDir: path.join(dir, "data") });
    const recovered = await architect2.recover(first.id);
    expect(recovered.status).toBe("succeeded");
    expect(recovered.steps.map((s) => s.status)).toEqual(["done", "done"]);
  });
});
