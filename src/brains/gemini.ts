/**
 * Google AI Studio Gemini API (free tier), using a plain API key.
 *
 * This is the Gemini Developer API at generativelanguage.googleapis.com, reached through its
 * OpenAI-compatible chat endpoint. It is not Vertex AI: there is no billing project, no
 * service-account credential, and no aiplatform host. The provider stays off unless
 * GEMINI_API_KEY is set. A free-tier HTTP 429 is retryable so the model router falls back
 * to the next healthy model (Claude or Workers AI when those are configured).
 */
import type { ComposeResult, TurnRequest, TurnResult } from "../brain.js";
import { ModelCallError, OpenAICompatBrain, type OpenAICompatOptions } from "./openai.js";

/** OpenAI-compatible base for the AI Studio key. Not a Vertex regional endpoint. */
export const GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

/** Native model list. The OpenAI-compat `/models` route is not the one AI Studio documents. */
export const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

/**
 * Free-tier Flash-Lite chat model (input and output are free of charge on the AI Studio free tier).
 * Override with ARCHITECT_GEMINI_MODEL; paid and Vertex ids are rejected.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

const VERTEX = /aiplatform\.googleapis\.com|vertex|projects\/|locations\/|publishers\//i;
const PAID_OR_NON_CHAT = /(argon|omni|imagen|veo|lyria|embed|robot|image|tts|live|transcribe|native-audio|pro)/i;
/** Flash and Flash-Lite chat ids, including a trailing -preview. Versioned snapshot suffixes are not. */
const FREE_CHAT = /^gemini-[0-9][0-9a-z.-]*flash(?:-lite)?(?:-preview)?$/i;

/** Accept only AI Studio free-tier Flash / Flash-Lite chat model ids. */
export function assertFreeTierChatModel(model: string): string {
  const id = model.trim().toLowerCase();
  if (!id || VERTEX.test(id)) {
    throw new Error(
      `Gemini model "${model.trim() || "(empty)"}" is not a Google AI Studio model id. Architect uses the free tier with GEMINI_API_KEY and does not call Vertex AI.`,
    );
  }
  if (PAID_OR_NON_CHAT.test(id) || !FREE_CHAT.test(id)) {
    throw new Error(
      `Gemini model "${id}" is not a free-tier Flash or Flash-Lite chat model. The default is ${DEFAULT_GEMINI_MODEL}. Vertex AI, Pro, and other paid models are not used.`,
    );
  }
  return id;
}

export interface GeminiBrainOptions {
  apiKey: string;
  /** Free-tier Flash or Flash-Lite id. Default {@link DEFAULT_GEMINI_MODEL}. */
  model?: string;
  /** Send screenshots. Off unless set: text-only calls omit images. */
  vision?: boolean;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Gemini through the same OpenAI-compatible brain as the other gateways, pinned to AI Studio.
 * Price is zero: this path is the free tier, not a billed Vertex model.
 */
export class GeminiBrain extends OpenAICompatBrain {
  private readonly apiKey: string;
  private readonly probeFetch: typeof fetch;

  constructor(opts: GeminiBrainOptions) {
    const model = assertFreeTierChatModel(opts.model ?? DEFAULT_GEMINI_MODEL);
    const parent: OpenAICompatOptions = {
      baseUrl: GEMINI_OPENAI_BASE,
      model,
      apiKey: opts.apiKey,
      vision: opts.vision ?? false,
      price: [0, 0],
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs,
    };
    super(parent);
    this.apiKey = opts.apiKey;
    this.probeFetch = opts.fetch ?? fetch;
  }

  /** List models on the AI Studio API. A 401/403 here means the key is missing or rejected. */
  override async probe(): Promise<{ ok: boolean; listed?: boolean; models?: number; error?: string }> {
    try {
      const res = await this.probeFetch(GEMINI_MODELS_URL, {
        headers: { "x-goog-api-key": this.apiKey },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = (await res.json()) as { models?: Array<{ name?: string }> };
      const ids = (body.models ?? []).map((m) => m.name?.replace(/^models\//, "") ?? "").filter(Boolean);
      return { ok: true, models: ids.length, listed: !ids.length || ids.includes(this.model) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  override async compose(system: string, prompt: string): Promise<ComposeResult> {
    return this.guard(() => super.compose(system, prompt));
  }

  override async turn(req: TurnRequest): Promise<TurnResult> {
    return this.guard(() => super.turn(req));
  }

  /** One free-tier 429 is enough: the router tries the next model instead of hammering the quota. */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (err instanceof ModelCallError && err.status === 429) {
        throw new ModelCallError(`${this.model}: Gemini free-tier rate limit (HTTP 429); falling back to the next model`, 429, true);
      }
      throw err;
    }
  }
}
