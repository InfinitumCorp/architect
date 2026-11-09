import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Brain, TurnRequest, TurnResult } from "../src/brain.js";
import { brainFromEnv, candidatesFrom, geminiCandidate, loadModelsFile, modelsFromEnv } from "../src/brains/config.js";
import { DEFAULT_GEMINI_MODEL, GEMINI_MODELS_URL, GEMINI_OPENAI_BASE, GeminiBrain, assertFreeTierChatModel } from "../src/brains/gemini.js";
import { RouterBrain } from "../src/brains/router.js";
import { costOf } from "../src/usage.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architect-gemini-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const req = (): TurnRequest => ({ system: "s", messages: [{ role: "user", content: "go" }], tools: [] });

class StubBrain implements Brain {
  calls = 0;
  constructor(readonly model: string) {}
  async compose(): Promise<never> {
    throw new Error("stub");
  }
  async turn(): Promise<TurnResult> {
    this.calls += 1;
    return { content: [], stop_reason: "end_turn", model: this.model };
  }
}

function jsonFetch(status: number, body: unknown, seen: Array<{ url: string; init?: RequestInit }>): typeof fetch {
  return (async (input, init) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("Gemini provider disabled", () => {
  it("stays off without a key and does not replace Claude or Workers AI", () => {
    expect(geminiCandidate({})).toBeNull();
    expect(geminiCandidate({ GEMINI_API_KEY: "  " })).toBeNull();
    expect(modelsFromEnv({})).toBeNull();
    // The key alone is not an OmniRoute/OpenAI shortcut, so modelsFromEnv stays empty.
    expect(modelsFromEnv({ GEMINI_API_KEY: "test-key" })).toBeNull();

    let called = false;
    const fetchImpl = (() => {
      called = true;
      throw new Error("Gemini was called while disabled");
    }) as typeof fetch;

    const plain = brainFromEnv({}, dir, { fetch: fetchImpl });
    expect(plain).not.toBeInstanceOf(RouterBrain);
    expect(plain).not.toBeInstanceOf(GeminiBrain);
    expect(called).toBe(false);

    const workers = new StubBrain("@cf/zai-org/glm-4.7-flash");
    expect(brainFromEnv({}, dir, { workersAi: workers, fetch: fetchImpl })).toBe(workers);

    const forced = brainFromEnv({ ARCHITECT_BRAIN: "anthropic", GEMINI_API_KEY: "test-key" }, dir, { fetch: fetchImpl });
    expect(forced).not.toBeInstanceOf(RouterBrain);
    expect(called).toBe(false);
  });

  it("skips a models-file Gemini entry when the key is unset, and rejects a raw key", async () => {
    const example = loadModelsFile(path.resolve("architect.models.example.json"));
    const ids = candidatesFrom(example, {}).map((c) => c.id);
    expect(ids.some((id) => id.startsWith("gemini/"))).toBe(false);
    expect(ids).toContain("anthropic/claude-opus-5-5");

    const secretFile = path.join(dir, "secret.models.json");
    await writeFile(secretFile, JSON.stringify({ models: [{ provider: "gemini", model: DEFAULT_GEMINI_MODEL, tier: "fast", apiKey: "should-not-be-here" }] }));
    expect(() => loadModelsFile(secretFile)).toThrow(/apiKey|Unrecognized/);

    const vertexFile = path.join(dir, "vertex.models.json");
    await writeFile(
      vertexFile,
      JSON.stringify({ models: [{ provider: "gemini", baseUrl: "https://aiplatform.googleapis.com/v1", model: DEFAULT_GEMINI_MODEL, tier: "fast" }] }),
    );
    expect(() => loadModelsFile(vertexFile)).toThrow(/baseUrl|Unrecognized/);

    const paidFile = path.join(dir, "paid.models.json");
    await writeFile(paidFile, JSON.stringify({ models: [{ provider: "gemini", model: "gemini-4-argon", tier: "fast" }] }));
    expect(() => candidatesFrom(loadModelsFile(paidFile), {})).toThrow(/free-tier|paid/);

    const onlyGemini = path.join(dir, "only-gemini.models.json");
    await writeFile(onlyGemini, JSON.stringify({ models: [{ provider: "gemini", tier: "fast" }] }));
    expect(() => candidatesFrom(loadModelsFile(onlyGemini), {})).toThrow(/stays off/);
  });
});

describe("Gemini provider enabled (mocked)", () => {
  it("rejects Vertex and paid model ids before any request", () => {
    expect(assertFreeTierChatModel("gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
    expect(assertFreeTierChatModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(() => assertFreeTierChatModel("projects/p/locations/us/publishers/google/models/gemini-3.5-flash-lite")).toThrow(/Vertex/);
    expect(() => assertFreeTierChatModel("gemini-3.1-pro-preview")).toThrow(/free-tier/);
    expect(() => brainFromEnv({ GEMINI_API_KEY: "test-key", ARCHITECT_GEMINI_MODEL: "gemini-omni-1.2-flash" }, dir)).toThrow(/free-tier/);
    expect(costOf({ inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, DEFAULT_GEMINI_MODEL)).toBe(0);
  });

  it("keeps Claude and Workers AI primary, and adds Gemini as the fast model", () => {
    const cli = brainFromEnv({ GEMINI_API_KEY: "test-key", ARCHITECT_MODEL: "claude-opus-5-5" }, dir) as RouterBrain;
    expect(cli).toBeInstanceOf(RouterBrain);
    expect(cli.candidates.map((c) => c.id)).toEqual(["anthropic/claude-opus-5-5", `gemini/${DEFAULT_GEMINI_MODEL}`]);
    expect(cli.order("strong")[0]!.id).toBe("anthropic/claude-opus-5-5");
    expect(cli.order("balanced")[0]!.id).toBe("anthropic/claude-opus-5-5");
    expect(cli.order("fast")[0]!.id).toBe(`gemini/${DEFAULT_GEMINI_MODEL}`);
    expect(cli.candidates[1]!.brain).toBeInstanceOf(GeminiBrain);

    const workers = new StubBrain("@cf/zai-org/glm-4.7-flash");
    const hosted = brainFromEnv({ GEMINI_API_KEY: "test-key" }, dir, { workersAi: workers }) as RouterBrain;
    expect(hosted.order("balanced")[0]!.id).toBe("workers-ai/@cf/zai-org/glm-4.7-flash");
    expect(hosted.order("fast")[0]!.id).toBe(`gemini/${DEFAULT_GEMINI_MODEL}`);
    expect(hosted.candidates.some((c) => c.id.startsWith("anthropic/"))).toBe(false);

    const claudeWins = brainFromEnv({ ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "test-key", ARCHITECT_MODEL: "claude-opus-5-5" }, dir, { workersAi: workers }) as RouterBrain;
    expect(claudeWins.order("strong")[0]!.id).toBe("anthropic/claude-opus-5-5");
    expect(claudeWins.candidates.some((c) => c.id.startsWith("workers-ai/"))).toBe(false);

    const alongside = brainFromEnv(
      { OMNIROUTE_URL: "http://localhost:20128/v1", ANTHROPIC_API_KEY: "x", GEMINI_API_KEY: "test-key" },
      dir,
    ) as RouterBrain;
    expect(alongside.order("balanced")[0]!.id).toBe("omniroute/auto#balanced");
    expect(alongside.order("strong")[0]!.id).toBe("anthropic/claude-opus-5-5");
    expect(alongside.candidates.map((c) => c.id)).toContain(`gemini/${DEFAULT_GEMINI_MODEL}`);
  });

  it("calls the AI Studio OpenAI-compatible endpoint with the key, not Vertex", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = jsonFetch(
      200,
      {
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
      seen,
    );
    const brain = new GeminiBrain({ apiKey: "test-key", fetch: fetchImpl });
    const out = await brain.turn(req());
    expect(out.stop_reason).toBe("end_turn");
    expect(out.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(out.usage?.costUsd).toBe(0);
    expect(seen).toHaveLength(1);
    const hit = seen[0]!;
    expect(hit.url).toBe(`${GEMINI_OPENAI_BASE}/chat/completions`);
    expect(hit.url).not.toContain("aiplatform.googleapis.com");
    expect(hit.url).not.toContain("test-key");
    const headers = hit.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-key");
    const body = JSON.parse(String(hit.init?.body)) as { model: string };
    expect(body.model).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("probes the AI Studio model list", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = jsonFetch(200, { models: [{ name: `models/${DEFAULT_GEMINI_MODEL}` }, { name: "models/gemini-3.8-flash" }] }, seen);
    const brain = new GeminiBrain({ apiKey: "test-key", fetch: fetchImpl });
    expect(await brain.probe()).toMatchObject({ ok: true, listed: true, models: 2 });
    expect(seen[0]!.url).toBe(GEMINI_MODELS_URL);
    expect(seen[0]!.url).not.toContain("test-key");
    expect((seen[0]!.init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("falls back to the next model on a free-tier 429 and then skips Gemini until the cooldown ends", async () => {
    const seen: Array<{ url: string }> = [];
    let limited = true;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input) });
      void init;
      if (limited) {
        return new Response(JSON.stringify({ error: { message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const claude = new StubBrain("claude-opus-5-5");
    let now = 0;
    const router = new RouterBrain(
      [
        { id: `gemini/${DEFAULT_GEMINI_MODEL}`, tier: "fast", cost: 1, brain: new GeminiBrain({ apiKey: "test-key", fetch: fetchImpl }) },
        { id: "anthropic/claude-opus-5-5", tier: "strong", cost: 1, brain: claude },
      ],
      { act: "fast", cooldownMs: 60_000 },
      () => now,
    );
    const decisions: Array<{ used: string; failures: string[] }> = [];
    router.onRoute = (d) => decisions.push({ used: d.used, failures: d.failures.map((f) => f.error) });

    const first = await router.turn(req());
    expect(first.model).toBe("claude-opus-5-5");
    expect(claude.calls).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe(`${GEMINI_OPENAI_BASE}/chat/completions`);
    expect(decisions[0]!.used).toBe("anthropic/claude-opus-5-5");
    expect(decisions[0]!.failures[0]).toMatch(/HTTP 429/);
    expect(decisions[0]!.failures[0]).toMatch(/falling back/);

    await router.turn(req());
    expect(seen).toHaveLength(1);
    expect(claude.calls).toBe(2);

    limited = false;
    now = 60_000;
    const again = await router.turn(req());
    expect(again.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(seen).toHaveLength(2);
    expect(claude.calls).toBe(2);
  });

  it("uses a models-file Gemini entry only when its key env is set", () => {
    const file = loadModelsFile(path.resolve("architect.models.example.json"));
    const on = candidatesFrom(file, { GEMINI_API_KEY: "test-key" });
    const gemini = on.find((c) => c.id === `gemini/${DEFAULT_GEMINI_MODEL}`);
    expect(gemini?.tier).toBe("fast");
    expect(gemini?.brain).toBeInstanceOf(GeminiBrain);
    expect(on.filter((c) => c.id.startsWith("gemini/"))).toHaveLength(1);
  });
});
