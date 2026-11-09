/**
 * Choose the brain from configuration.
 *
 *   architect.models.json  – explicit model list and routing policy (see architect.models.example.json)
 *   OMNIROUTE_URL       – shortcut: route through a local OmniRoute gateway (e.g. http://localhost:20128/v1)
 *   ARCHITECT_OPENAI_BASE_URL + ARCHITECT_OPENAI_MODEL – shortcut: any other OpenAI-compatible endpoint
 *   ANTHROPIC_API_KEY   – Claude joins as the "strong" model
 *   GEMINI_API_KEY      – optional Google AI Studio free tier (not Vertex). Off when unset.
 *                         Added as a fast model; Claude / Workers AI stay primary. HTTP 429 falls back.
 *   ARCHITECT_BRAIN        – force "anthropic" (single model, Gemini not added) or "auto" (router)
 *
 * Secrets never live in the models file: entries name the env var that holds the key (apiKeyEnv).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AnthropicBrain, type Brain } from "../brain.js";
import { DEFAULT_GEMINI_MODEL, GEMINI_API_KEY_ENV, GeminiBrain, assertFreeTierChatModel } from "./gemini.js";
import { OpenAICompatBrain } from "./openai.js";
import { DEFAULT_POLICY, RouterBrain, type Candidate, type Tier as ModelTier } from "./router.js";

const Tier = z.enum(["fast", "balanced", "strong"]);

const ModelEntry = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("anthropic"),
      id: z.string().optional(),
      model: z.string(),
      tier: Tier,
      cost: z.number().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("openai"),
      id: z.string().optional(),
      baseUrl: z.string().url(),
      model: z.string(),
      tier: Tier,
      apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
      vision: z.boolean().optional(),
      price: z.tuple([z.number().nonnegative(), z.number().nonnegative()]).optional(),
      cost: z.number().nonnegative().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("gemini"),
      id: z.string().optional(),
      /** Free-tier Flash or Flash-Lite id. Default gemini-3.5-flash-lite. No Vertex resource names. */
      model: z.string().min(1).optional(),
      tier: Tier.optional(),
      /** Name of the env var that holds the AI Studio key. Default GEMINI_API_KEY. The key itself is rejected. */
      apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).optional(),
      vision: z.boolean().optional(),
      cost: z.number().nonnegative().optional(),
    })
    .strict(),
]);

export const ModelsFileSchema = z
  .object({
    models: z.array(ModelEntry).min(1),
    policy: z
      .object({
        plan: Tier,
        verify: Tier,
        act: Tier,
        escalateAfterErrors: z.number().int().positive(),
        longContextChars: z.number().int().positive(),
        cooldownMs: z.number().int().nonnegative(),
      })
      .partial()
      .optional(),
  })
  .strict();
export type ModelsFile = z.infer<typeof ModelsFileSchema>;

type Env = Record<string, string | undefined>;

export function candidatesFrom(file: ModelsFile, env: Env = process.env, fetchImpl?: typeof fetch): Candidate[] {
  const out: Candidate[] = [];
  for (const m of file.models) {
    if (m.provider === "anthropic") {
      out.push({ id: m.id ?? `anthropic/${m.model}`, tier: m.tier, cost: m.cost ?? 1, brain: new AnthropicBrain({ model: m.model }) });
      continue;
    }
    if (m.provider === "gemini") {
      // Validated even when the key is absent, so a Vertex or paid id fails before it can be called.
      const model = assertFreeTierChatModel(m.model ?? DEFAULT_GEMINI_MODEL);
      const keyEnv = m.apiKeyEnv ?? GEMINI_API_KEY_ENV;
      const apiKey = env[keyEnv]?.trim();
      if (!apiKey) continue;
      out.push({
        id: m.id ?? `gemini/${model}`,
        tier: m.tier ?? "fast",
        // Cost 1 (not 0) so an explicit free model already in this tier stays ahead of Gemini.
        cost: m.cost ?? 1,
        brain: new GeminiBrain({ apiKey, model, vision: m.vision, fetch: fetchImpl }),
      });
      continue;
    }
    const apiKey = m.apiKeyEnv ? env[m.apiKeyEnv] : undefined;
    out.push({
      id: m.id ?? `${new URL(m.baseUrl).host}/${m.model}`,
      tier: m.tier,
      cost: m.cost ?? (m.price ? m.price[0] + m.price[1] : 0),
      brain: new OpenAICompatBrain({ baseUrl: m.baseUrl, model: m.model, apiKey, vision: m.vision, price: m.price, headers: m.headers }),
    });
  }
  if (!out.length) {
    throw new Error("no usable models. A Gemini entry stays off unless GEMINI_API_KEY (or its apiKeyEnv) is set.");
  }
  return out;
}

/**
 * The optional Gemini candidate, or null when GEMINI_API_KEY is unset.
 * Tier defaults to fast so plan, verify, and the default act tier stay on Claude or Workers AI.
 */
export function geminiCandidate(env: Env, fetchImpl?: typeof fetch): Candidate | null {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;
  const model = assertFreeTierChatModel(env.ARCHITECT_GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL);
  return {
    id: `gemini/${model}`,
    tier: geminiTier(env.ARCHITECT_GEMINI_TIER),
    cost: 1,
    brain: new GeminiBrain({ apiKey, model, vision: env.ARCHITECT_GEMINI_VISION === "on", fetch: fetchImpl }),
  };
}

function geminiTier(value: string | undefined): ModelTier {
  if (!value) return "fast";
  if (value === "fast" || value === "balanced" || value === "strong") return value;
  throw new Error(`ARCHITECT_GEMINI_TIER must be fast, balanced, or strong (got ${value})`);
}

/** The model list implied by environment shortcuts, or null when none are set. */
export function modelsFromEnv(env: Env = process.env): ModelsFile | null {
  const models: ModelsFile["models"] = [];
  if (env.OMNIROUTE_URL) {
    const baseUrl = env.OMNIROUTE_URL;
    const key = env.OMNIROUTE_API_KEY ? "OMNIROUTE_API_KEY" : undefined;
    const add = (tier: "fast" | "balanced" | "strong", model: string) =>
      models.push({ provider: "openai", id: `omniroute/${model}#${tier}`, baseUrl, model, tier, apiKeyEnv: key, vision: env.OMNIROUTE_VISION === "on" });
    add("balanced", env.OMNIROUTE_MODEL ?? "auto");
    if (env.OMNIROUTE_FAST_MODEL) add("fast", env.OMNIROUTE_FAST_MODEL);
    if (env.OMNIROUTE_STRONG_MODEL) add("strong", env.OMNIROUTE_STRONG_MODEL);
  }
  if (env.ARCHITECT_OPENAI_BASE_URL && env.ARCHITECT_OPENAI_MODEL) {
    models.push({
      provider: "openai",
      baseUrl: env.ARCHITECT_OPENAI_BASE_URL,
      model: env.ARCHITECT_OPENAI_MODEL,
      tier: (env.ARCHITECT_OPENAI_TIER as "fast" | "balanced" | "strong") ?? "balanced",
      apiKeyEnv: env.ARCHITECT_OPENAI_API_KEY ? "ARCHITECT_OPENAI_API_KEY" : undefined,
      vision: env.ARCHITECT_OPENAI_VISION === "on",
    });
  }
  if (!models.length) return null;
  if (env.ANTHROPIC_API_KEY) models.push({ provider: "anthropic", model: env.ARCHITECT_MODEL ?? "claude-opus-5-5", tier: "strong" });
  return { models };
}

export function loadModelsFile(file: string): ModelsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`could not read ${file}: ${err instanceof Error ? err.message : err}`);
  }
  const parsed = ModelsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file} is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export interface BrainEnvOptions {
  /**
   * Workers AI brain. Used only when Claude is not configured and there is no models file,
   * OmniRoute URL, or other OpenAI shortcut. Gemini, when enabled, is added beside it.
   */
  workersAi?: Brain;
  /** Test hook. Production uses global fetch. */
  fetch?: typeof fetch;
}

/** The brain Architect uses by default. */
export function brainFromEnv(env: Env = process.env, cwd = process.cwd(), opts: BrainEnvOptions = {}): Brain {
  // A forced Claude brain stays a single model. Gemini is not added.
  if (env.ARCHITECT_BRAIN === "anthropic") return new AnthropicBrain();
  const file = env.ARCHITECT_MODELS_FILE ?? path.join(cwd, "architect.models.json");
  const fromFile = existsSync(file);
  const config = fromFile ? loadModelsFile(file) : modelsFromEnv(env);
  if (!config) {
    if (env.ARCHITECT_BRAIN === "auto" && !env.GEMINI_API_KEY?.trim()) {
      throw new Error("ARCHITECT_BRAIN=auto needs architect.models.json, OMNIROUTE_URL, ARCHITECT_OPENAI_BASE_URL or GEMINI_API_KEY");
    }
    return withOptionalGemini(primaryBrain(env, opts), env, opts);
  }
  const fileListsGemini = fromFile && config.models.some((m) => m.provider === "gemini");
  let candidates = candidatesFrom(config, env, opts.fetch);
  if (!fileListsGemini) {
    const extra = geminiCandidate(env, opts.fetch);
    if (extra) candidates = [...candidates, extra];
  }
  return new RouterBrain(candidates, { ...DEFAULT_POLICY, ...config.policy });
}

/** Claude when it is configured or this is not a Worker; otherwise the Workers AI binding. */
function primaryBrain(env: Env, opts: BrainEnvOptions): Brain {
  if (!env.ANTHROPIC_API_KEY && opts.workersAi) return opts.workersAi;
  return new AnthropicBrain({ model: env.ARCHITECT_MODEL });
}

/**
 * Keep the primary brain as-is when Gemini is off. When the key is set, route with the primary
 * first in its tier and Gemini as the optional fast model, so a free-tier 429 can fall back.
 */
function withOptionalGemini(primary: Brain, env: Env, opts: BrainEnvOptions): Brain {
  const gemini = geminiCandidate(env, opts.fetch);
  if (!gemini) return primary;
  const useWorkers = !env.ANTHROPIC_API_KEY && opts.workersAi !== undefined && primary === opts.workersAi;
  const candidate: Candidate = useWorkers
    ? { id: `workers-ai/${primary.model}`, tier: "balanced", cost: 0, brain: primary }
    : { id: `anthropic/${primary.model}`, tier: "strong", cost: 1, brain: primary };
  return new RouterBrain([candidate, gemini]);
}
