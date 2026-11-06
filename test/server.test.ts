import { mkdtemp, rm, mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Architech } from "../src/architech.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import { createArchitechServer } from "../src/server.js";
import { ArchitechClient, ArchitechError } from "../src/sdk.js";
import { ScriptedBrain, toolUse } from "./helpers.js";

let dir: string;
let server: Server;
let client: ArchitechClient;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architech-server-"));
  const ws = new WorkspaceInstrument(path.join(dir, "ws"));
  await mkdir(ws.root, { recursive: true });
  const brain = new ScriptedBrain(
    {
      summary: "Write a release note",
      permissions: ["workspace.write", "workspace.read", "shell"],
      startUrl: null,
      steps: [{ title: "Publish note", instruction: "publish", instruments: ["workspace"], checkpoint: false }],
      successCriteria: ["note exists"],
    },
    [
      // Classified irreversible ("git push"), so it waits for an API approval; harmless when it runs.
      () => [toolUse("workspace_run", { command: 'node -e "process.exit(0)" -- git push' })],
      () => [toolUse("step_complete", { summary: "published" })],
      () => [toolUse("submit_verdict", { passed: true, summary: "ok", criteria: [{ criterion: "note exists", met: true, evidence: "x" }] })],
    ],
  );
  const architech = new Architech({ brain, instruments: [ws], dataDir: path.join(dir, "data"), approvalTimeoutMs: 20_000 });
  server = createArchitechServer({ architech, token: "secret" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  client = new ArchitechClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "secret" });
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("HTTP API + SDK", () => {
  it("rejects requests without the token", async () => {
    const anon = new ArchitechClient({ baseUrl: (client as unknown as { baseUrl: string }).baseUrl });
    await expect(anon.listRuns()).rejects.toBeInstanceOf(ArchitechError);
  });

  it("runs a Score, surfaces the approval, and finishes after it is approved", async () => {
    const run = await client.run({ goal: "Publish the release note", autonomy: "accompaniment" });
    expect(run.score.steps).toHaveLength(1);

    let approvals = await client.approvals();
    for (let i = 0; i < 50 && approvals.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      approvals = await client.approvals();
    }
    expect(approvals[0]?.tool).toBe("workspace_run");
    await client.decide(approvals[0]!.id, true, undefined, "test");

    const types: string[] = [];
    for await (const ev of client.events(run.id)) types.push(ev.type);
    expect(types).toContain("approval.decided");

    const done = await client.waitForRun(run.id, { intervalMs: 100, timeoutMs: 10_000 });
    expect(done.status).toBe("succeeded");
    expect(done.actions[0]?.approval?.approved).toBe(true);
  }, 30_000);

  it("accepts signals with no matching rule without starting a run", async () => {
    const res = await client.signal("spectre", "nothing_matches", { a: 1 });
    expect(res).toMatchObject({ accepted: true, started: false });
  });
});
