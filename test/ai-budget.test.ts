// The shared Workers AI ledger: Architect's Workers AI brain is refused, not billed, past the free allowance.
import { describe, expect, it } from "vitest";
import { workersAiFetch } from "../src/brains/workersai.js";
import { budgetedAI } from "../src/brains/ai-budget.mjs";
import { freeModel } from "../src/free.js";

function ledger(limit: number) {
  let used = 0;
  const stub = {
    reserve: async (_l: number, amount: number) => (used + amount > limit ? { ok: false, used, limit } : ((used += amount), { ok: true, used, limit })),
    settle: async (_d: string, reserved: number, actual: number) => void (used = used - reserved + actual),
  };
  return { ns: { idFromName: () => "daily", get: () => stub } as any, used: () => used };
}

const call = (f: typeof fetch) =>
  f("https://workers-ai.binding/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "@cf/qwen/qwen3-30b-a3b-fp8", messages: [{ role: "user", content: "hi" }], max_tokens: 100 }) });

describe("shared AI budget", () => {
  it("charges real usage and answers normally", async () => {
    const l = ledger(100);
    const res = await call(workersAiFetch(budgetedAI({ run: async () => ({ response: "ok", usage: { neurons: 2 } }) }, l.ns)));
    expect(res.status).toBe(200);
    expect(l.used()).toBe(2);
  });

  it("refuses past the allowance without calling the model", async () => {
    let ran = false;
    const res = await call(workersAiFetch(budgetedAI({ run: async () => ((ran = true), {}) }, ledger(0).ns)));
    expect(res.status).toBe(429);
    expect((await res.json()).error.message).toMatch(/free daily AI allowance is used up/);
    expect(ran).toBe(false);
  });

  it("covers the public free model at /free/v1 too", async () => {
    let ran = false;
    const res = (await freeModel(
      new Request("https://rchtch.app/free/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }) }),
      { AI: { run: async () => ((ran = true), {}) }, AI_BUDGET: ledger(0).ns },
    ))!;
    expect(res.status).toBe(429);
    expect(ran).toBe(false);
  });
});
