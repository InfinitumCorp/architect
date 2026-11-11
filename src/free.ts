/**
 * The free model: an open-weight model on Cloudflare Workers AI, served by rchtch.app as an
 * OpenAI-compatible endpoint that needs no API key. Architect Desktop and local servers use it
 * when no other model is configured, so a fresh install works at once (and from Russia without a VPN).
 *
 *   GET  /free/v1/models             the models offered
 *   POST /free/v1/chat/completions   OpenAI chat completions (tools supported), rate-limited per address
 *
 * Nothing secret is shipped in the build: the Worker's AI binding pays, and the per-address
 * limit keeps one caller from using up the account's daily allocation. Calls also go through the
 * account-wide AI_BUDGET ledger, so the free model stays inside Workers AI's free daily allowance.
 */
import { budgetedAI } from "./brains/ai-budget.mjs";
import { DEFAULT_WORKERS_AI_MODEL, workersAiFetch, type AiBinding } from "./brains/workersai.js";

export const FREE_PREFIX = "/free/v1";
/** Where local builds reach the free model. Override with ARCHITECT_FREE_URL, or turn it off with ARCHITECT_FREE=off. */
export const FREE_BASE_URL = "https://rchtch.app/free/v1";
/** Upper bound on one reply, so a single call cannot spend much. */
export const FREE_MAX_TOKENS = 8_000;
/** Largest request body accepted (a long coding conversation fits; abuse does not). */
const MAX_BODY = 1_500_000;

/** Cloudflare's rate-limiting binding (wrangler "ratelimits"). */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};
const reply = (status: number, data: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra } });
const error = (status: number, message: string, extra?: Record<string, string>) => reply(status, { error: { message } }, extra);

/** The models offered for free: the configured Workers AI model (open weights, tool calling). */
export function freeModels(model = DEFAULT_WORKERS_AI_MODEL): string[] {
  return [model];
}

/** Handles /free/v1/*; returns undefined for any other path. */
export async function freeModel(
  req: Request,
  env: { AI?: AiBinding; AI_BUDGET?: Parameters<typeof budgetedAI>[1]; FREE_RATE?: RateLimiter; ARCHITECT_WORKERS_AI_MODEL?: string; ARCHITECT_FREE?: string },
): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (url.pathname !== FREE_PREFIX && !url.pathname.startsWith(`${FREE_PREFIX}/`)) return undefined;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (!env.AI || env.ARCHITECT_FREE === "off") return error(503, "The free model is not available on this server.");
  const models = freeModels(env.ARCHITECT_WORKERS_AI_MODEL || undefined);
  const route = url.pathname.slice(FREE_PREFIX.length);

  if (route === "/models" && req.method === "GET") {
    return reply(200, { object: "list", data: models.map((id) => ({ id, object: "model", owned_by: "workers-ai" })) });
  }
  if (route !== "/chat/completions") return error(404, "Only /models and /chat/completions are served.");
  if (req.method !== "POST") return error(405, "Use POST.", { allow: "POST" });

  const who = req.headers.get("cf-connecting-ip") ?? "unknown";
  if (env.FREE_RATE && !(await env.FREE_RATE.limit({ key: who })).success) {
    return error(429, "Too many requests to the free model. Wait a minute, or add your own model key.", { "retry-after": "60" });
  }
  const text = await req.text();
  if (text.length > MAX_BODY) return error(413, "The request is too large for the free model.");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
  } catch {
    return error(400, "The body must be a JSON object.");
  }
  if (!Array.isArray(body.messages) || !body.messages.length) return error(400, "messages is required.");
  // Only the free models, and never more than FREE_MAX_TOKENS per reply.
  const model = typeof body.model === "string" && models.includes(body.model) ? body.model : models[0]!;
  const maxTokens = Math.min(Number(body.max_tokens ?? body.max_completion_tokens) || FREE_MAX_TOKENS, FREE_MAX_TOKENS);
  const { stream: _stream, max_completion_tokens: _mct, ...rest } = body;
  const res = await workersAiFetch(budgetedAI(env.AI, env.AI_BUDGET))(`${FREE_PREFIX}/chat/completions`, {
    method: "POST",
    body: JSON.stringify({ ...rest, model, max_tokens: maxTokens }),
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
}
