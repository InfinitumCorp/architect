// Cumulus ID for the extension. People sign in with Cumulus ID (id.cumuluscloud.app), never with a
// pasted token: chrome.identity opens the Cumulus ID page (OAuth 2.0 code + PKCE S256), which comes
// back to https://<extension-id>.chromiumapp.org/cid with a one-time code, traded here for a session.
// The session (token, profile, expiry) stays in chrome.storage.local in this profile.

export const CID_ISSUER = "https://id.cumuluscloud.app";
export const CID_CLIENT = "architect";
const KEY = "cid";

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));

/** The Cumulus ID issuer: a mirror (e.g. reachable from Russia without a VPN) can be set in Options. */
export async function issuer() {
  const { cidIssuer = "" } = await chrome.storage.local.get("cidIssuer");
  return (/^https:\/\//.test(cidIssuer) ? cidIssuer : CID_ISSUER).replace(/\/+$/, "");
}

/** The signed-in session, or null when signed out or expired. */
export async function session() {
  const { [KEY]: s } = await chrome.storage.local.get(KEY);
  if (s && s.token && s.until > Date.now() + 30_000) return s;
  if (s) await chrome.storage.local.remove(KEY);
  return null;
}

/** Signs in (or, with create, opens Cumulus ID's "create" page first) and returns the session. */
export async function signIn({ create = false, fetchImpl = globalThis.fetch } = {}) {
  const base = await issuer();
  const verifier = random(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = random(16);
  const redirect = chrome.identity.getRedirectURL("cid");
  const url = new URL("/api/id/authorize", base);
  url.search = new URLSearchParams({
    client_id: CID_CLIENT,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(create ? { prompt: "create" } : {}),
  }).toString();
  const back = new URL(await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true }));
  if (back.searchParams.get("state") !== state) throw new Error("That sign-in didn't match. Please try again.");
  const code = back.searchParams.get("code");
  if (!code) throw new Error(back.searchParams.get("error") || "Sign-in was cancelled.");
  const res = await fetchImpl(new URL("/api/id/token", base), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, client_id: CID_CLIENT, redirect_uri: redirect }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error || `Cumulus ID answered ${res.status}.`);
  const s = { token: data.access_token, profile: data.profile || null, until: Date.now() + Number(data.expires_in || 3600) * 1000 };
  await chrome.storage.local.set({ [KEY]: s });
  return s;
}

export async function signOut({ fetchImpl = globalThis.fetch } = {}) {
  const s = await session();
  await chrome.storage.local.remove(KEY);
  if (s) await fetchImpl(new URL("/api/id/signout", await issuer()), { method: "POST", headers: { authorization: `Bearer ${s.token}` } }).catch(() => {});
}

export const who = (s) => (s && s.profile && (s.profile.email || s.profile.username)) || "";
