#!/usr/bin/env node
// Publish a build to the hosted downloads (rchtch.app/download/<file>) in 8 MB parts,
// retrying each part, so a slow connection does not time out the whole upload.
//   node scripts/publish-download.mjs dist/Architect-Desktop-0.3.0-win32-x64.zip [--server https://rchtch.app]
// The API token comes from ARCHITECT_API_TOKEN (environment or .env); it is never printed.
import { openSync, readSync, closeSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { server: { type: "string", default: "https://rchtch.app" } } });
const file = positionals[0];
if (!file || !existsSync(file)) throw new Error("usage: node scripts/publish-download.mjs <file> [--server URL]");
let token = process.env.ARCHITECT_API_TOKEN;
if (!token && existsSync(".env")) token = readFileSync(".env", "utf8").match(/^ARCHITECT_API_TOKEN=(.+)$/m)?.[1]?.trim();
if (!token) throw new Error("Set ARCHITECT_API_TOKEN (environment or .env).");

const PART = 8 * 1024 * 1024;
const name = path.basename(file);
const size = statSync(file).size;
const base = `${values.server.replace(/\/$/, "")}/v1/downloads/${encodeURIComponent(name)}/uploads`;
const headers = { authorization: `Bearer ${token}` };

async function call(url, init, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(300_000) });
      if (r.ok) return r.json();
      if (r.status < 500 || i >= tries) throw new Error(`${r.status} ${await r.text()}`);
    } catch (e) {
      if (i >= tries || /^4\d\d /.test(e.message)) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000 * i));
  }
}

const { uploadId } = await call(base, { method: "POST" });
const fd = openSync(file, "r");
const parts = [];
const count = Math.ceil(size / PART);
for (let n = 1; n <= count; n++) {
  const buf = Buffer.alloc(Math.min(PART, size - (n - 1) * PART));
  readSync(fd, buf, 0, buf.length, (n - 1) * PART);
  const t = Date.now();
  parts.push(await call(`${base}/${encodeURIComponent(uploadId)}/${n}`, { method: "PUT", body: buf }));
  console.log(`part ${n}/${count} (${(buf.length / 1e6).toFixed(1)} MB, ${((Date.now() - t) / 1000).toFixed(0)}s)`);
}
closeSync(fd);
const done = await call(`${base}/${encodeURIComponent(uploadId)}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts }) });
console.log(`published ${values.server.replace(/\/$/, "")}${done.url} (${(size / 1e6).toFixed(1)} MB)`);
