/**
 * Choose the brain from configuration.
 *
 *   cndctr.models.json  – explicit model list and routing policy (see cndctr.models.example.json)
 *   OMNIROUTE_URL       – shortcut: route through a local OmniRoute gateway (e.g. http://localhost:20128/v1)
 *   CNDCTR_OPENAI_BASE_URL + CNDCTR_OPENAI_MODEL – shortcut: any other OpenAI-compatible endpoint
 *   ANTHROPIC_API_KEY   – Claude joins as the "strong" model
 *   CNDCTR_BRAIN        – force "anthropic" (single model) or "auto" (router)
 *
 * Secrets never live in the models file: entries name the env var that holds the key (apiKeyEnv).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AnthropicBrain, type Brain } from "../brain.js";
import { OpenAICompatBrain } from "./openai.js";
import { DEFAULT_POLICY, RouterBrain, type Candidate } from "./router.js";

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

export function candidatesFrom(file: ModelsFile, env: Env = process.env): Candidate[] {
  return file.models.map((m) => {
    if (m.provider === "anthropic") {
      return { id: m.id ?? `anthropic/${m.model}`, tier: m.tier, cost: m.cost ?? 1, brain: new AnthropicBrain({ model: m.model }) };
    }
    const apiKey = m.apiKeyEnv ? env[m.apiKeyEnv] : undefined;
    return {
      id: m.id ?? `${new URL(m.baseUrl).host}/${m.model}`,
      tier: m.tier,
      cost: m.cost ?? (m.price ? m.price[0] + m.price[1] : 0),
      brain: new OpenAICompatBrain({ baseUrl: m.baseUrl, model: m.model, apiKey, vision: m.vision, price: m.price, headers: m.headers }),
    };
  });
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
  if (env.CNDCTR_OPENAI_BASE_URL && env.CNDCTR_OPENAI_MODEL) {
    models.push({
      provider: "openai",
      baseUrl: env.CNDCTR_OPENAI_BASE_URL,
      model: env.CNDCTR_OPENAI_MODEL,
      tier: (env.CNDCTR_OPENAI_TIER as "fast" | "balanced" | "strong") ?? "balanced",
      apiKeyEnv: env.CNDCTR_OPENAI_API_KEY ? "CNDCTR_OPENAI_API_KEY" : undefined,
      vision: env.CNDCTR_OPENAI_VISION === "on",
    });
  }
  if (!models.length) return null;
  if (env.ANTHROPIC_API_KEY) models.push({ provider: "anthropic", model: env.CNDCTR_MODEL ?? "claude-opus-5-5", tier: "strong" });
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

/** The brain Conductor uses by default. */
export function brainFromEnv(env: Env = process.env, cwd = process.cwd()): Brain {
  if (env.CNDCTR_BRAIN === "anthropic") return new AnthropicBrain();
  const file = env.CNDCTR_MODELS_FILE ?? path.join(cwd, "cndctr.models.json");
  const config = existsSync(file) ? loadModelsFile(file) : modelsFromEnv(env);
  if (!config) {
    if (env.CNDCTR_BRAIN === "auto") throw new Error("CNDCTR_BRAIN=auto needs cndctr.models.json, OMNIROUTE_URL or CNDCTR_OPENAI_BASE_URL");
    return new AnthropicBrain();
  }
  return new RouterBrain(candidatesFrom(config, env), { ...DEFAULT_POLICY, ...config.policy });
}
