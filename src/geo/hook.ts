import { readFileSync } from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { loadGeoIpList, loadGeoSiteList, normalizeDomain, type GeoIpList, type GeoSiteList } from "./dat.js";
import { geoRoutingEnabled, readGeoSettings, writeGeoSettings } from "./settings.js";

const HOST_KEYS = new Set(["url", "host", "hostname", "domain", "starturl"]);
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;

function isAddress(value: string): boolean {
  const host = value.replace(/^\[|\]$/g, "");
  return Boolean(isIP(host)) || host.toLowerCase().startsWith("::ffff:");
}

/** Hosts and addresses named by a tool input. No name resolution. */
export function targetsOf(input: unknown): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    const host = value.trim();
    if (host && !found.includes(host)) found.push(host);
  };
  const walk = (value: unknown, key?: string) => {
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      if (isAddress(text)) add(text);
      for (const match of text.matchAll(URL_RE)) {
        try { add(new URL(match[0]).hostname); } catch { /* skip a bad URL */ }
      }
      if (key && HOST_KEYS.has(key.toLowerCase()) && !text.includes(" ")) {
        const host = normalizeDomain(text);
        if (host) add(host);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item);
    } else if (value && typeof value === "object") {
      for (const [childKey, item] of Object.entries(value)) walk(item, childKey);
    }
  };
  walk(input);
  return found;
}

/**
 * One log line for the hosts in `input`.
 * Undefined when there is nothing to say, so a disabled switch adds no text.
 */
export function geoNote(input: unknown, geoip?: GeoIpList, geosite?: GeoSiteList): string | undefined {
  const targets = targetsOf(input);
  if (targets.length === 0) return undefined;
  const parts = targets.map((target) => {
    const ip = isIP(target.replace(/^\[|\]$/g, "")) || target.toLowerCase().startsWith("::ffff:");
    if (!geoip && !geosite) return `geo ${target}: dataset unavailable`;
    if (ip) {
      const country = geoip?.countryFor(target);
      return country ? `geo ${target}: country ${country}` : `geo ${target}: country unknown`;
    }
    const categories = geosite?.categoriesFor(target) ?? [];
    return categories.length ? `geo ${target}: categories ${categories.join(", ")}` : `geo ${target}: categories none`;
  });
  return parts.join("; ");
}

export interface GeoHookOptions {
  /** Absolute settings file. Omitted for stores that are not a directory. */
  settingsFile?: string;
  /** Directory holding geoip.dat and geosite.dat. Defaults to ./data/geo or INFINITUM_GEO_DIR. */
  datasetDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** Loads datasets only after the switch is on. Default is off. */
export class GeoHook {
  private saved: boolean;
  private geoip?: GeoIpList;
  private geosite?: GeoSiteList;
  private loaded = false;

  constructor(private opts: GeoHookOptions = {}) {
    this.saved = readGeoSettings(opts.settingsFile).geoRouting;
  }

  get savedRouting(): boolean {
    return this.saved;
  }

  enabled(): boolean {
    return geoRoutingEnabled(this.opts.env ?? process.env, this.saved);
  }

  async setRouting(on: boolean): Promise<void> {
    this.saved = on;
    if (this.opts.settingsFile) await writeGeoSettings(this.opts.settingsFile, on);
  }

  /** Annotation for logs and for a gate reason. Undefined while routing is off. */
  noteFor(input: unknown): string | undefined {
    if (!this.enabled()) return undefined;
    this.ensureLoaded();
    return geoNote(input, this.geoip, this.geosite);
  }

  private ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    const dir = this.opts.datasetDir || this.opts.env?.INFINITUM_GEO_DIR || process.env.INFINITUM_GEO_DIR || path.resolve("data/geo");
    this.geoip = readDat(path.join(dir, "geoip.dat"), loadGeoIpList);
    this.geosite = readDat(path.join(dir, "geosite.dat"), loadGeoSiteList);
  }
}

function readDat<T>(file: string, load: (bytes: Uint8Array) => T): T | undefined {
  try {
    return load(readFileSync(file));
  } catch {
    return undefined;
  }
}
