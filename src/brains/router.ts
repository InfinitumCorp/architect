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
  /**
   * When every model fails and at least one failure looks transient (network, timeout, 429, 5xx),
   * wait this long and try every model again, once per entry. [] turns retries off.
   */
  retryDelaysMs: number[];
}

export const DEFAULT_POLICY: RouterPolicy = {
  plan: "strong",
  verify: "strong",
  act: "balanced",
  escalateAfterErrors: 2,
  longContextChars: 120_000,
  cooldownMs: 60_000,
  retryDelaysMs: [2_000, 6_000],
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
  /** A model the person picked for this run: tried first whenever it is healthy. */
  private pin?: string;
  private now: () => number;
  /** Waits between retry rounds; tests replace it. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
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
    const pinned = (c: Candidate) => Number(c.id === this.pin);
    return [...this.candidates].sort(
      (a, b) =>
        Number(healthy(b)) - Number(healthy(a)) || pinned(b) - pinned(a) || rank(a) - rank(b) || (a.cost ?? 0) - (b.cost ?? 0),
    );
  }

  /** The choices a person can pick from: automatic routing, a tier, or one model. */
  choices(): Array<{ id: string; label: string; tier?: Tier }> {
    const tiers = TIERS.filter((t) => this.candidates.some((c) => c.tier === t));
    return [
      { id: "auto", label: "Auto" },
      ...(tiers.length > 1 ? tiers.map((t) => ({ id: t, label: t[0]!.toUpperCase() + t.slice(1), tier: t })) : []),
      ...this.candidates.map((c) => ({ id: c.id, label: c.id.replace(`#${c.tier}`, ""), tier: c.tier })),
    ];
  }

  /**
   * The same router steered by a person's choice: a tier runs every call at that tier, a model id
   * is tried first on every call. Failover still applies, and health is shared with this router.
   */
  pinned(choice: string): RouterBrain {
    if (!choice || choice === "auto") return this;
    const r = Object.create(RouterBrain.prototype) as RouterBrain;
    const tier = (TIERS as string[]).includes(choice) ? (choice as Tier) : undefined;
    if (!tier && !this.candidates.some((c) => c.id === choice)) throw new Error(`unknown model "${choice}"`);
    Object.assign(r, this, {
      policy: tier ? { ...this.policy, plan: tier, act: tier, verify: tier } : this.policy,
      pin: tier ? undefined : choice,
    });
    return r;
  }

  private async route<T extends { model?: string }>(task: Task, tier: Tier, call: (b: Brain) => Promise<T>): Promise<T> {
    const failures: Array<{ id: string; error: string }> = [];
    const delays = this.policy.retryDelaysMs ?? [];
    for (let round = 0; ; round++) {
      const order = this.order(tier);
      const roundFailures: string[] = [];
      for (const c of order) {
        try {
          const out = await call(c.brain);
          this.down.delete(c.id);
          this.onRoute?.({ task, tier, order: order.map((o) => o.id), used: c.id, failures });
          return { ...out, model: out.model ?? c.brain.model };
        } catch (err) {
          if (isFatal(err)) throw err;
          const error = err instanceof Error ? err.message : String(err);
          failures.push({ id: c.id, error });
          roundFailures.push(error);
          this.down.set(c.id, this.now() + this.policy.cooldownMs);
        }
      }
      // A dropped connection or a busy provider often clears in seconds: wait and go round again.
      if (round >= delays.length || !roundFailures.some(isTransient)) break;
      await this.sleep(delays[round]!);
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

/** Failures that may clear on their own: the network, a timeout, rate limits, a busy or failing server. */
export function isTransient(message: string): boolean {
  return /fetch failed|network|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|timed? ?out|rate.?limit|overloaded|temporarily|unavailable|\b(408|425|429|500|502|503|504|520|521|522|523|524|529)\b/i.test(message);
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
