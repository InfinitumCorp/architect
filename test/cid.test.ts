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

const ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
const b64u = (v: unknown) => Buffer.from(typeof v === "string" ? v : new Uint8Array(v as ArrayBuffer)).toString("base64url");
async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1", use: "sig", alg: "ES256" };
  const sign = async (over: Record<string, unknown> = {}, typ = "at+jwt") => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { iss: ISSUER, aud: "architect", sub: "cid_7c1e", client_id: "architect", sid: "s1", iat: now, exp: now + 600, ...over };
    const h = b64u(JSON.stringify({ alg: "ES256", typ, kid: "k1" }));
    const p = b64u(JSON.stringify(claims));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64u(sig)}`;
  };
  return { jwk, sign };
}

describe("Cumulus ID access", () => {
  it("reads owners and the issuer from the environment", () => {
    expect(cidOwners(" William, C123 ,,")).toEqual(["william", "c123"]);
    expect(cidOwners(undefined)).toEqual([]);
    expect(cidIssuer({})).toBe("https://id.cumuluscloud.app/realms/cumulus");
    expect(cidIssuer({ CID_ISSUER: "https://ru.id.example/realms/cumulus/" })).toBe("https://ru.id.example/realms/cumulus");
    expect(cidIssuer({ CID_ISSUER: "http://plain.example" })).toBe("https://id.cumuluscloud.app/realms/cumulus");
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

  it("verifies the access token against the JWKS, then asks userinfo once per token", async () => {
    const { jwk, sign } = await keys();
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${(init?.headers as Record<string, string>).authorization ?? ""}`.trim());
      if (url.endsWith("/certs")) return new Response(JSON.stringify({ keys: [jwk] }));
      return new Response(JSON.stringify({ sub: "cid_7c1e", preferred_username: "william", email: "w@cumuluscloud.app" }), { status: 200 });
    }) as unknown as typeof fetch;
    const v = createCidVerifier({ issuer: `${ISSUER}/`, fetch: fake });
    const token = await sign();
    expect(await v(token)).toEqual({ cid: "cid_7c1e", username: "william", email: "w@cumuluscloud.app", handle: undefined, name: undefined });
    expect(await v(token)).toMatchObject({ cid: "cid_7c1e" });
    expect(calls).toEqual([`${ISSUER}/protocol/openid-connect/certs`, `${ISSUER}/protocol/openid-connect/userinfo Bearer ${token}`]);
    expect(await v("bad token with spaces")).toBeNull();
    expect(await v(OWNER)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("refuses another issuer, client, type, key, expiry or subject without asking userinfo", async () => {
    const { jwk, sign } = await keys();
    let userinfo = 0;
    const fake = (async (url: string) => {
      if (url.endsWith("/certs")) return new Response(JSON.stringify({ keys: [jwk] }));
      userinfo++;
      return new Response(JSON.stringify({ sub: "cid_7c1e" }));
    }) as unknown as typeof fetch;
    const v = createCidVerifier({ fetch: fake });
    expect(await v(await sign({ iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_x" }))).toBeNull();
    expect(await v(await sign({ aud: "scalvs" }))).toBeNull();
    expect(await v(await sign({}, "JWT"))).toBeNull();
    expect(await v(await sign({ exp: Math.floor(Date.now() / 1000) - 3600 }))).toBeNull();
    expect(await v(await sign({ sub: "C123" }))).toBeNull();
    expect(await v(await (await keys()).sign())).toBeNull();
    expect(userinfo).toBe(0);
    const mismatch = createCidVerifier({
      fetch: (async (url: string) => new Response(JSON.stringify(url.endsWith("/certs") ? { keys: [jwk] } : { sub: "cid_other" }))) as unknown as typeof fetch,
    });
    expect(await mismatch(await sign())).toBeNull();
  });

  it("treats a 401 from the issuer as signed out and a 5xx as unavailable", async () => {
    const { jwk, sign } = await keys();
    const status = (s: number) =>
      (async (url: string) => (url.endsWith("/certs") ? new Response(JSON.stringify({ keys: [jwk] })) : new Response("{}", { status: s }))) as unknown as typeof fetch;
    const token = await sign();
    expect(await createCidVerifier({ fetch: status(401) })(token)).toBeNull();
    await expect(createCidVerifier({ fetch: status(503) })(token)).rejects.toThrow();
    const noKeys = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    await expect(createCidVerifier({ fetch: noKeys })(token)).rejects.toThrow();
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
