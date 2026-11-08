/**
 * A Brain for any OpenAI-compatible chat endpoint: OmniRoute, Ollama, LM Studio, vLLM, OpenRouter,
 * LiteLLM, Together, Groq… Architect speaks Anthropic-shaped messages internally; this translates.
 */
import { z } from "zod";
import { ScoreDraftSchema, type Brain, type ComposeResult, type ContentBlock, type MessageParam, type TurnRequest, type TurnResult } from "../brain.js";
import type { TurnUsage } from "../usage.js";

export interface OpenAICompatOptions {
  /** e.g. http://localhost:20128/v1 (OmniRoute), http://localhost:11434/v1 (Ollama). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Send screenshots to the model. Off for text-only models: images become a short note. */
  vision?: boolean;
  /** USD per million tokens [input, output]. Default 0 (free or self-hosted). */
  price?: [number, number];
  maxTokens?: number;
  timeoutMs?: number;
  /** Extra headers (some gateways want an app name). */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Worth trying another model: rate limits, outages, timeouts, malformed output. */
    readonly retryable = true,
  ) {
    super(message);
  }
}

export type OAMessage =
  | { role: "system" | "user"; content: string | OAPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: OAToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
type OAPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type OAToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

interface OAResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string | null; tool_calls?: OAToolCall[]; refusal?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string } | string;
}

/** Anthropic-shaped history → OpenAI chat messages. */
export function toOpenAIMessages(system: string, messages: MessageParam[], vision: boolean): OAMessage[] {
  const out: OAMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push(m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const text: string[] = [];
      const calls: OAToolCall[] = [];
      for (const b of m.content as unknown as Array<Record<string, unknown>>) {
        if (b.type === "text") text.push(String(b.text));
        else if (b.type === "tool_use")
          calls.push({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } });
      }
      out.push({ role: "assistant", content: text.join("\n") || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // user turn: tool results become `tool` messages; text and images stay in a user message.
    const parts: OAPart[] = [];
    for (const b of m.content as unknown as Array<Record<string, unknown>>) {
      if (b.type === "tool_result") {
        const images: OAPart[] = [];
        const text = flattenResult(b.content, vision, images);
        out.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: (b.is_error ? "ERROR: " : "") + text });
        parts.push(...images);
      } else if (b.type === "text") parts.push({ type: "text", text: String(b.text) });
      else if (b.type === "image") pushImage(b, vision, parts);
    }
    if (parts.length) out.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n") : parts });
  }
  return out;
}

/**
 * Some gateways (OmniRoute's DuckDuckGo adapter, for one) accept tool definitions but reject any
 * history that contains tool calls or tool results. Replay that history as plain text instead;
 * the model still answers with native tool calls.
 */
export function toTextToolHistory(msgs: OAMessage[]): OAMessage[] {
  const out: OAMessage[] = [];
  const names = new Map<string, string>();
  const pushUser = (text: string) => {
    const last = out[out.length - 1];
    if (last?.role === "user" && typeof last.content === "string") last.content += `\n\n${text}`;
    else out.push({ role: "user", content: text });
  };
  for (const m of msgs) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c) => {
        names.set(c.id, c.function.name);
        return `[tool call ${c.function.name} ${c.function.arguments}]`;
      });
      out.push({ role: "assistant", content: [m.content, ...calls].filter(Boolean).join("\n") });
    } else if (m.role === "tool") {
      pushUser(`[tool result for ${names.get(m.tool_call_id) ?? "tool"}]\n${m.content}`);
    } else if (m.role === "user" && typeof m.content === "string") {
      pushUser(m.content);
    } else out.push(m);
  }
  return out;
}

function flattenResult(content: unknown, vision: boolean, images: OAPart[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const text: string[] = [];
  for (const c of content as Array<Record<string, unknown>>) {
    if (c.type === "text") text.push(String(c.text));
    else if (c.type === "image") {
      if (vision) pushImage(c, true, images);
      else text.push("[screenshot omitted: this model has no vision]");
    }
  }
  return text.join("\n");
}

function pushImage(b: Record<string, unknown>, vision: boolean, parts: OAPart[]) {
  const src = b.source as { type?: string; media_type?: string; data?: string; url?: string } | undefined;
  if (!vision || !src) {
    parts.push({ type: "text", text: "[image omitted: this model has no vision]" });
    return;
  }
  const url = src.type === "base64" ? `data:${src.media_type};base64,${src.data}` : String(src.url ?? "");
  parts.push({ type: "image_url", image_url: { url } });
}

const STOP: Record<string, string> = { tool_calls: "tool_use", function_call: "tool_use", stop: "end_turn", length: "max_tokens", content_filter: "refusal" };

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end < start) throw new ModelCallError("the model did not return JSON");
  return JSON.parse(body.slice(start, end + 1));
}

/** A filled-in Score draft, shown to models that would otherwise echo the schema back. */
export const DRAFT_EXAMPLE = {
  summary: "Open the page in the browser, read the value and report it.",
  permissions: ["browser"],
  startUrl: "https://example.com/",
  steps: [
    {
      title: "Open the page",
      instruction: "Navigate to https://example.com/ and take a snapshot.",
      instruments: ["browser"],
      checkpoint: false,
    },
  ],
  successCriteria: ["The value shown on the page is reported exactly"],
};

class SchemaEcho extends Error {}

/** True when the reply is a JSON Schema (e.g. the one in the prompt) rather than an instance of it. */
export function isSchemaEcho(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return "$schema" in o || (o.type === "object" && typeof o.properties === "object" && !("steps" in o));
}

/** Small models often wrap the answer, e.g. {"score": {...}}: use the single inner object. */
export function unwrapDraft(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const o = value as Record<string, unknown>;
  if ("steps" in o || "summary" in o) return o;
  const keys = Object.keys(o);
  const inner = keys.length === 1 ? o[keys[0]!] : undefined;
  return inner && typeof inner === "object" && !Array.isArray(inner) ? inner : value;
}

/** A short correction for the model: which fields are wrong, not a raw validator dump. */
function describeDraftError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path: PropertyKey[]; message: string }> })?.issues;
  if (Array.isArray(issues) && issues.length) {
    return issues.slice(0, 8).map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("; ");
  }
  return err instanceof Error ? err.message.slice(0, 500) : String(err);
}

export class OpenAICompatBrain implements Brain {
  readonly model: string;
  private opts: OpenAICompatOptions;
  private f: typeof fetch;

  constructor(opts: OpenAICompatOptions) {
    this.opts = opts;
    this.model = opts.model;
    this.f = opts.fetch ?? fetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  /** Is the endpoint up, and does it list this model? ("auto" and unlisted models count as listed.) */
  async probe(): Promise<{ ok: boolean; listed?: boolean; models?: number; error?: string }> {
    try {
      const res = await this.f(`${this.opts.baseUrl.replace(/\/$/, "")}/models`, {
        headers: { ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}), ...this.opts.headers },
        signal: AbortSignal.timeout(5_000),
      });
      // Some gateways (OmniRoute) lock the model list but serve chat without a key: try one tiny chat call.
      if (res.status === 401 || res.status === 403) return await this.probeChat(res.status);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((m) => m.id);
      return { ok: true, models: ids.length, listed: this.model === "auto" || !ids.length || ids.includes(this.model) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async probeChat(listStatus: number): Promise<{ ok: boolean; error?: string }> {
    const res = await this.f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      signal: AbortSignal.timeout(30_000),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${listStatus} on /models, HTTP ${res.status} on chat` };
  }

  private cost(u: TurnUsage): number {
    const [i, o] = this.opts.price ?? [0, 0];
    return ((u.inputTokens + u.cacheReadTokens) * i + u.outputTokens * o) / 1_000_000;
  }

  private async chat(body: Record<string, unknown>): Promise<{ res: OAResponse; usage: TurnUsage & { costUsd: number }; model: string }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 180_000);
    let http: Response;
    try {
      http = await this.f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          ...this.opts.headers,
        },
        body: JSON.stringify({ model: this.model, max_tokens: this.opts.maxTokens ?? 8_000, ...body }),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new ModelCallError(`${this.model}: ${err instanceof Error ? err.message : err}`);
    } finally {
      clearTimeout(timer);
    }
    const text = await http.text();
    let res: OAResponse;
    try {
      res = text ? (JSON.parse(text) as OAResponse) : {};
    } catch {
      throw new ModelCallError(`${this.model}: non-JSON response (HTTP ${http.status})`, http.status);
    }
    if (!http.ok) {
      const msg = typeof res.error === "string" ? res.error : (res.error?.message ?? http.statusText);
      // 400/401/403/404 are configuration problems for this model; still try the next one.
      throw new ModelCallError(`${this.model}: HTTP ${http.status} ${msg}`, http.status, true);
    }
    const cached = res.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const usage: TurnUsage = {
      inputTokens: Math.max(0, (res.usage?.prompt_tokens ?? 0) - cached),
      outputTokens: res.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
    return { res, usage: { ...usage, costUsd: this.cost(usage) }, model: res.model || this.model };
  }

  async compose(system: string, prompt: string): Promise<ComposeResult> {
    const schema = z.toJSONSchema(ScoreDraftSchema);
    const messages: OAMessage[] = [
      {
        role: "system",
        content:
          `${system}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}\n\n` +
          `Do not repeat the schema. Fill it in: your reply has the same shape as this example (with your own values):\n${JSON.stringify(DRAFT_EXAMPLE)}`,
      },
      { role: "user", content: prompt },
    ];
    let lastErr = "";
    let lastContent = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (lastErr) messages.push({ role: "user", content: `That was not valid: ${lastErr}. Reply with only the corrected JSON object, with every required field at the top level.` });
      const { res, usage, model } = await this.chat({ messages, response_format: { type: "json_object" } });
      const content = res.choices?.[0]?.message?.content ?? "";
      try {
        lastContent = content;
        const parsed = extractJson(content);
        if (isSchemaEcho(parsed)) throw new SchemaEcho();
        const draft = ScoreDraftSchema.parse(unwrapDraft(parsed));
        return { draft, usage, model };
      } catch (err) {
        lastErr =
          err instanceof SchemaEcho
            ? `you returned the JSON Schema itself instead of a Score. Reply with a filled-in object shaped like ${JSON.stringify(DRAFT_EXAMPLE)}`
            : describeDraftError(err);
        messages.push({ role: "assistant", content });
      }
    }
    throw new ModelCallError(`${this.model}: could not produce a valid Score (${lastErr}); last reply began: ${lastContent.replace(/\s+/g, " ").slice(0, 300)}`);
  }

  /** Set once this endpoint has rejected native tool history (see toTextToolHistory). */
  private textToolHistory = false;

  async turn(req: TurnRequest): Promise<TurnResult> {
    const native = toOpenAIMessages(req.system, req.messages, this.opts.vision ?? false);
    const tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
    const hasToolHistory = native.some((m) => m.role === "tool");
    const send = (messages: OAMessage[]) => this.chat({ messages, tools, tool_choice: "auto" });
    let reply: Awaited<ReturnType<OpenAICompatBrain["chat"]>>;
    if (this.textToolHistory && hasToolHistory) reply = await send(toTextToolHistory(native));
    else {
      try {
        reply = await send(native);
      } catch (err) {
        if (!(err instanceof ModelCallError) || err.status !== 400 || !hasToolHistory) throw err;
        reply = await send(toTextToolHistory(native));
        this.textToolHistory = true;
      }
    }
    const { res, usage, model } = reply;
    const choice = res.choices?.[0];
    if (!choice?.message) throw new ModelCallError(`${this.model}: empty response`);
    const content: ContentBlock[] = [];
    const msg = choice.message;
    if (msg.refusal) return { content: [], stop_reason: "refusal", usage, model };
    if (msg.content) content.push({ type: "text", text: msg.content, citations: null } as unknown as ContentBlock);
    for (const call of msg.tool_calls ?? []) {
      let input: unknown;
      try {
        input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        throw new ModelCallError(`${this.model}: malformed tool arguments for ${call.function.name}`);
      }
      content.push({ type: "tool_use", id: call.id || `call_${content.length}`, name: call.function.name, input } as unknown as ContentBlock);
    }
    const stop = content.some((c) => c.type === "tool_use") ? "tool_use" : (STOP[choice.finish_reason ?? ""] ?? "end_turn");
    return { content, stop_reason: stop, usage, model };
  }
}
