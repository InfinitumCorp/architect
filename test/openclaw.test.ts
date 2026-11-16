// @scalvs / @scalus on Architect's API: behind the bearer token, against a fake OpenClaw gateway.
import { mkdtemp, rm, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Architect } from "../src/architect.js";
import { createArchitectServer } from "../src/server.js";
import { createOpenClaw, createOpenClawRoutes } from "../src/openclaw/openclaw.mjs";
import { ScriptedBrain } from "./helpers.js";

const sent: any[] = [];
const gateway = (async (_url: string, init: RequestInit) => {
  sent.push(JSON.parse(String(init.body)));
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Deploy notes posted to #releases." } }] }));
}) as unknown as typeof fetch;

const servers: Server[] = [];
let dir = "";
async function start(withGateway: boolean) {
  const architect = new Architect({ brain: new ScriptedBrain([]), instruments: [], dataDir: path.join(dir, `data-${servers.length}`) });
  const openclaw = createOpenClawRoutes({
    openclaw: withGateway ? createOpenClaw({ url: "https://claw.test", token: "tok_secret", agent: "openclaw/ops", fetch: gateway }) : null,
    prefix: "/v1/openclaw",
    product: "architect",
  });
  const server = createArchitectServer({ architect, token: "secret", openclaw });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

let base = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architect-scalvs-"));
  base = await start(true);
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  await rm(dir, { recursive: true, force: true });
});

const H = { authorization: "Bearer secret", "content-type": "application/json" };
const post = (b: string, text: string) => fetch(`${b}/v1/openclaw`, { method: "POST", headers: H, body: JSON.stringify({ text }) });

describe("@scalvs / @scalus", () => {
  it("needs Architect's token", async () => {
    expect((await fetch(`${base}/v1/openclaw`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("hands the task to the SCALVS agent and shows its answer", async () => {
    const r = await (await post(base, "@scalvs post the deploy notes to #releases")).json();
    expect(r).toEqual({ mention: true, text: "Deploy notes posted to #releases.", agent: "openclaw/ops" });
    expect(sent.at(-1)).toMatchObject({ model: "openclaw/ops", user: "architect:operator" });
    expect(sent.at(-1).messages.at(-1).content).toBe("post the deploy notes to #releases");
    expect((await (await post(base, "@scalus check the build")).json()).mention).toBe(true);
  });

  it("does not trigger on @openclaw or plain text", async () => {
    expect(await (await post(base, "@openclaw do it")).json()).toEqual({ mention: false });
    expect(await (await post(base, "open the dashboard")).json()).toEqual({ mention: false });
  });

  it("reports the connection without the gateway URL or token", async () => {
    const body = await (await fetch(`${base}/v1/openclaw`, { headers: H })).text();
    expect(JSON.parse(body)).toEqual({ connected: true, agent: "openclaw/ops" });
    expect(body).not.toContain("tok_secret");
    expect(body).not.toContain("claw.test");
  });

  it("is off until configured and says how to connect", async () => {
    const off = await start(false);
    const res = await post(off, "@scalvs check the build");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/OPENCLAW_GATEWAY_URL/);
  });

  it("the web app routes @scalvs, @scalus and @conjure from the composer", async () => {
    const html = await readFile(path.join(__dirname, "..", "web", "index.html"), "utf8");
    expect(html).toContain('api("/v1/openclaw"');
    expect(html).toContain('api("/v1/conjure"');
    expect(html).toMatch(/SCALVS\.test\(text\)/);
    expect(html).toMatch(/CONJURE\.test\(text\)/);
  });
});
