/**
 * Cumulus ID on the Architect API.
 *
 * People sign in with Cumulus ID (id.cumuluscloud.app) and call /v1 with that token as a Bearer.
 * The server checks it with the issuer (GET /api/id/userinfo) and admits the people listed in
 * ARCHITECT_CID_OWNERS (Cumulus ID, username, handle or email, comma separated). ARCHITECT_API_TOKEN
 * stays for machines (scripts, MCP, the desktop app's own local server), never for people.
 *
 * CID_ISSUER points at another issuer, e.g. a mirror reachable from Russia without a VPN.
 */
export const DEFAULT_CID_ISSUER = "https://id.cumuluscloud.app";
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

const TOKEN = /^[A-Za-z0-9._~+/=-]{16,8000}$/;

async function hash(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks a token with the issuer. Answers are cached briefly (by the token's hash, never the
 * token) so a busy Podium does not ask the issuer on every poll; a revoked session stops working
 * within `ttlMs`.
 */
export function createCidVerifier(opts: { issuer?: string; fetch?: typeof fetch; ttlMs?: number; max?: number } = {}): CidVerifier {
  const issuer = (opts.issuer ?? DEFAULT_CID_ISSUER).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const ttl = opts.ttlMs ?? 60_000;
  const max = opts.max ?? 500;
  const cache = new Map<string, { profile: CidProfile | null; until: number }>();
  return async (token) => {
    if (!TOKEN.test(token)) return null;
    const key = await hash(token);
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.profile;
    let profile: CidProfile | null = null;
    try {
      const r = await doFetch(`${issuer}/api/id/userinfo`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      if (r.ok) {
        const p = (await r.json()) as Record<string, unknown>;
        if (typeof p.cid === "string" && p.cid) {
          profile = {
            cid: p.cid,
            username: typeof p.username === "string" ? p.username : undefined,
            handle: typeof p.handle === "string" ? p.handle : undefined,
            email: typeof p.email === "string" ? p.email : undefined,
            name: typeof p.name === "string" ? p.name : undefined,
          };
        }
      } else if (r.status >= 500) {
        throw new Error(`Cumulus ID answered ${r.status}`);
      }
    } catch (err) {
      // The issuer is unreachable: don't cache, and say so instead of "not signed in".
      throw new CidUnavailable(err instanceof Error ? err.message : String(err));
    }
    if (cache.size >= max) cache.delete(cache.keys().next().value as string);
    cache.set(key, { profile, until: Date.now() + ttl });
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
