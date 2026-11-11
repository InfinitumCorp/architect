import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Architect } from "../src/architect.js";
import { checkAccess, cidIssuer, cidOwners, createCidVerifier, isCidOwner, presentedToken, type CidVerifier } from "../src/cid.js";
import { createArchitectServer } from "../src/server.js";
import { ScriptedBrain } from "./helpers.js";

const OWNER = "cid-token-of-the-owner-0123456789";
const STRANGER = "cid-token-of-a-stranger-0123456789";
const verify: CidVerifier = async (t) =>
  t === OWNER ? { cid: "C123", username: "william", email: "w@example.com" } : t === STRANGER ? { cid: "C999", username: "someone" } : null;
const same = (a: string, b: string) => a === b;

describe("Cumulus ID access", () => {
  it("reads owners and the issuer from the environment", () => {
    expect(cidOwners(" William, C123 ,,")).toEqual(["william", "c123"]);
    expect(cidOwners(undefined)).toEqual([]);
    expect(cidIssuer({})).toBe("https://id.cumuluscloud.app");
    expect(cidIssuer({ CID_ISSUER: "https://ru.id.example/" })).toBe("https://ru.id.example");
    expect(cidIssuer({ CID_ISSUER: "http://plain.example" })).toBe("https://id.cumuluscloud.app");
  });

  it("matches owners by cid, username, handle or email", () => {
    expect(isCidOwner({ cid: "C1", email: "A@B.co" }, ["a@b.co"])).toBe(true);
    expect(isCidOwner({ cid: "C1" }, ["c2"])).toBe(false);
    expect(isCidOwner(null, ["c1"])).toBe(false);
  });

  it("admits the machine token and owner Cumulus IDs, and nobody else", async () => {
    const opts = { apiToken: "machine", owners: ["william"], verify, tokenMatches: same };
    expect(await checkAccess("machine", opts)).toMatchObject({ ok: true, by: "token" });
    expect(await checkAccess(OWNER, opts)).toMatchObject({ ok: true, by: "cid", profile: { cid: "C123" } });
    expect(await checkAccess(STRANGER, opts)).toMatchObject({ ok: false, status: 403 });
    expect(await checkAccess("nonsense", opts)).toMatchObject({ ok: false, status: 401 });
    expect(await checkAccess("", opts)).toMatchObject({ ok: false, status: 401 });
  });

  it("stays closed (hosted) or open (local) with nothing configured", async () => {
    expect(await checkAccess("", { owners: [], verify, tokenMatches: same })).toMatchObject({ ok: false, status: 503 });
    expect(await checkAccess("", { owners: [], verify, tokenMatches: same, open: true })).toMatchObject({ ok: true, by: "open" });
  });

  it("says when the issuer can't be reached", async () => {
    const down: CidVerifier = async () => {
      throw new Error("down");
    };
    expect(await checkAccess(OWNER, { owners: ["william"], verify: down, tokenMatches: same })).toMatchObject({ ok: false, status: 502 });
  });

  it("reads the bearer from the header, else ?token=", () => {
    const u = new URL("https://x/v1/runs?token=q");
    expect(presentedToken("Bearer h", u)).toBe("h");
    expect(presentedToken(undefined, u)).toBe("q");
  });

  it("asks the issuer's userinfo once per token within the cache window", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${(init?.headers as Record<string, string>).authorization}`);
      return new Response(JSON.stringify({ cid: "C123", username: "william" }), { status: 200 });
    }) as unknown as typeof fetch;
    const v = createCidVerifier({ issuer: "https://id.example/", fetch: fake });
    expect(await v(OWNER)).toMatchObject({ cid: "C123" });
    expect(await v(OWNER)).toMatchObject({ cid: "C123" });
    expect(calls).toEqual([`https://id.example/api/id/userinfo Bearer ${OWNER}`]);
    expect(await v("bad token with spaces")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("treats a 401 from the issuer as signed out and a 5xx as unavailable", async () => {
    const status = (s: number) => (async () => new Response("{}", { status: s })) as unknown as typeof fetch;
    expect(await createCidVerifier({ fetch: status(401) })(OWNER)).toBeNull();
    await expect(createCidVerifier({ fetch: status(503) })(OWNER)).rejects.toThrow();
  });
});

describe("architect serve with Cumulus ID owners", () => {
  let dir: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "architect-cid-"));
    const architect = new Architect({ brain: new ScriptedBrain({} as never, []), instruments: [], dataDir: path.join(dir, "data") });
    server = createArchitectServer({ architect, cidOwners: ["william"], cidVerify: verify });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const get = (token?: string) => fetch(`${base}/v1/runs`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  it("needs a signed-in owner for /v1", async () => {
    expect((await get()).status).toBe(401);
    expect((await get(STRANGER)).status).toBe(403);
    expect((await get(OWNER)).status).toBe(200);
    expect((await fetch(`${base}/v1/runs?token=${OWNER}`)).status).toBe(200);
  });

  it("serves the sign-in return page", async () => {
    const r = await fetch(`${base}/cid-return.html`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("architect://");
  });
});
