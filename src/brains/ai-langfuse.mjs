// Langfuse tracing for Workers AI calls, for every Infinitum Worker. Zero dependencies.
//
// Sends one OpenTelemetry span per model call to Langfuse Cloud's OTLP/HTTP JSON endpoint
// (/api/public/otel/v1/traces, x-langfuse-ingestion-version: 4). The legacy /api/public/ingestion
// trace events are switched off by Langfuse on 2026-11-16, so this does not use them.
//
//   LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY   project keys (secret is a server secret). Unset: tracing is off.
//   LANGFUSE_BASE_URL                           default https://cloud.langfuse.com (EU, the SDK default); US: https://us.cloud.langfuse.com
//   LANGFUSE=off                                turns it off even with keys
//   LANGFUSE_CAPTURE_CONTENT=on                 also send prompts and replies (default: metadata only)
//
// By default a span carries the model, latency, token usage, success or error and the product name:
// never the prompt, the reply, a user id or an IP address.
//
//   const ai = tracedAI(budgetedAI(env.AI, env.AI_BUDGET), langfuseFromEnv(env, { product: "scalvs" }), { waitUntil });
//
// Copy this file unchanged into a Worker. Copies: scalvs-ai api/_ai-langfuse.mjs, architect src/brains/ai-langfuse.mjs.

export const LANGFUSE_CLIENT_VERSION = "1.0.0";
const DEFAULT_BASE = "https://cloud.langfuse.com";
const MAX_CONTENT = 8_000;

const hex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const nanos = (ms) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const attr = (key, v) => (typeof v === "number" ? { key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } } : { key, value: { stringValue: String(v) } });

function cleanBase(raw) {
  try {
    const u = new URL(String(raw || DEFAULT_BASE).trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

const clipContent = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > MAX_CONTENT ? `${s.slice(0, MAX_CONTENT)}…` : s;
};

/** Builds the OTLP/HTTP JSON body for one generation span. Exported for tests. */
export function generationSpan({ product, environment, name, model, startMs, endMs, usage, error, input, output, metadata = {} }) {
  const attributes = [
    attr("langfuse.observation.type", "generation"),
    attr("langfuse.trace.name", `${product}:${name}`),
    attr("langfuse.observation.model.name", model || "unknown"),
    attr("langfuse.observation.level", error ? "ERROR" : "DEFAULT"),
    attr("langfuse.observation.metadata.product", product),
  ];
  if (environment) attributes.push(attr("langfuse.environment", environment));
  if (usage && (usage.input || usage.output)) {
    attributes.push(attr("langfuse.observation.usage_details", JSON.stringify({ input: usage.input || 0, output: usage.output || 0, total: (usage.input || 0) + (usage.output || 0) })));
  }
  if (error) attributes.push(attr("langfuse.observation.status_message", String(error).slice(0, 500)));
  for (const [k, v] of Object.entries(metadata)) if (v !== undefined && v !== null) attributes.push(attr(`langfuse.observation.metadata.${k}`, v));
  if (input !== undefined) attributes.push(attr("langfuse.observation.input", clipContent(input)));
  if (output !== undefined) attributes.push(attr("langfuse.observation.output", clipContent(output)));
  return {
    resourceSpans: [{
      resource: { attributes: [attr("service.name", product)] },
      scopeSpans: [{
        scope: { name: "infinitum-ai-langfuse", version: LANGFUSE_CLIENT_VERSION },
        spans: [{
          traceId: hex(16),
          spanId: hex(8),
          name,
          kind: 3,
          startTimeUnixNano: nanos(startMs),
          endTimeUnixNano: nanos(endMs),
          attributes,
          status: error ? { code: 2, message: String(error).slice(0, 500) } : { code: 1 },
        }],
      }],
    }],
  };
}

/** A Langfuse tracer from the environment, or null when keys are missing, LANGFUSE=off, or the URL is unsafe. */
export function langfuseFromEnv(env = globalThis.process?.env ?? {}, { product, fetch: fetchImpl, timeoutMs = 3_000 } = {}) {
  const pk = String(env.LANGFUSE_PUBLIC_KEY ?? "").trim();
  const sk = String(env.LANGFUSE_SECRET_KEY ?? "").trim();
  if (!pk || !sk || String(env.LANGFUSE ?? "").toLowerCase() === "off") return null;
  const base = cleanBase(env.LANGFUSE_BASE_URL ?? env.LANGFUSE_HOST);
  if (!base) return null;
  const doFetch = fetchImpl ?? globalThis.fetch;
  const auth = `Basic ${btoa(`${pk}:${sk}`)}`;
  const captureContent = String(env.LANGFUSE_CAPTURE_CONTENT ?? "").toLowerCase() === "on";
  const environment = env.LANGFUSE_TRACING_ENVIRONMENT || undefined;
  return {
    product,
    captureContent,
    /** Sends one span; never throws. Returns the fetch promise so a Worker can waitUntil() it. */
    record(gen) {
      try {
        const body = generationSpan({ product, environment, ...gen, ...(captureContent ? {} : { input: undefined, output: undefined }) });
        return Promise.resolve(doFetch(`${base}/api/public/otel/v1/traces`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: auth, "x-langfuse-ingestion-version": "4" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })).then(() => undefined, () => undefined);
      } catch {
        return Promise.resolve();
      }
    },
  };
}

const usageOf = (r) => {
  const u = r && typeof r === "object" ? r.usage : undefined;
  if (!u) return undefined;
  return { input: u.prompt_tokens ?? u.input_tokens ?? 0, output: u.completion_tokens ?? u.output_tokens ?? 0 };
};
const textOf = (r) => (r && typeof r === "object" ? r.response ?? r.choices?.[0]?.message?.content ?? undefined : undefined);

/**
 * Wraps a Workers AI binding so every ai.run() is traced. Returns the binding unchanged when the
 * tracer is null. Streams are traced to the moment the stream opens (no token counts).
 */
export function tracedAI(ai, tracer, { waitUntil, name = "workers-ai.run" } = {}) {
  if (!ai || !tracer) return ai;
  const keep = (p) => { try { waitUntil?.(p); } catch { /* ignore */ } };
  return new Proxy(ai, {
    get(target, prop, receiver) {
      if (prop !== "run") {
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      }
      return async (model, input = {}, options) => {
        const startMs = Date.now();
        const stream = Boolean(input?.stream);
        try {
          const result = await target.run(model, input, options);
          keep(tracer.record({ name, model, startMs, endMs: Date.now(), usage: stream ? undefined : usageOf(result), metadata: { stream, tools: Array.isArray(input?.tools) ? input.tools.length : 0 }, input: input?.messages ?? input?.prompt, output: stream ? undefined : textOf(result) }));
          return result;
        } catch (err) {
          keep(tracer.record({ name, model, startMs, endMs: Date.now(), error: err?.message || String(err), metadata: { stream }, input: input?.messages ?? input?.prompt }));
          throw err;
        }
      };
    },
  });
}
