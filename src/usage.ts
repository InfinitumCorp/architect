import type { Score } from "./types.js";

/** Token usage for one model call. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Exact cost when the brain knows it (open models, gateways). Overrides the price table. */
  costUsd?: number;
}

export interface RunUsage extends Omit<TurnUsage, "costUsd"> {
  calls: number;
  costUsd: number;
}

/** USD per million tokens: input, output, cache read, cache write (5-minute). */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-fable-5-1": [10, 50, 0.25, 12.5],
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
};

export function priceFor(model: string): [number, number, number, number] {
  return PRICES[model] ?? PRICES["claude-opus-5-5"]!;
}

export function emptyUsage(): RunUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

export function costOf(u: TurnUsage, model: string): number {
  const [i, o, r, w] = priceFor(model);
  return (u.inputTokens * i + u.outputTokens * o + u.cacheReadTokens * r + u.cacheWriteTokens * w) / 1_000_000;
}

export function addUsage(total: RunUsage, u: TurnUsage, model: string): RunUsage {
  total.calls += 1;
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens += u.cacheReadTokens;
  total.cacheWriteTokens += u.cacheWriteTokens;
  total.costUsd = Math.round((total.costUsd + (u.costUsd ?? costOf(u, model))) * 1e6) / 1e6;
  return total;
}

/**
 * A rough pre-run estimate. Assumes 6–20 model turns per step plus verification, with most
 * input served from the prompt cache. Shown before long runs so nobody is surprised by the bill.
 */
export function estimateCost(score: Score, model: string): { lowUsd: number; highUsd: number } {
  const steps = score.steps.length + 1; // + verification
  const perTurn = (cachedIn: number, freshIn: number, out: number) =>
    costOf({ inputTokens: freshIn, outputTokens: out, cacheReadTokens: cachedIn, cacheWriteTokens: freshIn / 2 }, model);
  const low = steps * 6 * perTurn(8_000, 2_000, 600);
  const high = steps * 20 * perTurn(30_000, 6_000, 2_000);
  return { lowUsd: Math.round(low * 100) / 100, highUsd: Math.round(high * 100) / 100 };
}
