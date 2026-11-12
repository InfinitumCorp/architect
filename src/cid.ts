/**
 * Cumulus://ID on the Architect API.
 *
 * People sign in with Cumulus://ID (OIDC issuer https://id.cumuluscloud.app/realms/cumulus) and
 * call /v1 with its access token as a Bearer. The server verifies the token offline against the
 * issuer's JWKS (ES256, `typ: at+jwt`, `iss`, `aud` = "architect", `exp`), then asks the issuer's
 * userinfo whether the session is still live (sign-out takes effect at once) and that it names the
 * same `sub`. The person is keyed by `sub` (the cid). It admits the people listed in
 * ARCHITECT_CID_OWNERS (cid, username, handle or email, comma separated). ARCHITECT_API_TOKEN
 * stays for machines (scripts, MCP, the desktop app's own local server), never for people.
 *
 * CID_ISSUER points at another issuer, e.g. a mirror.
 */
export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
export const CID_CLIENT = "architect";

export interface CidProfile {
  cid: string;
  username?: string;
  handle?: string;
  email?: string;
  name?: string;
}

export type CidVerifier = (token: string) => Promise<CidProfile | null>;

export const cidIssuer = (env: Record<string, unknown>): string =>
  (typeof env.CID_ISSUER === "string" && /^https:\/\//.test(env.CID_ISSUER) ? env.CID_ISSUER : DEFAULT_CID_ISSUER).replace(/\/+$/, "");

/** ARCHITECT_CID_OWNERS: who may use this server, lower-cased. Empty means nobody signs in with Cumulus ID. */
export const cidOwners = (value: unknown): string[] =>
  typeof value === "string" ? value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : [];

export function isCidOwner(profile: CidProfile | null, owners: readonly string[]): boolean {
  if (!profile) return false;
  const ids = [profile.cid, profile.username, profile.handle, profile.email].filter(Boolean).map((s) => String(s).toLowerCase());
  return owners.some((o) => ids.includes(o));
}

const JWT = /^[A-Za-z0-9_-]{2,4000}\.[A-Za-z0-9_-]{2,4000}\.[A-Za-z0-9_-]{2,400}$/;
const CID = /^cid_[A-Za-z0-9_-]{1,64}$/;

async function hash(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

const b64urlBytes = (text: string): Uint8Array<ArrayBuffer> => {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64urlJson = (text: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64urlBytes(text))) as Record<string, unknown>;

type Jwk = { kty?: string; crv?: string; x?: string; y?: string; kid?: string; use?: string };

/**
 * Verify a Cumulus://ID ES256 JWT against a JWKS: signature, `typ`, `iss`, `aud`, `exp`/`nbf`.
 * Returns the claims, or null when anything does not hold.
 */
export async function verifyCidJwt(
  token: string,
  opts: { issuer: string; audience: string; typ: "at+jwt" | "JWT"; keys: readonly Jwk[]; now?: number },
): Promise<Record<string, unknown> | null> {
  if (!JWT.test(token)) return null;
  const [h, p, sig] = token.split(".") as [string, string, string];
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = b64urlJson(h);
    claims = b64urlJson(p);
  } catch {
    return null;
  }
  if (header.alg !== "ES256" || String(header.typ ?? "JWT").toLowerCase() !== opts.typ.toLowerCase()) return null;
  const jwk = opts.keys.find((k) => k.kty === "EC" && k.crv === "P-256" && (!header.kid || k.kid === header.kid) && (!k.use || k.use === "sig"));
  if (!jwk?.x || !jwk.y) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
  } catch {
    return null;
  }
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = 60;
  if (claims.iss !== opts.issuer) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp + skew <= now) return null;
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) return null;
  if (typeof claims.sub !== "string" || !CID.test(claims.sub)) return null;
  return claims;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/**
 * Checks an access token: offline against the JWKS, then the issuer's userinfo. Answers are cached
 * briefly (by the token's hash, never the token) so a busy Podium does not ask the issuer on every
 * poll; a revoked session stops working within `ttlMs`.
 */
export function createCidVerifier(
  opts: { issuer?: string; audience?: string; fetch?: typeof fetch; ttlMs?: number; max?: number; now?: () => number } = {},
): CidVerifier {
  const issuer = (opts.issuer ?? DEFAULT_CID_ISSUER).replace(/\/+$/, "");
  const oidc = `${issuer}/protocol/openid-connect`;
  const audience = opts.audience ?? CID_CLIENT;
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? (() => Date.now());
  const ttl = opts.ttlMs ?? 60_000;
  const max = opts.max ?? 500;
  const cache = new Map<string, { profile: CidProfile | null; until: number }>();
  let jwks: { keys: Jwk[]; until: number } | null = null;
  const keys = async (): Promise<Jwk[]> => {
    if (jwks && jwks.until > now()) return jwks.keys;
    const r = await doFetch(`${oidc}/certs`, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`Cumulus ID JWKS answered ${r.status}`);
    const body = (await r.json()) as { keys?: unknown };
    jwks = { keys: Array.isArray(body.keys) ? (body.keys as Jwk[]) : [], until: now() + 10 * 60_000 };
    return jwks.keys;
  };
  return async (token) => {
    if (!JWT.test(token)) return null;
    const key = await hash(token);
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit.profile;
    let profile: CidProfile | null = null;
    try {
      const claims = await verifyCidJwt(token, { issuer, audience, typ: "at+jwt", keys: await keys(), now: now() });
      if (claims) {
        const r = await doFetch(`${oidc}/userinfo`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
        if (r.ok) {
          const p = (await r.json()) as Record<string, unknown>;
          if (p.sub === claims.sub) {
            profile = {
              cid: claims.sub as string,
              username: str(p.preferred_username) ?? str(p.username),
              handle: str(p.handle),
              email: str(p.email),
              name: str(p.name),
            };
          }
        } else if (r.status >= 500) {
          throw new Error(`Cumulus ID answered ${r.status}`);
        }
      }
    } catch (err) {
      // The issuer is unreachable: don't cache, and say so instead of "not signed in".
      throw new CidUnavailable(err instanceof Error ? err.message : String(err));
    }
    if (cache.size >= max) cache.delete(cache.keys().next().value as string);
    cache.set(key, { profile, until: now() + ttl });
    return profile;
  };
}

export class CidUnavailable extends Error {}

export type Access =
  | { ok: true; by: "token" | "cid" | "open"; profile?: CidProfile }
  | { ok: false; status: 401 | 403 | 502 | 503; error: string };

/**
 * Who may call /v1: the machine token, or a Cumulus ID listed as an owner.
 * `open` lets a local server with neither configured stay open (as `architect serve` always has).
 */
export async function checkAccess(
  given: string,
  opts: { apiToken?: string; owners: readonly string[]; verify: CidVerifier; tokenMatches: (given: string, token: string) => boolean | Promise<boolean>; open?: boolean },
): Promise<Access> {
  const { apiToken, owners, verify } = opts;
  if (!apiToken && !owners.length) {
    return opts.open ? { ok: true, by: "open" } : { ok: false, status: 503, error: "This server has no ARCHITECT_CID_OWNERS (or ARCHITECT_API_TOKEN) yet." };
  }
  if (!given) return { ok: false, status: 401, error: "Sign in with Cumulus ID." };
  if (apiToken && (await opts.tokenMatches(given, apiToken))) return { ok: true, by: "token" };
  if (!owners.length) return { ok: false, status: 401, error: "Sign in with Cumulus ID." };
  let profile: CidProfile | null;
  try {
    profile = await verify(given);
  } catch {
    return { ok: false, status: 502, error: "Cumulus ID can't be reached right now. Try again shortly." };
  }
  if (!profile) return { ok: false, status: 401, error: "Sign in with Cumulus ID." };
  if (!isCidOwner(profile, owners)) return { ok: false, status: 403, error: "This Cumulus ID doesn't have access to this Architect server." };
  return { ok: true, by: "cid", profile };
}

/** The bearer a request carries: Authorization header, else ?token= (EventSource and <img> can't set headers). */
export const presentedToken = (authorization: string | null | undefined, url: URL): string =>
  authorization?.replace(/^Bearer\s+/i, "").trim() || url.searchParams.get("token") || "";
