// Cumulus://ID for the extension. People sign in with Cumulus://ID, never with a pasted token:
// chrome.identity opens the Cumulus://ID page (OpenID Connect authorization code + PKCE S256 +
// nonce, public client "architect"), which comes back to https://<extension-id>.chromiumapp.org/cid
// with a one-time code, traded here for tokens. The ID token is verified against the issuer's JWKS
// (ES256 signature, iss, aud, exp, nonce) before the session is kept; the person is keyed by its
// `sub` (the cid). The session (access token, profile, expiry) stays in chrome.storage.local.

export const CID_ISSUER = "https://id.cumuluscloud.app/realms/cumulus";
export const CID_CLIENT = "architect";
const KEY = "cid";

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const fromB64url = (text) => {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const json64 = (text) => JSON.parse(new TextDecoder().decode(fromB64url(text)));

/** The Cumulus://ID issuer: a mirror can be set in Options. */
export async function issuer() {
  const { cidIssuer = "" } = await chrome.storage.local.get("cidIssuer");
  return (/^https:\/\//.test(cidIssuer) ? cidIssuer : CID_ISSUER).replace(/\/+$/, "");
}

const oidc = (base) => `${base}/protocol/openid-connect`;

/** The signed-in session, or null when signed out or expired. */
export async function session() {
  const { [KEY]: s } = await chrome.storage.local.get(KEY);
  if (s && s.token && s.until > Date.now() + 30_000) return s;
  if (s) await chrome.storage.local.remove(KEY);
  return null;
}

/**
 * Verify a Cumulus://ID ID token: ES256 signature against the issuer's JWKS, then iss, aud
 * (this client), exp and nonce. Returns its claims or throws.
 */
export async function verifyIdToken(idToken, { issuer: iss, nonce, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Cumulus ID sent no ID token.");
  const header = json64(parts[0]);
  const claims = json64(parts[1]);
  if (header.alg !== "ES256" || String(header.typ || "JWT").toLowerCase() === "at+jwt") throw new Error("Cumulus ID sent an unexpected token.");
  const res = await fetchImpl(new URL(`${oidc(iss)}/certs`), { headers: { accept: "application/json" } });
  const { keys = [] } = await res.json().catch(() => ({}));
  const jwk = keys.find((k) => k && k.kty === "EC" && k.crv === "P-256" && (!header.kid || k.kid === header.kid));
  if (!jwk) throw new Error("Cumulus ID's signing key was not found.");
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  const seconds = Math.floor(now / 1000);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !ok ||
    claims.iss !== iss ||
    !aud.includes(CID_CLIENT) ||
    (aud.length > 1 && claims.azp !== CID_CLIENT) ||
    typeof claims.exp !== "number" ||
    claims.exp + 60 <= seconds ||
    claims.nonce !== nonce ||
    typeof claims.sub !== "string" ||
    !claims.sub
  ) {
    throw new Error("That sign-in couldn't be verified. Please try again.");
  }
  return claims;
}

/** Signs in (or, with create, opens Cumulus://ID's "create" page first) and returns the session. */
export async function signIn({ create = false, fetchImpl = globalThis.fetch } = {}) {
  const base = await issuer();
  const verifier = random(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = random(16);
  const nonce = random(16);
  const redirect = chrome.identity.getRedirectURL("cid");
  const url = new URL(`${oidc(base)}/auth`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CID_CLIENT,
    redirect_uri: redirect,
    scope: "openid profile email",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
    ...(create ? { prompt: "create" } : {}),
  }).toString();
  const back = new URL(await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true }));
  if (back.searchParams.get("state") !== state) throw new Error("That sign-in didn't match. Please try again.");
  const code = back.searchParams.get("code");
  if (!code) throw new Error(back.searchParams.get("error") || "Sign-in was cancelled.");
  const res = await fetchImpl(new URL(`${oidc(base)}/token`), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: CID_CLIENT, redirect_uri: redirect }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || `Cumulus ID answered ${res.status}.`);
  const claims = await verifyIdToken(data.id_token, { issuer: base, nonce, fetchImpl });
  const profile = {
    cid: claims.sub,
    username: claims.preferred_username || claims.username || undefined,
    email: claims.email || undefined,
    name: claims.name || undefined,
  };
  const s = { token: data.access_token, idToken: data.id_token, profile, until: Date.now() + Number(data.expires_in || 3600) * 1000 };
  await chrome.storage.local.set({ [KEY]: s });
  return s;
}

/** Drops the session here, then revokes it at Cumulus://ID so it leaves the person's session list. */
export async function signOut({ fetchImpl = globalThis.fetch } = {}) {
  const s = await session();
  await chrome.storage.local.remove(KEY);
  if (s) {
    await fetchImpl(new URL(`${oidc(await issuer())}/revoke`), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: s.token, client_id: CID_CLIENT }).toString(),
    }).catch(() => {});
  }
}

export const who = (s) => (s && s.profile && (s.profile.email || s.profile.username)) || "";
