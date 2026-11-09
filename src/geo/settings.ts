import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Saved geo-routing preference. Missing or unreadable means off. */
export interface GeoSettings {
  geoRouting: boolean;
}

/**
 * Opt-in switch. `INFINITUM_GEO_ENABLED` wins when it is set.
 * Unset env and a missing preference both stay off, which is the default.
 */
export function geoRoutingEnabled(env: NodeJS.ProcessEnv, saved = false): boolean {
  const raw = env.INFINITUM_GEO_ENABLED;
  if (typeof raw === "string" && raw.trim() !== "") return /^(1|true|yes|on)$/i.test(raw.trim());
  return saved === true;
}

export function readGeoSettings(file: string | undefined): GeoSettings {
  if (!file) return { geoRouting: false };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { geoRouting?: unknown };
    return { geoRouting: parsed?.geoRouting === true };
  } catch {
    return { geoRouting: false };
  }
}

/** Persist the toggle. Other keys in the file are kept. */
export async function writeGeoSettings(file: string, geoRouting: boolean): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
  } catch {
    current = {};
  }
  current.geoRouting = geoRouting;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`);
  await rename(tmp, file);
}
