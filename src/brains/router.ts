/**
 * Automatic model selection. Each call is classified, routed to the cheapest healthy model of
 * the tier it needs, escalated when the work gets hard, and failed over when a model errors.
 *
 *   plan    – composing a Score              → strong
 *   verify  – judging the outcome            → strong
 *   act     – an ordinary step turn          → fast or balanced
 *   recover – a step that is erroring        → one tier up
 */
import type { Brain, ComposeResult, MessageParam, TurnRequest, TurnResult } from "../brain.js";

export type Tier = "fast" | "balanced" | "strong";
export type Task = "plan" | "act" | "recover" | "verify";
const TIERS: Tier[] = ["fast", "balanced", "strong"];

export interface Candidate {
  /** Display id, e.g. "omniroute/auto" or "anthropic/claude-opus-5-5". */
  id: string;
  tier: Tier;
  brain: Brain;
  /** Relative cost, lower is preferred within a tier. Default 0 (free / self-hosted). */
  cost?: number;
}

export interface RouterPolicy {
  plan: Tier;
  verify: Tier;
  act: Tier;
  /** Consecutive failing tool results in a step before escalating. */
  escalateAfterErrors: number;
  /** Approximate context size (characters) above which act turns use at least "balanced". */
  longContextChars: number;
  /** How long a failed model sits out. */
  cooldownMs: number;
}

export const DEFAULT_POLICY: RouterPolicy = {
  plan: "strong",
  verify: "strong",
  act: "balanced",
  escalateAfterErrors: 2,
  longContextChars: 120_000,
  cooldownMs: 60_000,
};

export interface RouteDecision {
  task: Task;
  tier: Tier;
  order: string[];
}

export class RouterBrain implements Brain {
  readonly candidates: Candidate[];
  readonly policy: RouterPolicy;
  private down = new Map<string, number>();
  private now: () => number;
  /** Called on every routed call; Architect can log it. */
  onRoute?: (d: RouteDecision & { used: string; failures: Array<{ id: string; error: string }> }) => void;

  constructor(candidates: Candidate[], policy: Partial<RouterPolicy> = {}, now: () => number = Date.now) {
    if (!candidates.length) throw new Error("the model router needs at least one model");
    this.candidates = candidates;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.now = now;
  }

  /** The id of the default (strongest preferred) model, used for estimates. */
  get model(): string {
    return this.order("strong")[0]!.brain.model;
  }

  classify(req: TurnRequest): { task: Task; tier: Tier } {
    if (req.tools.some((t) => t.name === "submit_verdict")) return { task: "verify", tier: this.policy.verify };
    const base = this.policy.act;
    if (trailingErrors(req.messages) >= this.policy.escalateAfterErrors) return { task: "recover", tier: up(base) };
    if (approxChars(req) > this.policy.longContextChars && TIERS.indexOf(base) < 1) return { task: "act", tier: "balanced" };
    return { task: "act", tier: base };
  }

  /** Healthy models of the wanted tier (cheapest first), then stronger tiers, then weaker ones; cooling-down models last. */
  order(tier: Tier): Candidate[] {
    const rank = (c: Candidate) => {
      const d = TIERS.indexOf(c.tier) - TIERS.indexOf(tier);
      return d === 0 ? 0 : d > 0 ? d : 10 - d;
    };
    const t = this.now();
    const healthy = (c: Candidate) => (this.down.get(c.id) ?? 0) <= t;
    return [...this.candidates].sort(
      (a, b) => Number(healthy(b)) - Number(healthy(a)) || rank(a) - rank(b) || (a.cost ?? 0) - (b.cost ?? 0),
    );
  }

  private async route<T extends { model?: string }>(task: Task, tier: Tier, call: (b: Brain) => Promise<T>): Promise<T> {
    const order = this.order(tier);
    const failures: Array<{ id: string; error: string }> = [];
    for (const c of order) {
      try {
        const out = await call(c.brain);
        this.down.delete(c.id);
        this.onRoute?.({ task, tier, order: order.map((o) => o.id), used: c.id, failures });
        return { ...out, model: out.model ?? c.brain.model };
      } catch (err) {
        if (isFatal(err)) throw err;
        failures.push({ id: c.id, error: err instanceof Error ? err.message : String(err) });
        this.down.set(c.id, this.now() + this.policy.cooldownMs);
      }
    }
    throw new Error(`every model failed for this ${task} call: ${failures.map((f) => `${f.id} (${f.error})`).join("; ")}`);
  }

  compose(system: string, prompt: string): Promise<ComposeResult> {
    return this.route("plan", this.policy.plan, (b) => b.compose(system, prompt));
  }

  turn(req: TurnRequest): Promise<TurnResult> {
    const { task, tier } = this.classify(req);
    return this.route(task, tier, (b) => b.turn(req));
  }
}

function up(t: Tier): Tier {
  return TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(t) + 1)]!;
}

/** Errors no other model would fix (the user cancelled). */
function isFatal(err: unknown) {
  return err instanceof Error && (err.name === "AbortError" || /cancelled/i.test(err.message));
}

/** Count the failing tool results at the end of the conversation. */
export function trailingErrors(messages: MessageParam[]): number {
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user" || typeof m.content === "string") continue;
    const results = (m.content as Array<{ type: string; is_error?: boolean }>).filter((b) => b.type === "tool_result");
    if (!results.length) continue;
    if (results.some((r) => r.is_error)) n++;
    else break;
  }
  return n;
}

function approxChars(req: TurnRequest): number {
  return req.system.length + JSON.stringify(req.messages).length;
}
