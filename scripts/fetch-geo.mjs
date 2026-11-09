// Download the pinned v2fly geoip.dat and geosite.dat (dlc.dat) files.
// Each file is checked against its official .sha256sum asset and against data/geo/geo.lock.json.
// A mismatch stops the script before any file is published. The binaries are not committed.
//
//   node scripts/fetch-geo.mjs
//   node scripts/fetch-geo.mjs --lock data/geo/geo.lock.json --out data/geo
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BANNED = /loyalsoldier|sing-?box|sagernet/i;
const V2FLY = /^\/v2fly\/(?:geoip|domain-list-community)\/releases\/download\/[^/]+\/[^/]+$/;
const MAX_BYTES = 64 * 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseSum(text) {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith("#"));
  if (!line) throw new Error("official checksum file is empty");
  const match = line.match(/^([a-fA-F0-9]{64})\b/);
  if (!match) throw new Error(`official checksum file is unreadable: ${line}`);
  return match[1].toLowerCase();
}

function assertSource(url, label) {
  if (BANNED.test(url)) throw new Error(`refusing ${label}: only v2fly geo data sets are allowed`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} URL is unreadable`);
  }
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (process.env.INFINITUM_GEO_FETCH_TEST === "1" && local && parsed.protocol === "http:") return;
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || !V2FLY.test(parsed.pathname)) {
    throw new Error(`${label} URL is not a v2fly GitHub release asset`);
  }
}

async function download(url) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
    headers: { "user-agent": "infinitum-architect-geo-fetch" },
  });
  if (!res.ok) throw new Error(`download failed for ${url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error(`download failed for ${url}: empty body`);
  if (bytes.length > MAX_BYTES) throw new Error(`download failed for ${url}: larger than ${MAX_BYTES} bytes`);
  return bytes;
}

async function main() {
  const lockPath = path.resolve(arg("--lock", path.join(ROOT, "data", "geo", "geo.lock.json")));
  const outDir = path.resolve(arg("--out", path.dirname(lockPath)));
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const datasets = lock.datasets;
  if (!Array.isArray(datasets) || datasets.length === 0) throw new Error("lockfile has no datasets");
  const ids = datasets.map((item) => item.id).join(",");
  if (ids !== "geoip,geosite") throw new Error("lockfile must list geoip then geosite, and nothing else");

  const staged = [];
  for (const item of datasets) {
    if (item.file !== "geoip.dat" && item.file !== "geosite.dat") {
      throw new Error(`refusing to write ${item.file}; only geoip.dat and geosite.dat are allowed`);
    }
    const expected = String(item.sha256 ?? "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`${item.file} lockfile checksum is missing`);
    assertSource(item.url, item.id);
    assertSource(item.sha256Url, `${item.id} checksum`);
    const official = parseSum((await download(item.sha256Url)).toString("utf8"));
    if (official !== expected) {
      throw new Error(
        `${item.file} official checksum does not match the lockfile.\n  lockfile: ${expected}\n  official: ${official}`,
      );
    }
    const bytes = await download(item.url);
    const got = sha256(bytes);
    if (got !== official) {
      throw new Error(
        `${item.file} downloaded checksum does not match the official checksum.\n  official: ${official}\n  download: ${got}`,
      );
    }
    staged.push({ file: item.file, bytes, sha256: got });
  }

  await mkdir(outDir, { recursive: true });
  for (const item of staged) {
    const dest = path.join(outDir, item.file);
    const partial = `${dest}.partial`;
    await writeFile(partial, item.bytes);
    await rename(partial, dest);
    console.log(`${item.file}  ${item.sha256}`);
  }
}

main().catch((err) => {
  console.error(`geo fetch: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
