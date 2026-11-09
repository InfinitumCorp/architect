// :\ARCHITECT\ API client for the extension. No keys live here: the server sits
// behind Cloudflare Access (the browser's rchtch.app sign-in cookie is reused) and
// its own API token is pasted by the user into Options and kept in chrome.storage.

export const DEFAULT_BASE = "https://rchtch.app";
export const AUTONOMY = ["rehearsal", "accompaniment", "autopilot"];
export const REVIEW = ["agent_decides", "request_review", "always_proceed"];
export const FINAL = new Set(["succeeded", "failed", "rehearsed", "handed_off"]);
const MAX_GOAL = 8000;

/** Thrown for every failed call; `kind` tells the UI what to offer. */
export class ApiError extends Error {
  /** @param {"signin"|"token"|"server"|"network"|"http"} kind */
  constructor(kind, message, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/**
 * Turn a fetch Response into data or an ApiError.
 * Cloudflare Access answers an unsigned request with a redirect to its login page;
 * with redirect:"manual" that arrives as an opaque redirect (status 0).
 */
export async function readResponse(res) {
  if (res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400)) {
    throw new ApiError("signin", "Sign in to :\\ARCHITECT\\ at rchtch.app first.");
  }
  const type = res.headers.get("content-type") || "";
  if (!type.includes("application/json")) {
    // An Access login or block page served in place of the API.
    if (res.status === 200 || res.status === 401 || res.status === 403) {
      throw new ApiError("signin", "Sign in to :\\ARCHITECT\\ at rchtch.app first.", res.status);
    }
    throw new ApiError("http", `Unexpected response (${res.status}).`, res.status);
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) return data;
  const message = typeof data?.error === "string" ? data.error : `Request failed (${res.status}).`;
  if (res.status === 401) throw new ApiError("token", "Add your :\\ARCHITECT\\ API token in Options.", 401);
  if (res.status === 503 && /ARCHITECT_API_TOKEN/.test(message)) throw new ApiError("server", message, 503);
  throw new ApiError("http", message, res.status);
}

/** Validate and shape the body for POST /v1/runs. */
export function runRequest({ goal, autonomy, startUrl, review, sameSite } = {}) {
  const g = String(goal ?? "").trim();
  if (!g) throw new ApiError("http", "Write a goal first.");
  const body = {
    goal: g.slice(0, MAX_GOAL),
    autonomy: AUTONOMY.includes(autonomy) ? autonomy : "accompaniment",
  };
  const url = String(startUrl ?? "").trim();
  if (url) {
    if (!/^https?:\/\//i.test(url)) throw new ApiError("http", "The start URL must begin with http:// or https://.");
    body.startUrl = url;
    // "Stay on this site": the run may only reach the start URL's host (and its subdomains).
    if (sameSite) body.hosts = { allow: [new URL(url).hostname] };
  } else if (sameSite) {
    throw new ApiError("http", "Add a start URL to keep the run on one site.");
  }
  if (REVIEW.includes(review)) body.review = review;
  return body;
}

/** Goal text for the context-menu actions. */
export function draftFrom({ selection, pageUrl, pageTitle } = {}) {
  const text = String(selection ?? "").trim();
  if (text) {
    const source = pageUrl ? `\n\n(Selected on ${pageTitle ? `"${pageTitle}" ` : ""}${pageUrl})` : "";
    return { goal: text.slice(0, MAX_GOAL - source.length) + source, startUrl: pageUrl || "" };
  }
  return { goal: pageTitle ? `Work on this page: "${pageTitle}".` : "Work on this page.", startUrl: pageUrl || "" };
}

/** A small client; `fetchImpl` is injectable for tests. */
export function createClient({ base = DEFAULT_BASE, token = "", fetchImpl = globalThis.fetch } = {}) {
  const root = base.replace(/\/+$/, "");
  const call = async (path, { method = "GET", body } = {}) => {
    let res;
    try {
      res = await fetchImpl(root + path, {
        method,
        credentials: "include",
        redirect: "manual",
        cache: "no-store",
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError("network", "Cannot reach rchtch.app. Check your connection.");
    }
    return readResponse(res);
  };
  return {
    health: () => call("/healthz"),
    runs: (limit = 20) => call(`/v1/runs?limit=${limit}`),
    run: (id) => call(`/v1/runs/${encodeURIComponent(id)}`),
    start: (draft) => call("/v1/runs", { method: "POST", body: runRequest(draft) }),
    perform: (id) => call(`/v1/runs/${encodeURIComponent(id)}/perform`, { method: "POST", body: { by: "chrome-extension" } }),
    comment: (id, text, target = "score") => {
      const t = String(text ?? "").trim();
      if (!t) throw new ApiError("http", "Write a comment first.");
      return call(`/v1/runs/${encodeURIComponent(id)}/comments`, { method: "POST", body: { target, text: t.slice(0, 4000), by: "chrome-extension" } });
    },
    cancel: (id) => call(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} }),
    approvals: () => call("/v1/approvals"),
    decide: (id, approved, note) =>
      call(`/v1/approvals/${encodeURIComponent(id)}`, { method: "POST", body: { approved, note: note || undefined, by: "chrome-extension" } }),
    settings: () => call("/v1/settings"),
    saveSettings: (body) => call("/v1/settings", { method: "PUT", body }),
  };
}

/** One-line description of a run for lists. */
export function planWaiting(run) {
  return run?.status === "composed" && Boolean(run.planReview?.required) && !run.planReview?.approvedAt;
}

export function runLabel(run) {
  const goal = run?.score?.goal || run?.score?.summary || "(no goal)";
  return goal.length > 90 ? goal.slice(0, 89) + "…" : goal;
}
