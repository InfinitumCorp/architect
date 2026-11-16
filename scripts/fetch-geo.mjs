// Download the pinned v2fly geoip.dat and geosite.dat (dlc.dat) files.
// Writes only into data/geo/, which is gitignored. Exits on a checksum mismatch.
//
//   node scripts/fetch-geo.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(ROOT, "data", "geo.lock.json");

const REFUSED = /loyalsoldier|sing-box|singbox/i;

/** First 64-hex digest in a .sha256sum file that names `asset`. */
export function parseSha256Sum(text, asset) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/);
    if (match && match[2] === asset) return match[1].toLowerCase();
  }
  throw new Error(`official sha256sum has no hash for ${asset}`);
}

/**
 * Stop unless the lockfile hash, the official .sha256sum, and the bytes all agree.
 * @returns {string} the verified lowercase sha256
 */
export function assertChecksum({ name, asset, lockHash, officialText, bytes }) {
  const official = parseSha256Sum(officialText, asset);
  const lock = String(lockHash).toLowerCase();
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  if (official !== lock) {
    throw new Error(`checksum mismatch for ${name}: lockfile ${lock} but official sha256sum says ${official}`);
  }
  if (fileHash !== lock) {
    throw new Error(`checksum mismatch for ${name}: downloaded ${fileHash} but expected ${lock}`);
  }
  return fileHash;
}

function assertAllowed(entry) {
  const blob = JSON.stringify(entry);
  if (REFUSED.test(blob)) {
    throw new Error(`refusing ${entry.name}: only v2fly geoip and domain-list-community are allowed`);
  }
  if (entry.project !== "v2fly/geoip" && entry.project !== "v2fly/domain-list-community") {
    throw new Error(`refusing ${entry.name}: project ${entry.project} is not a pinned v2fly release`);
  }
}

async function download(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GET ${url} failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * @param {{ lock?: object, lockPath?: string, destDir?: string, fetchImpl?: typeof fetch, log?: (m: string) => void }} [opts]
 */
export async function fetchGeoSets(opts = {}) {
  const log = opts.log ?? ((m) => console.log(m));
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const lock = opts.lock ?? JSON.parse(await readFile(opts.lockPath ?? LOCK_PATH, "utf8"));
  const destDir = opts.destDir ?? path.join(ROOT, lock.directory ?? "data/geo");
  if (!Array.isArray(lock.sets) || lock.sets.length === 0) throw new Error("geo lockfile has no sets");
  await mkdir(destDir, { recursive: true });

  for (const entry of lock.sets) {
    assertAllowed(entry);
    const officialBytes = await download(entry.sha256Url, fetchImpl);
    const data = await download(entry.url, fetchImpl);
    assertChecksum({
      name: entry.name,
      asset: entry.asset,
      lockHash: entry.sha256,
      officialText: officialBytes.toString("utf8"),
      bytes: data,
    });
    const tmp = path.join(destDir, `${entry.name}.partial`);
    const dest = path.join(destDir, entry.name);
    try {
      await writeFile(tmp, data);
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    log(`${entry.name}  ${entry.sha256}  (${entry.project} @ ${entry.tag})`);
  }
  return destDir;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invoked) {
  fetchGeoSets().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
