import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Architect } from "../src/architect.js";
import { encodeGeoIpList, encodeGeoSiteList, loadGeoIpList, loadGeoSiteList, type GeoIpEntry, type GeoSiteEntry } from "../src/geo/dat.js";
import { GeoHook } from "../src/geo/hook.js";
import { geoRoutingEnabled, readGeoSettings, writeGeoSettings } from "../src/geo/settings.js";
import { annotateDecision, gate } from "../src/policy.js";
import { createArchitectServer } from "../src/server.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import { ScriptedBrain, toolUse } from "./helpers.js";
import { assertChecksum, fetchGeoSets, parseSha256Sum } from "../scripts/fetch-geo.mjs";

const v4 = (ip: string) => Uint8Array.from(ip.split(".").map((p) => Number(p)));
const v6 = (groups: number[]) => {
  const out = new Uint8Array(16);
  groups.forEach((n, i) => {
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  });
  return out;
};

const ipEntries: GeoIpEntry[] = [
  { country: "ZZ", inverse: false, cidrs: [{ ip: v4("203.0.113.0"), prefix: 24 }, { ip: v6([0x2001, 0x0db8, 0, 0, 0, 0, 0, 0]), prefix: 32 }] },
  { country: "YY", inverse: false, cidrs: [{ ip: v4("198.51.100.0"), prefix: 25 }] },
  { country: "LO", inverse: true, cidrs: [{ ip: v4("127.0.0.0"), prefix: 8 }] },
];

const siteEntries: GeoSiteEntry[] = [
  {
    category: "example",
    domains: [
      { type: 2, value: "example.com" },
      { type: 3, value: "exact.test" },
      { type: 0, value: "keyword" },
      { type: 1, value: String.raw`^re\d+\.test$` },
    ],
  },
  { category: "ads", domains: [{ type: 2, value: "ads.example.com" }] },
  { category: "cyber", domains: [{ type: 3, value: "cyber.test" }] },
];

const fixtureDir = path.resolve("test/fixtures/geo");

describe("geo datasets", () => {
  const ip = loadGeoIpList(encodeGeoIpList(ipEntries));
  const site = loadGeoSiteList(encodeGeoSiteList(siteEntries));

  it("reads the synthetic .dat fixtures", async () => {
    const ipBytes = new Uint8Array(await readFile(path.join(fixtureDir, "geoip.dat")));
    const siteBytes = new Uint8Array(await readFile(path.join(fixtureDir, "geosite.dat")));
    expect(ipBytes).toEqual(encodeGeoIpList(ipEntries));
    expect(siteBytes).toEqual(encodeGeoSiteList(siteEntries));
    expect(loadGeoIpList(ipBytes).countryFor("203.0.113.10")).toBe("ZZ");
    expect(loadGeoSiteList(siteBytes).categoriesFor("cyber.test")).toEqual(["cyber"]);
  });

  it("maps an address to a country, preferring the longest positive prefix", () => {
    expect(ip.countryFor("203.0.113.10")).toBe("ZZ");
    expect(ip.countryFor("::ffff:203.0.113.10")).toBe("ZZ");
    expect(ip.countryFor("2001:db8::1")).toBe("ZZ");
    expect(ip.countryFor("198.51.100.10")).toBe("YY");
    expect(ip.countryFor("198.51.100.200")).toBe("LO");
    expect(ip.countryFor("8.8.8.8")).toBe("LO");
    expect(ip.countryFor("127.0.0.1")).toBeUndefined();
    expect(ip.countryFor("not-an-ip")).toBeUndefined();
  });

  it("maps a domain to categories", () => {
    expect(site.categoriesFor("a.example.com")).toEqual(["example"]);
    expect(site.categoriesFor("notexample.com")).toEqual([]);
    expect(site.categoriesFor("ads.example.com")).toEqual(["example", "ads"]);
    expect(site.categoriesFor("exact.test")).toEqual(["example"]);
    expect(site.categoriesFor("other.exact.test")).toEqual([]);
    expect(site.categoriesFor("a-keyword.test")).toEqual(["example"]);
    expect(site.categoriesFor("re42.test")).toEqual(["example"]);
    expect(site.categoriesFor("re.test")).toEqual([]);
    expect(site.categoriesFor("cyber.test")).toEqual(["cyber"]);
    expect(site.categoriesFor("https://cyber.test/docs")).toEqual(["cyber"]);
  });
});

describe("geo routing switch", () => {
  const prevEnabled = process.env.INFINITUM_GEO_ENABLED;
  const prevDir = process.env.INFINITUM_GEO_DIR;
  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.INFINITUM_GEO_ENABLED;
    else process.env.INFINITUM_GEO_ENABLED = prevEnabled;
    if (prevDir === undefined) delete process.env.INFINITUM_GEO_DIR;
    else process.env.INFINITUM_GEO_DIR = prevDir;
  });

  it("stays off unless the env switch or the saved preference says on", () => {
    expect(geoRoutingEnabled({}, false)).toBe(false);
    expect(geoRoutingEnabled({ INFINITUM_GEO_ENABLED: "" }, false)).toBe(false);
    expect(geoRoutingEnabled({ INFINITUM_GEO_ENABLED: "0" }, true)).toBe(false);
    expect(geoRoutingEnabled({ INFINITUM_GEO_ENABLED: "off" }, true)).toBe(false);
    expect(geoRoutingEnabled({ INFINITUM_GEO_ENABLED: "on" }, false)).toBe(true);
    expect(geoRoutingEnabled({}, true)).toBe(true);
  });

  it("persists the preference and leaves the gate unchanged while off", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "architect-geo-"));
    try {
      const file = path.join(dir, "settings.json");
      expect(readGeoSettings(file).geoRouting).toBe(false);
      await writeGeoSettings(file, true);
      expect(readGeoSettings(file).geoRouting).toBe(true);
      await writeGeoSettings(file, false);
      expect(readGeoSettings(file).geoRouting).toBe(false);

      const decision = gate({ autonomy: "rehearsal", risk: "write", required: "browser", granted: ["browser"] });
      expect(annotateDecision(decision)).toBe(decision);
      expect(annotateDecision(decision, undefined)).toBe(decision);
      const execute = gate({ autonomy: "accompaniment", risk: "read", required: "browser", granted: ["browser"] });
      expect(annotateDecision(execute, "geo example.com: categories example")).toBe(execute);
      expect(annotateDecision(decision, "geo example.com: categories example").reason).toBe(
        "Rehearsal prepares drafts and never changes anything · geo example.com: categories example",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not annotate a run while the switch is off", async () => {
    delete process.env.INFINITUM_GEO_ENABLED;
    delete process.env.INFINITUM_GEO_DIR;
    const dir = await mkdtemp(path.join(tmpdir(), "architect-geo-"));
    try {
      const ws = new WorkspaceInstrument(path.join(dir, "ws"));
      const brain = new ScriptedBrain(
        {
          summary: "note a host",
          permissions: ["workspace.write"],
          startUrl: null,
          steps: [{ title: "Write", instruction: "write", instruments: ["workspace"], checkpoint: false }],
          successCriteria: ["written"],
        },
        [
          () => [toolUse("workspace_write", { path: "note.txt", content: "see https://ads.example.com/x" })],
          () => [toolUse("step_complete", { summary: "wrote" })],
        ],
      );
      const architect = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
      const notes: string[] = [];
      architect.on("event", (ev) => {
        if (ev.type === "architect.note") notes.push(String(ev.data.text));
      });
      const run = await architect.run("Note", { autonomy: "rehearsal" });
      expect(architect.geoRouting).toBe(false);
      expect(architect.geoRoutingEffective).toBe(false);
      expect(run.actions[0]?.geo).toBeUndefined();
      expect(run.actions[0]?.output).toBe("Rehearsal prepares drafts and never changes anything");
      expect(notes).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("annotates a run from the fixtures when the saved switch is on", async () => {
    delete process.env.INFINITUM_GEO_ENABLED;
    process.env.INFINITUM_GEO_DIR = fixtureDir;
    const dir = await mkdtemp(path.join(tmpdir(), "architect-geo-"));
    try {
      const ws = new WorkspaceInstrument(path.join(dir, "ws"));
      const brain = new ScriptedBrain(
        {
          summary: "note a host",
          permissions: ["workspace.write"],
          startUrl: null,
          steps: [{ title: "Write", instruction: "write", instruments: ["workspace"], checkpoint: false }],
          successCriteria: ["written"],
        },
        [
          () => [toolUse("workspace_write", { path: "note.txt", content: "see https://ads.example.com/x and https://203.0.113.10/" })],
          () => [toolUse("step_complete", { summary: "wrote" })],
        ],
      );
      const architect = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
      await architect.setGeoRouting(true);
      const notes: string[] = [];
      architect.on("event", (ev) => {
        if (ev.type === "architect.note") notes.push(String(ev.data.text));
      });
      const run = await architect.run("Note", { autonomy: "rehearsal" });
      expect(readGeoSettings(path.join(dir, "data", "settings.json")).geoRouting).toBe(true);
      expect(run.actions[0]?.geo).toContain("geo ads.example.com: categories example, ads");
      expect(run.actions[0]?.geo).toContain("geo 203.0.113.10: country ZZ");
      expect(run.actions[0]?.output).toContain("categories example, ads");
      expect(notes[0]).toContain("country ZZ");
      const again = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
      expect(again.geoRouting).toBe(true);
      expect(again.geoRoutingEffective).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("serves the settings toggle, default off", async () => {
    delete process.env.INFINITUM_GEO_ENABLED;
    const dir = await mkdtemp(path.join(tmpdir(), "architect-geo-"));
    const ws = new WorkspaceInstrument(path.join(dir, "ws"));
    const architect = new Architect({
      brain: new ScriptedBrain({ summary: "x", permissions: [], startUrl: null, steps: [], successCriteria: [] }, []),
      instruments: [ws],
      dataDir: path.join(dir, "data"),
    });
    const server = createArchitectServer({ architect, token: "secret" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const headers = { authorization: "Bearer secret", "content-type": "application/json" };
      const off = await fetch(`http://127.0.0.1:${port}/v1/settings`, { headers }).then((r) => r.json());
      expect(off).toEqual({ geoRouting: false, effective: false });
      const on = await fetch(`http://127.0.0.1:${port}/v1/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ geoRouting: true }),
      }).then((r) => r.json());
      expect(on).toEqual({ geoRouting: true, effective: true });
      const bad = await fetch(`http://127.0.0.1:${port}/v1/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ geoRouting: "yes" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a missing dataset without changing the decision kind", () => {
    const hook = new GeoHook({ datasetDir: path.join(tmpdir(), "missing-geo-datasets"), env: { INFINITUM_GEO_ENABLED: "1" } });
    expect(hook.noteFor({ url: "https://example.com/a" })).toBe("geo example.com: dataset unavailable");
    expect(hook.noteFor({ path: "hello.txt" })).toBeUndefined();
  });
});

describe("geo fetch", () => {
  it("parses an official sha256sum line and stops when the bytes differ", () => {
    expect(parseSha256Sum("eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2  geoip.dat\n", "geoip.dat")).toBe(
      "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2",
    );
    expect(parseSha256Sum("dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2  dlc.dat\n", "dlc.dat")).toBe(
      "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2",
    );
    expect(() => parseSha256Sum("abc  other.dat\n", "geoip.dat")).toThrow(/no hash/);
    expect(() =>
      assertChecksum({
        name: "geoip.dat",
        asset: "geoip.dat",
        lockHash: "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2",
        officialText: "0000000000000000000000000000000000000000000000000000000000000000  geoip.dat\n",
        bytes: new Uint8Array(),
      }),
    ).toThrow(/checksum mismatch for geoip\.dat: lockfile/);
    const bytes = new TextEncoder().encode("synthetic");
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect(() =>
      assertChecksum({
        name: "geosite.dat",
        asset: "dlc.dat",
        lockHash: hash,
        officialText: `${hash}  dlc.dat\n`,
        bytes: new TextEncoder().encode("tampered"),
      }),
    ).toThrow(/downloaded/);
    expect(assertChecksum({ name: "geosite.dat", asset: "dlc.dat", lockHash: hash, officialText: `${hash}  dlc.dat\n`, bytes })).toBe(hash);
  });

  it("keeps the pinned v2fly hashes and refuses any other project", async () => {
    const lock = JSON.parse(await readFile(path.resolve("data/geo.lock.json"), "utf8"));
    expect(lock.sets.map((s: { name: string; sha256: string; asset: string }) => [s.name, s.asset, s.sha256])).toEqual([
      ["geoip.dat", "geoip.dat", "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2"],
      ["geosite.dat", "dlc.dat", "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2"],
    ]);
    const dir = await mkdtemp(path.join(tmpdir(), "architect-geo-fetch-"));
    try {
      await expect(fetchGeoSets({
        destDir: dir,
        lock: { sets: [{ name: "geoip.dat", project: "Loyalsoldier/geoip", asset: "geoip.dat", url: "https://example.test/a", sha256Url: "https://example.test/a.sum", sha256: "aa", tag: "x" }] },
        fetchImpl: async () => { throw new Error("should not download"); },
      })).rejects.toThrow(/refusing/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes a file only after the official sum matches", async () => {
    const bytes = new TextEncoder().encode("tiny-dat");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const dir = await mkdtemp(path.join(tmpdir(), "architect-geo-fetch-"));
    const files = new Map<string, Uint8Array>([
      ["https://example.test/sum", new TextEncoder().encode(`${hash}  geoip.dat\n`)],
      ["https://example.test/geoip.dat", bytes],
    ]);
    try {
      await fetchGeoSets({
        destDir: dir,
        lock: {
          sets: [{
            name: "geoip.dat",
            project: "v2fly/geoip",
            tag: "test",
            asset: "geoip.dat",
            url: "https://example.test/geoip.dat",
            sha256Url: "https://example.test/sum",
            sha256: hash,
            license: "CC-BY-SA-4.0",
          }],
        },
        fetchImpl: async (url) => {
          const body = files.get(String(url));
          if (!body) return new Response("missing", { status: 404 });
          return new Response(body);
        },
        log: () => {},
      });
      expect(new Uint8Array(await readFile(path.join(dir, "geoip.dat")))).toEqual(bytes);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
