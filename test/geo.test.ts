import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Architect } from "../src/architect.js";
import { GeoDataError, geoFromBytes, parseIp } from "../src/geo/dat.js";
import { annotateDestination, annotationFor, geoEnabled, loadGeoDir, resetGeoCache } from "../src/geo/hook.js";
import type { Instrument } from "../src/instruments/types.js";
import type { ScoreDraft } from "../src/brain.js";
import { ScriptedBrain, toolUse } from "./helpers.js";
import { syntheticGeoIp, syntheticGeoSite } from "./fixtures/geo/build.mjs";

const root = path.resolve(import.meta.dirname, "..");
const fixtureIp = readFileSync(path.join(root, "test/fixtures/geo/geoip.dat"));
const fixtureSite = readFileSync(path.join(root, "test/fixtures/geo/geosite.dat"));

const GEOIP_SHA = "eedb24b3b9fcba27e06b92c0428dab90d9496083091ae4cf39e11387fd99d0e2";
const GEOSITE_SHA = "dc4192dd1b644a38276ed06136d26e729fa674d25785adb38c87e040e92376b2";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("synthetic geo fixtures", () => {
  const data = geoFromBytes(fixtureIp, fixtureSite);

  it("matches the encoder and stays tiny", () => {
    expect(Buffer.from(syntheticGeoIp()).equals(fixtureIp)).toBe(true);
    expect(Buffer.from(syntheticGeoSite()).equals(fixtureSite)).toBe(true);
    expect(fixtureIp.length).toBeLessThan(500);
    expect(fixtureSite.length).toBeLessThan(500);
  });

  it("maps an IP to the most specific two-letter country", () => {
    expect(data.countryOf("1.2.3.4")).toBe("us");
    expect(data.countryOf("1.2.3.255")).toBe("us");
    expect(data.countryOf("1.2.4.1")).toBe("cn");
    expect(data.countryOf("8.8.8.8")).toBe("us");
    expect(data.countryOf("8.8.8.9")).toBeNull();
    expect(data.countryOf("10.1.2.9")).toBe("cn");
    expect(data.countryOf("10.1.3.1")).toBe("us");
    expect(data.countryOf("10.9.0.1")).toBeNull();
    expect(data.countryOf("9.9.9.9")).toBeNull();
    expect(data.countryOf("::ffff:1.2.3.4")).toBe("us");
    expect(data.countryOf("2001:db8::1")).toBe("de");
    expect(data.countryOf("2001:db8:1::1")).toBe("de");
    expect(data.countryOf("2001:db9::1")).toBeNull();
    expect(data.countryOf("not-an-ip")).toBeNull();
  });

  it("maps a domain to geosite categories", () => {
    expect(data.categoriesOf("www.google.com")).toEqual(["google"]);
    expect(data.categoriesOf("Google.COM.")).toEqual(["google"]);
    expect(data.categoriesOf("mail.google.com")).toEqual(["google"]);
    expect(data.categoriesOf("notgoogle.com")).toEqual([]);
    expect(data.categoriesOf("google.com.evil.test")).toEqual([]);
    expect(data.categoriesOf("ads.example.com")).toEqual(["ads"]);
    expect(data.categoriesOf("x.doubleclick.net")).toEqual(["ads"]);
    expect(data.categoriesOf("a.baidu.com")).toEqual(["cn"]);
    expect(data.categoriesOf("baidu.com.evil.test")).toEqual([]);
    expect(data.categoriesOf("1.2.3.4")).toEqual([]);
  });

  it("rejects a truncated message", () => {
    expect(() => geoFromBytes(fixtureIp.subarray(0, 8), fixtureSite)).toThrow(GeoDataError);
  });

  it("parses compressed IPv6", () => {
    expect(parseIp("::1")?.v6?.[15]).toBe(1);
    expect(parseIp("2001:db8::1")?.v6?.[0]).toBe(0x20);
  });
});

describe("geo directory loader", () => {
  let dir: string;
  afterEach(async () => {
    resetGeoCache();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function writeSet(ipHash: string, siteHash: string, ip = fixtureIp, site = fixtureSite) {
    dir = await mkdtemp(path.join(tmpdir(), "architect-geo-"));
    await writeFile(path.join(dir, "geoip.dat"), ip);
    await writeFile(path.join(dir, "geosite.dat"), site);
    await writeFile(
      path.join(dir, "geo.lock.json"),
      JSON.stringify({
        datasets: [
          { id: "geoip", file: "geoip.dat", sha256: ipHash },
          { id: "geosite", file: "geosite.dat", sha256: siteHash },
        ],
      }),
    );
    return dir;
  }

  it("loads when the lockfile checksums match", async () => {
    await writeSet(sha256(fixtureIp), sha256(fixtureSite));
    expect(loadGeoDir(dir).countryOf("8.8.8.8")).toBe("us");
  });

  it("fails when a file checksum does not match the lockfile", async () => {
    await writeSet(sha256(fixtureIp), "a".repeat(64));
    expect(() => loadGeoDir(dir)).toThrow(/checksum does not match/);
  });
});

describe("INFINITUM_GEO_ENABLED", () => {
  afterEach(() => resetGeoCache());

  it("stays off unless the flag is explicitly on", () => {
    expect(geoEnabled({})).toBe(false);
    expect(geoEnabled({ INFINITUM_GEO_ENABLED: "" })).toBe(false);
    expect(geoEnabled({ INFINITUM_GEO_ENABLED: "0" })).toBe(false);
    expect(geoEnabled({ INFINITUM_GEO_ENABLED: "false" })).toBe(false);
    expect(geoEnabled({ INFINITUM_GEO_ENABLED: "1" })).toBe(true);
    expect(geoEnabled({ INFINITUM_GEO_ENABLED: " yes " })).toBe(true);
    expect(annotateDestination({ url: "https://1.2.3.4/x" }, {})).toBeUndefined();
  });

  it("annotates from a directory and skips a checksum mismatch without throwing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "architect-geo-"));
    try {
      await writeFile(path.join(dir, "geoip.dat"), fixtureIp);
      await writeFile(path.join(dir, "geosite.dat"), fixtureSite);
      await writeFile(
        path.join(dir, "geo.lock.json"),
        JSON.stringify({
          datasets: [
            { id: "geoip", file: "geoip.dat", sha256: sha256(fixtureIp) },
            { id: "geosite", file: "geosite.dat", sha256: sha256(fixtureSite) },
          ],
        }),
      );
      const env = { INFINITUM_GEO_ENABLED: "on", INFINITUM_GEO_DIR: dir };
      expect(annotateDestination({ url: "https://www.google.com/search" }, env)).toEqual({ categories: ["google"] });
      expect(annotateDestination({ href: "http://10.1.2.9/a" }, env)).toEqual({ country: "cn" });
      expect(annotateDestination({ path: "https://1.2.3.4/secret" }, env)).toBeUndefined();

      const bad = await mkdtemp(path.join(tmpdir(), "architect-geo-bad-"));
      try {
        await writeFile(path.join(bad, "geoip.dat"), fixtureIp);
        await writeFile(path.join(bad, "geosite.dat"), fixtureSite);
        await writeFile(
          path.join(bad, "geo.lock.json"),
          JSON.stringify({
            datasets: [
              { id: "geoip", file: "geoip.dat", sha256: "b".repeat(64) },
              { id: "geosite", file: "geosite.dat", sha256: sha256(fixtureSite) },
            ],
          }),
        );
        const errors: string[] = [];
        const spy = console.error;
        console.error = (line: unknown) => errors.push(String(line));
        try {
          expect(annotateDestination({ url: "https://1.2.3.4/" }, { INFINITUM_GEO_ENABLED: "1", INFINITUM_GEO_DIR: bad })).toBeUndefined();
        } finally {
          console.error = spy;
        }
        expect(errors.join("\n")).toMatch(/checksum does not match/);
      } finally {
        await rm(bad, { recursive: true, force: true });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("action annotation", () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const probe: Instrument = {
    name: "probe",
    description: "probe",
    tools: [
      {
        name: "probe_url",
        description: "probe a url",
        input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
        permission: "http.read",
        risk: "read",
      },
    ],
    async execute() {
      return { text: "ok" };
    },
  };

  const draft = (): ScoreDraft => ({
    summary: "Look up a host",
    permissions: ["http.read"],
    startUrl: null,
    steps: [{ title: "Look", instruction: "Look up the host", instruments: ["probe"], checkpoint: false }],
    successCriteria: ["noted"],
  });

  async function run(url: string, geo: ReturnType<typeof geoFromBytes> | null | undefined) {
    dir = await mkdtemp(path.join(tmpdir(), "architect-geo-run-"));
    const brain = new ScriptedBrain(draft(), [
      () => [toolUse("probe_url", { url })],
      () => [toolUse("step_complete", { summary: "noted" })],
      () => [
        toolUse("submit_verdict", {
          passed: true,
          summary: "noted",
          criteria: [{ criterion: "noted", met: true, evidence: "ok" }],
        }),
      ],
    ]);
    const architect = new Architect({
      brain,
      instruments: [probe],
      dataDir: path.join(dir, "data"),
      ...(geo === undefined ? {} : { geo }),
    });
    return architect.run("Look up a host", { autonomy: "accompaniment" });
  }

  it("leaves the action unchanged when geo is off", async () => {
    const runOff = await run("https://10.1.2.9/a", undefined);
    expect(runOff.actions[0]?.outcome).toBe("executed");
    expect(runOff.actions[0]?.output).toBe("ok");
    expect(runOff.actions[0]?.geo).toBeUndefined();
  });

  it("records country and category on the action without rewriting the tool output", async () => {
    const data = geoFromBytes(fixtureIp, fixtureSite);
    const ipRun = await run("https://10.1.2.9/a", data);
    expect(ipRun.actions[0]?.output).toBe("ok");
    expect(ipRun.actions[0]?.geo).toEqual({ country: "cn" });
    expect(annotationFor(data, { url: "https://mail.google.com/mail" })).toEqual({ categories: ["google"] });
    const forcedOff = await run("https://10.1.2.9/a", null);
    expect(forcedOff.actions[0]?.geo).toBeUndefined();
  });
});

describe("fetch script", () => {
  const script = path.join(root, "scripts/fetch-geo.mjs");

  it("pins the official v2fly checksums and no other publisher", () => {
    const lock = JSON.parse(readFileSync(path.join(root, "data/geo/geo.lock.json"), "utf8")) as {
      datasets: { id: string; file: string; sha256: string; url: string; sha256Url: string; tag: string }[];
    };
    expect(lock.datasets.map((item) => [item.id, item.file, item.sha256, item.tag])).toEqual([
      ["geoip", "geoip.dat", GEOIP_SHA, "202611080027"],
      ["geosite", "geosite.dat", GEOSITE_SHA, "20261108011013"],
    ]);
    expect(lock.datasets[0]?.url).toBe("https://github.com/v2fly/geoip/releases/download/202611080027/geoip.dat");
    expect(lock.datasets[1]?.url).toContain("/v2fly/domain-list-community/releases/download/20261108011013/dlc.dat");
    expect(lock.datasets[1]?.sha256Url).toContain("dlc.dat.sha256sum");
    expect(JSON.stringify(lock)).not.toMatch(/loyalsoldier|sing-box|sagernet/i);
  });

  function serve(files: Record<string, Buffer | string>) {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      const name = (req.url ?? "/").slice(1);
      hits.push(name);
      const body = files[name];
      if (body === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end(body);
    });
    return new Promise<{ url: string; hits: string[]; close: () => Promise<void> }>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("no port");
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          hits,
          close: () => new Promise((done) => server.close(() => done())),
        });
      });
    });
  }

  function runFetch(args: string[]) {
    return new Promise<{ code: number; out: string }>((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        cwd: root,
        env: { ...process.env, INFINITUM_GEO_FETCH_TEST: "1" },
      });
      let out = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        out += String(chunk);
      });
      child.on("close", (code) => resolve({ code: code ?? 1, out }));
    });
  }

  it("writes both files when the official checksum matches", async () => {
    const ip = Buffer.from("geoip-bytes");
    const site = Buffer.from("geosite-bytes");
    const server = await serve({
      "geoip.dat": ip,
      "geoip.dat.sha256sum": `${sha256(ip)}  geoip.dat\n`,
      "dlc.dat": site,
      "dlc.dat.sha256sum": `${sha256(site)}  dlc.dat\n`,
    });
    const out = await mkdtemp(path.join(tmpdir(), "architect-geo-fetch-"));
    const lock = path.join(out, "geo.lock.json");
    try {
      await writeFile(
        lock,
        JSON.stringify({
          datasets: [
            {
              id: "geoip",
              file: "geoip.dat",
              url: `${server.url}/geoip.dat`,
              sha256Url: `${server.url}/geoip.dat.sha256sum`,
              sha256: sha256(ip),
            },
            {
              id: "geosite",
              file: "geosite.dat",
              asset: "dlc.dat",
              url: `${server.url}/dlc.dat`,
              sha256Url: `${server.url}/dlc.dat.sha256sum`,
              sha256: sha256(site),
            },
          ],
        }),
      );
      const result = await runFetch(["--lock", lock, "--out", out]);
      expect(result.code).toBe(0);
      expect(result.out).toContain(sha256(ip));
      expect(await readFile(path.join(out, "geoip.dat"))).toEqual(ip);
      expect(await readFile(path.join(out, "geosite.dat"))).toEqual(site);
    } finally {
      await server.close();
      await rm(out, { recursive: true, force: true });
    }
  });

  it("stops when the official checksum does not match the lockfile and writes nothing", async () => {
    const ip = Buffer.from("geoip-bytes");
    const server = await serve({
      "geoip.dat": ip,
      "geoip.dat.sha256sum": `${"c".repeat(64)}  geoip.dat\n`,
      "dlc.dat": Buffer.from("site"),
      "dlc.dat.sha256sum": `${"d".repeat(64)}  dlc.dat\n`,
    });
    const out = await mkdtemp(path.join(tmpdir(), "architect-geo-fetch-"));
    const lock = path.join(out, "geo.lock.json");
    try {
      await writeFile(
        lock,
        JSON.stringify({
          datasets: [
            { id: "geoip", file: "geoip.dat", url: `${server.url}/geoip.dat`, sha256Url: `${server.url}/geoip.dat.sha256sum`, sha256: sha256(ip) },
            {
              id: "geosite",
              file: "geosite.dat",
              url: `${server.url}/dlc.dat`,
              sha256Url: `${server.url}/dlc.dat.sha256sum`,
              sha256: sha256(Buffer.from("site")),
            },
          ],
        }),
      );
      const result = await runFetch(["--lock", lock, "--out", out]);
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/does not match/);
      await expect(readFile(path.join(out, "geoip.dat"))).rejects.toThrow();
      await expect(readFile(path.join(out, "geosite.dat"))).rejects.toThrow();
    } finally {
      await server.close();
      await rm(out, { recursive: true, force: true });
    }
  });

  it("stops when the download does not match the official checksum", async () => {
    const claimed = sha256(Buffer.from("expected"));
    const server = await serve({
      "geoip.dat": Buffer.from("tampered"),
      "geoip.dat.sha256sum": `${claimed}  geoip.dat\n`,
      "dlc.dat": Buffer.from("site"),
      "dlc.dat.sha256sum": `${sha256(Buffer.from("site"))}  dlc.dat\n`,
    });
    const out = await mkdtemp(path.join(tmpdir(), "architect-geo-fetch-"));
    const lock = path.join(out, "geo.lock.json");
    try {
      await writeFile(
        lock,
        JSON.stringify({
          datasets: [
            { id: "geoip", file: "geoip.dat", url: `${server.url}/geoip.dat`, sha256Url: `${server.url}/geoip.dat.sha256sum`, sha256: claimed },
            {
              id: "geosite",
              file: "geosite.dat",
              url: `${server.url}/dlc.dat`,
              sha256Url: `${server.url}/dlc.dat.sha256sum`,
              sha256: sha256(Buffer.from("site")),
            },
          ],
        }),
      );
      const result = await runFetch(["--lock", lock, "--out", out]);
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/downloaded checksum does not match/);
      await expect(readFile(path.join(out, "geoip.dat"))).rejects.toThrow();
    } finally {
      await server.close();
      await rm(out, { recursive: true, force: true });
    }
  });

  it("refuses a non-v2fly publisher before downloading", async () => {
    const server = await serve({});
    const out = await mkdtemp(path.join(tmpdir(), "architect-geo-fetch-"));
    const lock = path.join(out, "geo.lock.json");
    try {
      await writeFile(
        lock,
        JSON.stringify({
          datasets: [
            {
              id: "geoip",
              file: "geoip.dat",
              url: `${server.url}/Loyalsoldier/geoip.dat`,
              sha256Url: `${server.url}/geoip.dat.sha256sum`,
              sha256: "e".repeat(64),
            },
            {
              id: "geosite",
              file: "geosite.dat",
              url: `${server.url}/dlc.dat`,
              sha256Url: `${server.url}/dlc.dat.sha256sum`,
              sha256: "f".repeat(64),
            },
          ],
        }),
      );
      const result = await runFetch(["--lock", lock, "--out", out]);
      expect(result.code).not.toBe(0);
      expect(result.out).toMatch(/only v2fly/);
      expect(server.hits).toEqual([]);
    } finally {
      await server.close();
      await rm(out, { recursive: true, force: true });
    }
  });
});
