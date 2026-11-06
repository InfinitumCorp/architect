import { mkdtemp, mkdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Conductor } from "../src/conductor.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import { createMcpServer } from "../src/mcp.js";
import { createConductorServer } from "../src/server.js";
import { CndctrClient } from "../src/sdk.js";
import { ScriptedBrain, toolUse } from "./helpers.js";

let dir: string;
let server: Server;
let human: CndctrClient;
let agent: Client;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cndctr-mcp-"));
  const ws = new WorkspaceInstrument(path.join(dir, "ws"));
  await mkdir(ws.root, { recursive: true });
  const brain = new ScriptedBrain(
    {
      summary: "Publish a release note",
      permissions: ["workspace.write", "workspace.read", "shell"],
      startUrl: null,
      steps: [{ title: "Publish note", instruction: "publish", instruments: ["workspace"], checkpoint: false }],
      successCriteria: ["note exists"],
    },
    [
      // Classified irreversible ("git push"), so it waits for a person; harmless when it runs.
      () => [toolUse("workspace_run", { command: 'node -e "process.exit(0)" -- git push' })],
      () => [toolUse("step_complete", { summary: "published" })],
      () => [toolUse("submit_verdict", { passed: true, summary: "ok", criteria: [{ criterion: "note exists", met: true, evidence: "x" }] })],
    ],
  );
  const conductor = new Conductor({ brain, instruments: [ws], dataDir: path.join(dir, "data"), approvalTimeoutMs: 20_000 });
  server = createConductorServer({ conductor, token: "secret" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  human = new CndctrClient({ baseUrl, token: "secret" });

  const mcp = createMcpServer({ client: new CndctrClient({ baseUrl, token: "secret" }), pollMs: 50 });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  agent = new Client({ name: "test-agent", version: "1.0.0" });
  await agent.connect(b);
});
afterAll(async () => {
  await agent.close();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const parse = (r: Awaited<ReturnType<Client["callTool"]>>) =>
  JSON.parse((r.content as Array<{ type: string; text: string }>)[0]!.text);

describe("MCP server", () => {
  it("exposes run tools and no way to approve", async () => {
    const { tools } = await agent.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["cndctr_run", "cndctr_get_run", "cndctr_list_runs", "cndctr_pending_approvals", "cndctr_recover", "cndctr_cancel"]),
    );
    expect(names.some((n) => /approve|decide/.test(n))).toBe(false);
  });

  it("starts a run, stops at the approval for a person, and reports the verified result", async () => {
    const started = parse(await agent.callTool({ name: "cndctr_run", arguments: { goal: "Publish the release note", wait: true, wait_seconds: 10 } }));
    expect(started.status, JSON.stringify(started)).toBe("awaiting_approval");
    expect(started.note).toMatch(/cannot approve/);

    const pending = parse(await agent.callTool({ name: "cndctr_pending_approvals", arguments: {} }));
    expect(pending[0].tool).toBe("workspace_run");

    // A person approves it outside MCP.
    await human.decide(pending[0].id, true, undefined, "test");

    const done = parse(await agent.callTool({ name: "cndctr_get_run", arguments: { run_id: started.id, wait: true, wait_seconds: 10 } }));
    expect(done.status).toBe("succeeded");
    expect(done.verdict.passed).toBe(true);
    expect(done.steps[0]).toMatchObject({ title: "Publish note", status: "done" });

    const list = parse(await agent.callTool({ name: "cndctr_list_runs", arguments: {} }));
    expect(list[0].id).toBe(started.id);
  }, 30_000);

  it("returns an error result for an unknown run", async () => {
    const r = await agent.callTool({ name: "cndctr_get_run", arguments: { run_id: "run_nope" } });
    expect(r.isError).toBe(true);
  });
});
