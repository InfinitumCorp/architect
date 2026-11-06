import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserInstrument } from "../src/instruments/browser.js";
import type { ToolContext } from "../src/instruments/types.js";

const PAGE = `<!doctype html><title>Supplier quote</title>
<h1>Request a quote</h1>
<label>Company <input id="company" name="company"></label>
<label>Password <input type="password" name="pw"></label>
<select id="qty"><option>10</option><option>100</option></select>
<button id="go" onclick="document.getElementById('out').textContent='Quote for '+document.getElementById('company').value+': $'+(document.getElementById('qty').value*4)">Get price</button>
<button onclick="1">Place order</button>
<p id="out"></p>`;

let server: Server;
let base: string;
let dir: string;
const browser = new BrowserInstrument({ headless: true });
const evidence: unknown[] = [];
const ctx = (): ToolContext => ({
  runId: "run_test",
  stepId: "s1",
  runDir: dir,
  addEvidence: (e) => {
    evidence.push(e);
    return { id: "ev", stepId: "s1", at: "", ...e };
  },
});

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architect-browser-"));
  server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(async () => {
  await browser.dispose();
  server.close();
  await rm(dir, { recursive: true, force: true });
});

const refFor = (snapshot: string, needle: string) => {
  const line = snapshot.split("\n").find((l) => l.includes(needle));
  return line?.match(/\[(e\d+)\]/)?.[1] ?? "";
};

describe("BrowserInstrument (real Chromium)", () => {
  it("snapshots, types, selects, clicks, screenshots and classifies risk", async () => {
    await browser.execute("browser_navigate", { url: base }, ctx());
    const snap = (await browser.execute("browser_snapshot", {}, ctx())).text;
    expect(snap).toContain("Request a quote");

    const company = refFor(snap, '"Company"');
    const pw = refFor(snap, "input:password");
    const qty = refFor(snap, "options=");
    const go = refFor(snap, '"Get price"');
    const order = refFor(snap, '"Place order"');
    expect([company, pw, qty, go, order].every(Boolean)).toBe(true);

    await browser.execute("browser_type", { ref: company, text: "Acme" }, ctx());
    await browser.execute("browser_select", { ref: qty, option: "100" }, ctx());

    const clickSpec = browser.tools.find((t) => t.name === "browser_click")!;
    const risk = clickSpec.risk as (i: Record<string, unknown>) => Promise<string>;
    expect(await risk({ ref: go })).toBe("write");
    expect(await risk({ ref: order })).toBe("irreversible");

    await browser.execute("browser_click", { ref: go }, ctx());
    await browser.execute("browser_wait", { text: "Quote for Acme" }, ctx());
    const after = (await browser.execute("browser_snapshot", {}, ctx())).text;
    expect(after).toContain("Quote for Acme: $400");

    const refused = await browser.execute("browser_type", { ref: refFor(after, "input:password"), text: "hunter2" }, ctx());
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Refused/);

    const shot = await browser.execute("browser_screenshot", { label: "quote" }, ctx());
    expect(shot.image?.base64.length).toBeGreaterThan(1000);
    expect(evidence.some((e) => (e as { kind: string }).kind === "screenshot")).toBe(true);
  }, 60_000);

  it("enforces allowed hosts", async () => {
    const locked = new BrowserInstrument({ allowedHosts: ["example.com"] });
    await expect(locked.execute("browser_navigate", { url: base }, ctx())).rejects.toThrow(/outside/);
    await locked.dispose();
  }, 30_000);
});
