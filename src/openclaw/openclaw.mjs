// OpenClaw client for Infinitum products. Zero dependencies: Node 18+, Workers, Deno, Bun.
//
// Anyone can type "@scalvs <task>" (or "@scalus <task>") in a product's chat, Ask or compose
// box. The product passes that text here (server side: the gateway token must never reach a
// browser) and gets back the answer from the SCALVS agent, the same way "@conjure" works.
// SCALVS runs on OpenClaw underneath; "@openclaw" is not a trigger.
//
// OpenClaw (https://openclaw.ai) is a self-hosted agent gateway. This client calls its
// OpenAI-compatible endpoint, POST /v1/chat/completions, which the gateway turns on with
// gateway.http.endpoints.chatCompletions.enabled = true. `model` picks the agent
// ("openclaw" is the default agent, "openclaw/<agentId>" a specific one) and the OpenAI
// `user` field ("<product>:<user>") gives each person their own OpenClaw session.
//
//   import { openClawRoutesFromEnv } from "./openclaw/openclaw.mjs";
//   const openclaw = openClawRoutesFromEnv(env, { product: "scalvs" });   // off until configured
//   const res = await openclaw(request, { user: signedInId, context: workspaceSummary });
//   if (res) return res;                                                   // null for other paths
//
// Source of truth: InfinitumCorp/infinitum-nexus packages/ai/src/openclaw/openclaw.mjs
// (exported as "@infinitum/ai/openclaw"). Copies in other repos are synced from it.

export const OPENCLAW_CLIENT_VERSION = "1.1.0";

export const OPENCLAW_NOT_CONNECTED = "SCALVS isn't connected. Set OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN to use @scalvs.";
export const OPENCLAW_NEEDS_TASK = "Tell SCALVS what to do after @scalvs, for example: @scalvs summarise this and send it to my Telegram.";

const MAX_TASK = 4000;
const MAX_CONTEXT = 60_000;
const MAX_ANSWER = 20_000;

export class OpenClawError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "OpenClawError";
    this.status = status;
  }
}

// People type "@scalvs" or "@scalus" (also full-width "＠"), as a word: not part of an email
// (me@scalvs.app) or a longer handle (@scalvsbot). OpenClaw is the engine underneath.
const MENTION = /(^|[^\w@＠./])[@＠]scal(?:vs|us)(?![\w-]|\.[a-z])/i;

/** The task: the text with the mention taken out. Null when the text mentions neither @scalvs nor @scalus. */
export function parseOpenClawMention(text) {
  if (typeof text !== "string") return null;
  const m = MENTION.exec(text);
  if (!m) return null;
  const at = m.index + m[1].length;
  const rest = text.slice(at + "@scalvs".length).replace(/^[\s:,\-–—]+/, " ");
  const task = (text.slice(0, at) + " " + rest).replace(/\s+/g, " ").trim();
  return { task };
}

export function hasOpenClawMention(text) {
  return parseOpenClawMention(text) !== null;
}

function checkUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    throw new Error("OPENCLAW_GATEWAY_URL is not a valid URL");
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("OPENCLAW_GATEWAY_URL must use https");
  if (u.username || u.password) throw new Error("Put the gateway token in OPENCLAW_GATEWAY_TOKEN, not in the URL");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

function checkAgent(agent) {
  if (!/^(openclaw([/:][A-Za-z0-9_-]{1,64})?|agent:[A-Za-z0-9_-]{1,64})$/.test(agent)) throw new Error(`OPENCLAW_AGENT "${agent}" is not an OpenClaw agent name`);
  return agent;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : "")).join("");
  return "";
}

/**
 * @param {{ url: string, token: string, agent?: string, timeoutMs?: number, fetch?: typeof fetch, product?: string }} options
 */
export function createOpenClaw({ url, token, agent = "openclaw", timeoutMs = 120_000, fetch: fetchImpl, product = "this app" } = {}) {
  const base = checkUrl(url);
  const name = checkAgent(agent || "openclaw");
  if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN is not set");
  // A plain local function: Workers throw "Illegal invocation" for fetch called on another object.
  const doFetch = fetchImpl ?? globalThis.fetch;

  const api = {
    agent: name,

    /** Sends one task. `user` keeps one OpenClaw session per person (the gateway derives it). */
    async ask(task, { user, context, signal } = {}) {
      const messages = [
        ...(context ? [{ role: "system", content: String(context).slice(0, MAX_CONTEXT) }] : []),
        { role: "user", content: String(task).slice(0, MAX_TASK) },
      ];
      const timeout = AbortSignal.timeout(timeoutMs);
      const both = signal && typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
      let res;
      try {
        res = await doFetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ model: name, messages, user, stream: false }),
          signal: both,
        });
      } catch (err) {
        if (err?.name === "TimeoutError") throw new OpenClawError("SCALVS took too long to answer.", 504);
        throw new OpenClawError("Couldn't reach SCALVS (its OpenClaw gateway).", 502);
      }
      if (res.status === 401 || res.status === 403) throw new OpenClawError(`SCALVS's OpenClaw gateway refused ${product}'s token.`, 502);
      if (res.status === 404) throw new OpenClawError("SCALVS's OpenClaw chat endpoint is off. Enable gateway.http.endpoints.chatCompletions.", 502);
      if (res.status === 429) throw new OpenClawError("SCALVS is busy. Try again in a moment.", 429);
      if (!res.ok) throw new OpenClawError(`SCALVS returned ${res.status}.`, 502);
      const body = await res.json().catch(() => null);
      const text = textOf(body?.choices?.[0]?.message?.content);
      if (!text.trim()) throw new OpenClawError("SCALVS sent an empty answer.", 502);
      return text.slice(0, MAX_ANSWER);
    },

    /**
     * The one call products make for "@scalvs" / "@scalus". Returns null when the text has no
     * mention; otherwise { text, agent }. Throws OpenClawError (status 400) for a bare mention.
     */
    async handleMention(text, { user, context, signal } = {}) {
      const m = parseOpenClawMention(text);
      if (!m) return null;
      if (!m.task) throw new OpenClawError(OPENCLAW_NEEDS_TASK, 400);
      return { text: await api.ask(m.task, { user, context, signal }), agent: name };
    },
  };
  return api;
}

/* ---------------- Drop-in routes for a product's server ---------------- */

const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * Standard @scalvs / @scalus routes for any product, on web-standard Request/Response
 * (Cloudflare Workers, Hono via c.req.raw, Deno, Bun; Node via toWebRequest below).
 *
 *   GET  {prefix}                          → { connected, agent }   (never the URL or token)
 *   POST {prefix}  { text, context? }      → { mention: false } or { mention: true, text, agent }
 *
 * Call it AFTER the product's own Cumulus ID sign-in, passing who is signed in.
 * `openclaw` is a client, null (off), or a function (user) => client | null for per-user gateways.
 * Returns null for paths it doesn't own, so it chains with the product's router.
 */
export function createOpenClawRoutes({ openclaw = null, prefix = "/api/openclaw", product = "app" } = {}) {
  const resolve = typeof openclaw === "function" ? openclaw : () => openclaw;
  return async function handle(request, { user, context: extraContext } = {}) {
    const url = new URL(request.url);
    if (url.pathname !== prefix) return null;
    if (!user) return reply(401, { error: "sign in required" });
    let claw;
    try {
      claw = (await resolve(String(user))) || null;
    } catch {
      return reply(503, { error: "SCALVS's OpenClaw settings are invalid. Check the gateway URL, token and agent." });
    }
    if (request.method === "GET") return reply(200, { connected: Boolean(claw), agent: claw?.agent ?? null });
    if (request.method !== "POST") return reply(405, { error: "use GET or POST" });
    if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return reply(415, { error: "send JSON" });
    const body = await request.json().catch(() => null);
    if (!body || typeof body.text !== "string" || body.text.length > 32000) return reply(400, { error: "text is required" });
    const m = parseOpenClawMention(body.text);
    if (!m) return reply(200, { mention: false });
    if (!claw) return reply(503, { error: OPENCLAW_NOT_CONNECTED });
    if (!m.task) return reply(400, { error: OPENCLAW_NEEDS_TASK });
    const context = [typeof body.context === "string" ? body.context : "", extraContext || ""].filter(Boolean).join("\n\n").slice(0, MAX_CONTEXT);
    try {
      const text = await claw.ask(m.task, { user: `${product}:${user}`, context: context || undefined, signal: request.signal });
      return reply(200, { mention: true, text, agent: claw.agent });
    } catch (err) {
      if (err instanceof OpenClawError) return reply(err.status, { error: err.message });
      throw err;
    }
  };
}

/** Node http adapter: turns an IncomingMessage into a Request for createOpenClawRoutes. */
export async function toWebRequest(req, base = "http://localhost") {
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 64 * 1024) throw new Error("body too large");
      chunks.push(c);
    }
    body = Buffer.concat(chunks);
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  return new Request(new URL(req.url, base), { method: req.method, headers, body });
}

/** Node http adapter: writes a Response to a ServerResponse. */
export async function sendWebResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** From OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN and optional OPENCLAW_AGENT; null when not set. */
export function openClawFromEnv(env = globalThis.process?.env ?? {}, options = {}) {
  if (!env.OPENCLAW_GATEWAY_URL || !env.OPENCLAW_GATEWAY_TOKEN) return null;
  return createOpenClaw({ url: env.OPENCLAW_GATEWAY_URL, token: env.OPENCLAW_GATEWAY_TOKEN, agent: env.OPENCLAW_AGENT, ...options });
}

/**
 * createOpenClawRoutes from the environment. Off (GET says connected: false, @scalvs answers 503)
 * until OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN are set (@scalvs answers 503 meanwhile). A bad URL or agent name turns it
 * off too, rather than taking the product down.
 */
export function openClawRoutesFromEnv(env = globalThis.process?.env ?? {}, { product = "app", prefix, fetch, timeoutMs } = {}) {
  let claw = null;
  try {
    claw = openClawFromEnv(env, { product, fetch, timeoutMs });
  } catch (err) {
    globalThis.console?.warn?.(`SCALVS (OpenClaw) is off: ${err.message}`);
  }
  return createOpenClawRoutes({ openclaw: claw, prefix, product });
}
