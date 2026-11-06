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

type OAMessage =
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
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((m) => m.id);
      return { ok: true, models: ids.length, listed: this.model === "auto" || !ids.length || ids.includes(this.model) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
      { role: "system", content: `${system}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(schema)}` },
      { role: "user", content: prompt },
    ];
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      if (lastErr) messages.push({ role: "user", content: `That was not valid: ${lastErr}. Reply with only the corrected JSON object.` });
      const { res, usage, model } = await this.chat({ messages, response_format: { type: "json_object" } });
      const content = res.choices?.[0]?.message?.content ?? "";
      try {
        const draft = ScoreDraftSchema.parse(extractJson(content));
        return { draft, usage, model };
      } catch (err) {
        lastErr = err instanceof Error ? err.message.slice(0, 500) : String(err);
        messages.push({ role: "assistant", content });
      }
    }
    throw new ModelCallError(`${this.model}: could not produce a valid Score (${lastErr})`);
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const { res, usage, model } = await this.chat({
      messages: toOpenAIMessages(req.system, req.messages, this.opts.vision ?? false),
      tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } })),
      tool_choice: "auto",
    });
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
