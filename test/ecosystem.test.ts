import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionHandler } from "../src/adapter.js";
import { Architect } from "../src/architct.js";
import { EcosystemInstrument } from "../src/instruments/ecosystem.js";
import { ScriptedBrain, toolUse } from "./helpers.js";

let server: Server;
let base: string;
let dir: string;
const drafts: unknown[] = [];
const attestations: unknown[] = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architct-eco-"));
  const spectre = createActionHandler({
    token: "spectre-token",
    actions: {
      find_account: { description: "find", risk: "read", run: ({ query }) => ({ name: String(query), owner: "dana@acme.example" }) },
      draft_followup: { description: "draft", risk: "write", run: (p) => (drafts.push(p), { draftId: drafts.length }) },
    },
  });
  const firmament = createActionHandler({
    basePath: "/firmament/architct/v1",
    actions: { attest: { description: "attest", risk: "write", run: (p) => (attestations.push(p), { tx: "0xabc" }) } },
  });
  server = createServer(async (req, res) => {
    if (await spectre(req, res)) return;
    if (await firmament(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("ecosystem: adapter + instrument + attestation", () => {
  it("rejects a missing token and lists actions with one", async () => {
    expect((await fetch(`${base}/architct/v1/actions`)).status).toBe(401);
    const eco = new EcosystemInstrument([{ key: "spectre", baseUrl: base, token: "spectre-token" }]);
    const out = await eco.execute("ecosystem_actions", { product: "spectre" }, { runId: "run_x" });
    expect(out.text).toContain("draft_followup");
  });

  it("performs a Score through Spectre and attests the verified outcome on Firmament", async () => {
    const eco = new EcosystemInstrument([
      { key: "spectre", baseUrl: base, token: "spectre-token" },
      { key: "firmament", baseUrl: `${base}/firmament` },
    ]);
    const brain = new ScriptedBrain(
      {
        summary: "Draft a renewal follow-up",
        permissions: ["ecosystem"],
        startUrl: null,
        steps: [{ title: "Draft", instruction: "Find Acme and draft a follow-up", instruments: ["ecosystem"], checkpoint: false }],
        successCriteria: ["a draft exists for the owner"],
      },
      [
        () => [toolUse("ecosystem_call", { product: "spectre", action: "find_account", payload: { query: "Acme" } })],
        (req) => {
          expect(JSON.stringify(req.messages.at(-1))).toContain("dana@acme.example");
          return [
            toolUse("ecosystem_call", {
              product: "spectre",
              action: "draft_followup",
              payload: { to: "dana@acme.example", subject: "Checking in", body: "Hi Dana" },
            }),
          ];
        },
        () => [toolUse("step_complete", { summary: "Draft 1 saved for dana@acme.example" })],
        () => [toolUse("submit_verdict", { passed: true, summary: "draft exists", criteria: [{ criterion: "a draft exists for the owner", met: true, evidence: "draftId 1" }] })],
      ],
    );
    const architct = new Architect({ brain, instruments: [eco], dataDir: path.join(dir, "data") });
    const events: string[] = [];
    architct.on("event", (e) => events.push(e.type));
    const run = await architct.run("Follow up on Acme's renewal risk");

    expect(run.status).toBe("succeeded");
    expect(drafts).toHaveLength(1);
    expect(attestations).toHaveLength(1);
    expect(attestations[0]).toMatchObject({ runId: run.id, goal: "Follow up on Acme's renewal risk" });
    expect((attestations[0] as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);
    expect(events).toContain("run.attested");
  });
});
