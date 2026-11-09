// @conjure on Architect's API: behind the bearer token, against a fake Conjure service.
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Architect } from "../src/architect.js";
import { createArchitectServer } from "../src/server.js";
import { createConjure, createConjureRoutes } from "../src/conjure/conjure.mjs";
import { ScriptedBrain } from "./helpers.js";

const sent: any[] = [];
const fakeConjure = (async (_url: string, init: RequestInit) => {
  const p = { id: "pr_7", product: "architect", question: "will the migration finish by Friday?", agents: 8, rounds: 2, stats: [], createdAt: "2026-11-08T00:00:00Z", poles: { for: "it finishes", against: "no" } };
  if (init.method === "POST") { sent.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ ...p, status: "queued", round: 0 }), { status: 202 }); }
  return new Response(JSON.stringify({ ...p, status: "done", round: 2, report: { outcome: "Finishes Thursday.", probability: 0.81, confidence: "medium", forecast: "", drivers: [], signals: [], assumptions: [] } }));
}) as unknown as typeof fetch;

let server: Server, base = "", dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architect-conjure-"));
  const architect = new Architect({ brain: new ScriptedBrain([]), instruments: [], dataDir: path.join(dir, "data") });
  const conjure = createConjureRoutes({ conjure: createConjure({ url: "https://conjure.test", key: "cjp_architect_x", fetch: fakeConjure }), secret: "cjp_architect_x", prefix: "/v1/conjure", source: "architect" });
  server = createArchitectServer({ architect, token: "secret", conjure });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const H = { authorization: "Bearer secret", "content-type": "application/json" };

describe("@conjure", () => {
  it("needs Architect's token", async () => {
    expect((await fetch(`${base}/v1/conjure`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("starts a forecast from an @conjure message and follows it to the report", async () => {
    expect(await (await fetch(`${base}/v1/conjure`, { method: "POST", headers: H, body: JSON.stringify({ text: "open the dashboard" }) })).json()).toEqual({ mention: false });
    const r = await (await fetch(`${base}/v1/conjure`, { method: "POST", headers: H, body: JSON.stringify({ text: "@conjure will the migration finish by Friday?" }) })).json();
    expect(r.mention).toBe(true);
    expect(sent[0]).toMatchObject({ question: "will the migration finish by Friday?", source: "architect", user: "operator" });
    const live = await (await fetch(`${base}/v1/conjure/${r.ticket}`, { headers: H })).json();
    expect(live.text).toMatch(/81% likely that it finishes/);
  });
});
