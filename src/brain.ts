import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { PERMISSIONS } from "./types.js";

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
}

/** The model behind Conductor. Swappable so tests (and on-prem #THRONE runs) can supply their own. */
export interface Brain {
  compose(system: string, prompt: string): Promise<ScoreDraft>;
  turn(req: TurnRequest): Promise<TurnResult>;
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
  private client: Anthropic;
  private effort: NonNullable<AnthropicBrainOptions["effort"]>;
  private fallbacks: boolean;

  constructor(opts: AnthropicBrainOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? process.env.CNDCTR_MODEL ?? "claude-opus-5-5";
    this.effort = opts.effort ?? (process.env.CNDCTR_EFFORT as AnthropicBrainOptions["effort"]) ?? "high";
    this.fallbacks = opts.fallbacks ?? process.env.CNDCTR_FALLBACKS !== "off";
  }

  async compose(system: string, prompt: string): Promise<ScoreDraft> {
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
    return res.parsed_output;
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
    return { content: res.content, stop_reason: res.stop_reason };
  }
}
