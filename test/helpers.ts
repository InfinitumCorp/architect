import type { Brain, ContentBlock, ScoreDraft, TurnRequest, TurnResult } from "../src/brain.js";

let n = 0;
export const toolUse = (name: string, input: Record<string, unknown>) =>
  ({ type: "tool_use", id: `toolu_${++n}`, name, input }) as unknown as ContentBlock;
export const text = (t: string) => ({ type: "text", text: t, citations: null }) as unknown as ContentBlock;

/** A deterministic Brain: returns a fixed Score and plays back scripted turns. */
export class ScriptedBrain implements Brain {
  requests: TurnRequest[] = [];
  constructor(
    private draft: ScoreDraft,
    private script: Array<(req: TurnRequest) => ContentBlock[]>,
  ) {}
  async compose(): Promise<ScoreDraft> {
    return this.draft;
  }
  async turn(req: TurnRequest): Promise<TurnResult> {
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return { content: next(req), stop_reason: "tool_use" };
  }
}
