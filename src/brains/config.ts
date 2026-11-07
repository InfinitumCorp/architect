/**
 * Choose the brain from configuration.
 *
 * Architect runs on open-weight models by default, through OmniRoute, with open-model
 * backups when they are configured. Nothing proprietary is used unless the models file
 * names it explicitly.
 *
 *   architect.models.json  – explicit model list and routing policy (see architect.models.example.json)
 *   OMNIROUTE_URL       – OmniRoute gateway; default http://localhost:20128/v1, model "auto"
 *   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN – backup: Cloudflare Workers AI open models
 *   GROQ_API_KEY        – backup: Groq open models (gpt-oss, Qwen3)
 *   ARCHITECT_OPENAI_BASE_URL + ARCHITECT_OPENAI_MODEL – any other OpenAI-compatible endpoint (self-hosted vLLM, Ollama)
 *   ARCHITECT_BRAIN        – "anthropic" forces the single Claude brain (opt-in only); "auto" is the default router
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

/** The model list implied by the environment: OmniRoute first, then any configured open-model backups. */
export function modelsFromEnv(env: Env = process.env): ModelsFile {
  const models: ModelsFile["models"] = [];
  {
    const baseUrl = env.OMNIROUTE_URL ?? "http://localhost:20128/v1";
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
  if (env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN) {
    const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`;
    models.push(
      { provider: "openai", id: "workers-ai/gpt-oss-120b", baseUrl, model: "@cf/openai/gpt-oss-120b", tier: "strong", apiKeyEnv: "CLOUDFLARE_AI_TOKEN" },
      { provider: "openai", id: "workers-ai/gpt-oss-20b", baseUrl, model: "@cf/openai/gpt-oss-20b", tier: "fast", apiKeyEnv: "CLOUDFLARE_AI_TOKEN" },
    );
  }
  if (env.GROQ_API_KEY) {
    const baseUrl = "https://api.groq.com/openai/v1";
    models.push(
      { provider: "openai", id: "groq/gpt-oss-120b", baseUrl, model: "openai/gpt-oss-120b", tier: "strong", apiKeyEnv: "GROQ_API_KEY" },
      { provider: "openai", id: "groq/qwen3-32b", baseUrl, model: "qwen/qwen3-32b", tier: "balanced", apiKeyEnv: "GROQ_API_KEY" },
      { provider: "openai", id: "groq/gpt-oss-20b", baseUrl, model: "openai/gpt-oss-20b", tier: "fast", apiKeyEnv: "GROQ_API_KEY" },
    );
  }
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

/** The brain Architect uses by default. */
export function brainFromEnv(env: Env = process.env, cwd = process.cwd()): Brain {
  if (env.ARCHITECT_BRAIN === "anthropic") return new AnthropicBrain();
  const file = env.ARCHITECT_MODELS_FILE ?? path.join(cwd, "architect.models.json");
  const config = existsSync(file) ? loadModelsFile(file) : modelsFromEnv(env);
  return new RouterBrain(candidatesFrom(config, env), { ...DEFAULT_POLICY, ...config.policy });
}
