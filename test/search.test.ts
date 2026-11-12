// @search on Architect's API: behind the bearer token, with a fake search engine and model.
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Architect } from "../src/architect.js";
import { createArchitectServer } from "../src/server.js";
import { createSearch, createSearchRoutes } from "../src/search/search.mjs";
import { ScriptedBrain } from "./helpers.js";

const engine = { name: "test", search: async () => [{ title: "Release notes", url: "https://docs.example/releases", snippet: "v2 ships Friday" }] };
const pages = (async () => new Response("<title>Release notes</title><article>v2 ships Friday.</article>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

let server: Server;
let dir = "";
let base = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architect-search-"));
  const architect = new Architect({ brain: new ScriptedBrain([]), instruments: [], dataDir: path.join(dir, "data") });
  const search = createSearchRoutes({ search: createSearch({ engines: [engine], fetch: pages, chat: async () => "v2 ships on Friday [1]." }), prefix: "/v1/search" });
  server = createArchitectServer({ architect, token: "secret", search });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(dir, { recursive: true, force: true });
});

const H = { authorization: "Bearer secret", "content-type": "application/json" };

describe("@search", () => {
  it("needs Architect's token", async () => {
    expect((await fetch(`${base}/v1/search`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
  });

  it("answers with cited sources, and ignores plain text", async () => {
    const r = await (await fetch(`${base}/v1/search`, { method: "POST", headers: H, body: JSON.stringify({ text: "@search when does v2 ship?" }) })).json();
    expect(r).toMatchObject({ mention: true, query: "when does v2 ship?", answer: "v2 ships on Friday [1].", cited: [1] });
    expect(r.sources).toEqual([{ n: 1, title: "Release notes", url: "https://docs.example/releases", snippet: "v2 ships Friday" }]);
    expect(await (await fetch(`${base}/v1/search`, { method: "POST", headers: H, body: JSON.stringify({ text: "deploy it" }) })).json()).toEqual({ mention: false });
  });
});

describe("VEIL engine", () => {
  it("POSTs the query and keeps only http(s) results; VEIL_SEARCH_URL turns it on", async () => {
    const { veilEngine, enginesFromEnv } = await import("../src/search/search.mjs");
    let sent: { url: string; body: string } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: String(init.body) };
      return Response.json({ results: [{ title: "<b>Docs</b>", url: "https://docs.example/a", snippet: "x &amp; y" }, { title: "bad", url: "javascript:1" }] });
    }) as unknown as typeof fetch;
    const veil = veilEngine({ url: "https://veil.test/api/search", fetch: fetchImpl });
    expect(await veil.search("q1")).toEqual([{ title: "Docs", url: "https://docs.example/a", snippet: "x & y" }]);
    expect(sent).toEqual({ url: "https://veil.test/api/search", body: JSON.stringify({ q: "q1" }) });
    expect(enginesFromEnv({ VEIL_SEARCH_URL: "https://infinitumveil.app/api/search" }).map((e: { name: string }) => e.name)).toEqual(["veil"]);
    expect(() => enginesFromEnv({ VEIL_SEARCH_URL: "http://infinitumveil.app/api/search" })).toThrow(/https/);
  });
});
