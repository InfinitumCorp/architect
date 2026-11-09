/**
 * Optional destination annotation.
 *
 * INFINITUM_GEO_ENABLED defaults off. When it is off, nothing is loaded and callers
 * get no annotation, so action records stay as they are. When it is on, a URL in a
 * tool input is annotated with a country (IP) or geosite categories (domain).
 * The autonomy gate is not changed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { GeoAnnotation } from "../types.js";
import { GeoDataError, geoFromBytes, type GeoData } from "./dat.js";

const URL_FIELD = /url|href|endpoint|link|origin/i;

interface LockEntry {
  id?: string;
  file?: string;
  sha256?: string;
}

const cache = new Map<string, GeoData | null>();
let warned = false;

export function geoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.INFINITUM_GEO_ENABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function resetGeoCache(): void {
  cache.clear();
  warned = false;
}

function assertChecksum(file: string, bytes: Uint8Array, expected: string | undefined): void {
  const want = expected?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/.test(want)) throw new GeoDataError(`${file} lockfile checksum is missing`);
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== want) throw new GeoDataError(`${file} checksum does not match the lockfile`);
}

/** Load geoip.dat and geosite.dat from a directory, checking each file against geo.lock.json. */
export function loadGeoDir(dir: string): GeoData {
  let lock: { datasets?: LockEntry[] };
  try {
    lock = JSON.parse(readFileSync(path.join(dir, "geo.lock.json"), "utf8")) as { datasets?: LockEntry[] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GeoDataError(`geo lockfile could not be read: ${message}`);
  }
  const datasets = lock.datasets ?? [];
  const ip = datasets.find((entry) => entry.id === "geoip");
  const site = datasets.find((entry) => entry.id === "geosite");
  if (!ip || !site || ip.file !== "geoip.dat" || site.file !== "geosite.dat") {
    throw new GeoDataError("geo lockfile must name geoip.dat and geosite.dat");
  }
  const ipBytes = readFileSync(path.join(dir, ip.file));
  const siteBytes = readFileSync(path.join(dir, site.file));
  assertChecksum(ip.file, ipBytes, ip.sha256);
  assertChecksum(site.file, siteBytes, site.sha256);
  return geoFromBytes(ipBytes, siteBytes);
}

function cachedData(env: NodeJS.ProcessEnv): GeoData | null {
  const dir = path.resolve(env.INFINITUM_GEO_DIR?.trim() || path.join(process.cwd(), "data", "geo"));
  if (cache.has(dir)) return cache.get(dir) ?? null;
  try {
    const data = loadGeoDir(dir);
    cache.set(dir, data);
    return data;
  } catch (err) {
    cache.set(dir, null);
    if (!warned) {
      warned = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[architect] geo annotation unavailable: ${message}`);
    }
    return null;
  }
}

/** Annotate the first URL-like fields of a tool input. Empty when nothing matches. */
export function annotationFor(data: GeoData, input: Record<string, unknown>): GeoAnnotation | undefined {
  let country: string | undefined;
  const categories: string[] = [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(input)) {
    if (!URL_FIELD.test(key) || typeof value !== "string" || !/^https?:\/\//i.test(value)) continue;
    let host: string;
    try {
      host = new URL(value).hostname.replace(/^\[|\]$/g, "");
    } catch {
      continue;
    }
    if (!host) continue;
    const found = data.countryOf(host);
    if (found && !country) country = found;
    for (const code of data.categoriesOf(host)) {
      if (seen.has(code)) continue;
      seen.add(code);
      categories.push(code);
    }
  }
  if (!country && categories.length === 0) return undefined;
  const note: GeoAnnotation = {};
  if (country) note.country = country;
  if (categories.length) note.categories = categories;
  return note;
}

/**
 * Annotation for a tool input when the env flag is on and the data sets load.
 * Returns undefined when the flag is off, the files are missing, or a checksum does not match.
 */
export function annotateDestination(
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): GeoAnnotation | undefined {
  if (!geoEnabled(env)) return undefined;
  const data = cachedData(env);
  if (!data) return undefined;
  return annotationFor(data, input);
}

export { GeoDataError };
export type { GeoData };
