import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { PERMISSIONS } from "./types.js";
import type { TurnUsage } from "./usage.js";

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
export type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
export type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
export type ToolResultBlockParam = Anthropic.Beta.Messages.BetaToolResultBlockParam;
export type ToolDef = Anthropic.Beta.Messages.BetaTool;

export const ScoreDraftSchema = z.object({
  summary: z.string().describe("One or two sentences: what this Score does and how"),
  permissions: z.array(z.enum(PERMISSIONS)).describe("The smallest set of permissions the Score needs"),
  startUrl: z.string().nullable().describe("Where the browser should start, if a browser is needed"),
  steps: z
    .array(
      z.object({
        title: z.string(),
        instruction: z.string().describe("Concrete instruction for the performer. Reference inputs as {{name}}."),
        instruments: z.array(z.string()).describe("Instrument names this step may use"),
        checkpoint: z.boolean().describe("True if a person should approve before this step starts"),
      }),
    )
    .min(1),
  successCriteria: z.array(z.string()).min(1).describe("Observable facts that prove the goal is done"),
});
export type ScoreDraft = z.infer<typeof ScoreDraftSchema>;

export interface TurnRequest {
  system: string;
  messages: MessageParam[];
  tools: ToolDef[];
}

export interface TurnResult {
  content: ContentBlock[];
  stop_reason: string | null;
  usage?: TurnUsage;
  /** The model that actually answered (a router or gateway may pick it). Used for pricing. */
  model?: string;
}

export interface ComposeResult {
  draft: ScoreDraft;
  usage?: TurnUsage;
  model?: string;
}

/** The model behind Conductor. Swappable so tests (and on-prem #THRONE runs) can supply their own. */
export interface Brain {
  /** Model id, used for pricing. */
  readonly model: string;
  compose(system: string, prompt: string): Promise<ComposeResult>;
  turn(req: TurnRequest): Promise<TurnResult>;
}

function toUsage(u: {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): TurnUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

export interface AnthropicBrainOptions {
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Server-side refusal fallback ("default" routing). On by default; set false on Bedrock/Vertex/Foundry. */
  fallbacks?: boolean;
  client?: Anthropic;
}

export class AnthropicBrain implements Brain {
  readonly model: string;
  private _client?: Anthropic;
  private effort: NonNullable<AnthropicBrainOptions["effort"]>;
  private fallbacks: boolean;

  constructor(opts: AnthropicBrainOptions = {}) {
    this._client = opts.client;
    this.model = opts.model ?? process.env.CNDCTR_MODEL ?? "claude-opus-5-5";
    this.effort = opts.effort ?? (process.env.CNDCTR_EFFORT as AnthropicBrainOptions["effort"]) ?? "high";
    this.fallbacks = opts.fallbacks ?? process.env.CNDCTR_FALLBACKS !== "off";
  }

  /** Created on first use, so commands that never call the model work without credentials. */
  private get client(): Anthropic {
    return (this._client ??= new Anthropic());
  }

  async compose(system: string, prompt: string): Promise<ComposeResult> {
    const res = await this.client.messages.parse({
      model: this.model,
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort, format: zodOutputFormat(ScoreDraftSchema) },
      system,
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") throw new Error("the model declined to compose this Score");
    if (!res.parsed_output) throw new Error(`could not parse the Score (stop_reason: ${res.stop_reason})`);
    return { draft: res.parsed_output, usage: toUsage(res.usage) };
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const betas = ["context-management-2025-06-27"];
    if (this.fallbacks) betas.push("server-side-fallback-2026-07-01");
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      output_config: { effort: this.effort },
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools,
      messages: req.messages,
      betas,
      // Old tool results (page snapshots, screenshots) are cleared as the conversation grows.
      context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
      ...(this.fallbacks ? { fallbacks: "default" as const } : {}),
    });
    return { content: res.content, stop_reason: res.stop_reason, usage: toUsage(res.usage) };
  }
}
