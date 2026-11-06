import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Brain, TurnRequest } from "../src/brain.js";
import { brainFromEnv, loadModelsFile, modelsFromEnv } from "../src/brains/config.js";
import { OpenAICompatBrain, toOpenAIMessages } from "../src/brains/openai.js";
import { RouterBrain, trailingErrors } from "../src/brains/router.js";
import { Architect } from "../src/architect.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";

/** A fake OpenAI-compatible gateway (stands in for OmniRoute / Ollama). */
type Reply = { status?: number; body: unknown };
let server: Server;
let base: string;
const replies: Record<string, Reply[]> = {};
const seen: Array<{ model: string; body: Record<string, unknown> }> = [];
let dir: string;

const chat = (message: Record<string, unknown>, finish = "stop", model?: string): Reply => ({
  body: { model, choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 1000, completion_tokens: 100 } },
});
const call = (name: string, args: unknown, id = `call_${name}`) => chat({ content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architect-models-"));
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "qwen3:8b" }, { id: "auto" }] }));
      return;
    }
    const body = JSON.parse(raw) as Record<string, unknown>;
    const model = String(body.model);
    seen.push({ model, body });
    const r = replies[model]?.shift() ?? { status: 500, body: { error: { message: `no reply scripted for ${model}` } } };
    res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(async () => {
  server.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  seen.length = 0;
  for (const k of Object.keys(replies)) delete replies[k];
});

const brain = (model: string, extra: Partial<ConstructorParameters<typeof OpenAICompatBrain>[0]> = {}) =>
  new OpenAICompatBrain({ baseUrl: base, model, ...extra });

const DRAFT = {
  summary: "Write hello.txt",
  permissions: ["workspace.write", "workspace.read"],
  startUrl: null,
  steps: [{ title: "Write", instruction: "write hello.txt containing hi", instruments: ["workspace"], checkpoint: false }],
  successCriteria: ["hello.txt contains hi"],
};

describe("OpenAI-compatible brain", () => {
  it("translates tools, tool results and screenshots, and reads tool calls back", async () => {
    replies["qwen3:8b"] = [call("workspace_read", { path: "a.txt" })];
    const req: TurnRequest = {
      system: "sys",
      tools: [{ name: "workspace_read", description: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "browser_screenshot", input: {} }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "text", text: "<tool_output>page</tool_output>" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
          ],
        },
      ],
    };
    const out = await brain("qwen3:8b", { price: [1, 2] }).turn(req);
    expect(out.stop_reason).toBe("tool_use");
    expect(out.content[0]).toMatchObject({ type: "tool_use", name: "workspace_read", input: { path: "a.txt" } });
    expect(out.usage?.costUsd).toBeCloseTo((1000 * 1 + 100 * 2) / 1e6);

    const sent = seen[0]!.body as { messages: Array<Record<string, unknown>>; tools: Array<{ function: { name: string } }> };
    expect(sent.tools[0]!.function.name).toBe("workspace_read");
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(sent.messages[3]!.content).toContain("[screenshot omitted");
  });

  it("sends screenshots as image parts to vision models", () => {
    const msgs = toOpenAIMessages(
      "s",
      [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QQ" } }] }],
        },
      ],
      true,
    );
    expect(msgs[2]).toMatchObject({ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,QQ" } }] });
  });

  it("composes a Score from JSON, retrying once when the first reply is invalid", async () => {
    replies["qwen3:8b"] = [chat({ content: "Sure! ```json\n{\"summary\": 1}\n```" }), chat({ content: "```json\n" + JSON.stringify(DRAFT) + "\n```" })];
    const { draft } = await brain("qwen3:8b").compose("sys", "goal");
    expect(draft.steps[0]!.title).toBe("Write");
    expect(seen).toHaveLength(2);
  });

  it("probes the endpoint for the model", async () => {
    expect(await brain("qwen3:8b").probe()).toMatchObject({ ok: true, listed: true });
    expect(await brain("missing-model").probe()).toMatchObject({ ok: true, listed: false });
  });
});

describe("automatic model router", () => {
  const req = (over: Partial<TurnRequest> = {}): TurnRequest => ({ system: "s", messages: [{ role: "user", content: "go" }], tools: [], ...over });

  it("classifies plan, act, recover and verify calls", () => {
    const r = new RouterBrain([{ id: "a", tier: "fast", brain: brain("a") }], { act: "fast" });
    expect(r.classify(req())).toEqual({ task: "act", tier: "fast" });
    expect(r.classify(req({ tools: [{ name: "submit_verdict", input_schema: { type: "object" } }] }))).toEqual({ task: "verify", tier: "strong" });
    const failing = { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "x", content: "boom", is_error: true }] };
    const toolCall = { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "x", name: "t", input: {} }] };
    const msgs = [{ role: "user" as const, content: "go" }, toolCall, failing, toolCall, failing];
    expect(trailingErrors(msgs)).toBe(2);
    expect(r.classify(req({ messages: msgs }))).toEqual({ task: "recover", tier: "balanced" });
  });

  it("prefers the cheapest model of the needed tier and fails over when it errors", async () => {
    let t = 0;
    const r = new RouterBrain(
      [
        { id: "claude", tier: "strong", cost: 5, brain: brain("strong-model") },
        { id: "free-a", tier: "fast", cost: 0, brain: brain("free-a") },
        { id: "free-b", tier: "fast", cost: 1, brain: brain("free-b") },
      ],
      { act: "fast", cooldownMs: 1000 },
      () => t,
    );
    const used: string[] = [];
    r.onRoute = (d) => used.push(d.used);

    replies["free-a"] = [{ status: 429, body: { error: { message: "rate limited" } } }];
    replies["free-b"] = [chat({ content: "ok" }), chat({ content: "ok again" })];
    const out = await r.turn(req());
    expect(out.model).toBe("free-b");
    // free-a is cooling down, so the next call goes straight to free-b.
    await r.turn(req());
    expect(seen.map((s) => s.model)).toEqual(["free-a", "free-b", "free-b"]);

    // Verification needs the strong tier.
    replies["strong-model"] = [chat({ content: "verdict" })];
    await r.turn(req({ tools: [{ name: "submit_verdict", input_schema: { type: "object" } }] }));
    expect(used).toEqual(["free-b", "free-b", "claude"]);

    // After the cooldown free-a is tried first again.
    t = 2000;
    expect(r.order("fast")[0]!.id).toBe("free-a");
  });

  it("falls back to a weaker tier when no strong model is available", async () => {
    const r = new RouterBrain([{ id: "only", tier: "balanced", brain: brain("only") }]);
    replies.only = [chat({ content: JSON.stringify(DRAFT) })];
    const { draft, model } = await r.compose("s", "p");
    expect(draft.summary).toBe("Write hello.txt");
    expect(model).toBe("only");
  });

  it("reports every failure when all models are down", async () => {
    const r = new RouterBrain([{ id: "x", tier: "fast", brain: brain("x") }]);
    await expect(r.turn(req())).rejects.toThrow(/every model failed.*x \(/);
  });
});

describe("Architect on open models", () => {
  it("plans with the strong model, acts with the fast one, and prices each call", async () => {
    const ws = new WorkspaceInstrument(path.join(dir, "ws"));
    await mkdir(ws.root, { recursive: true });
    const router = new RouterBrain(
      [
        { id: "omniroute/auto", tier: "strong", brain: brain("auto", { price: [1, 1] }) },
        { id: "ollama/qwen3", tier: "fast", brain: brain("qwen3:8b") },
      ],
      { act: "fast" },
    );
    replies.auto = [
      chat({ content: JSON.stringify(DRAFT) }, "stop", "claude-via-omniroute"),
      call("submit_verdict", { passed: true, summary: "file written", criteria: [{ criterion: "hello.txt contains hi", met: true, evidence: "read back" }] }),
    ];
    replies["qwen3:8b"] = [call("workspace_write", { path: "hello.txt", content: "hi" }), call("step_complete", { summary: "wrote hello.txt" })];

    const architect = new Architect({ brain: router, instruments: [ws], dataDir: path.join(dir, "data") });
    const run = await architect.run("Write hello.txt containing hi", { autonomy: "autopilot" });

    expect(run.status, run.error).toBe("succeeded");
    expect(await readFile(path.join(ws.root, "hello.txt"), "utf8")).toBe("hi");
    expect(seen.map((s) => s.model)).toEqual(["auto", "qwen3:8b", "qwen3:8b", "auto"]);
    // Two priced calls on the strong model (1100 tokens each at $1/M); the local model is free.
    expect(run.usage.costUsd).toBeCloseTo(2 * 1100 / 1e6, 6);
  });
});

describe("model configuration", () => {
  it("builds a route from OMNIROUTE_URL and adds Claude as the strong model when a key exists", () => {
    const cfg = modelsFromEnv({ OMNIROUTE_URL: "http://localhost:20128/v1", OMNIROUTE_FAST_MODEL: "qwen3:8b", ANTHROPIC_API_KEY: "x" });
    expect(cfg!.models.map((m) => `${m.tier}:${m.model}`)).toEqual(["balanced:auto", "fast:qwen3:8b", "strong:claude-opus-5-5"]);
    expect(modelsFromEnv({})).toBeNull();
    const b = brainFromEnv({ OMNIROUTE_URL: "http://localhost:20128/v1" }, dir);
    expect(b).toBeInstanceOf(RouterBrain);
    expect((b as RouterBrain).candidates).toHaveLength(1);
  });

  it("keeps secrets out of the models file", async () => {
    const file = path.join(dir, "bad.models.json");
    await writeFile(file, JSON.stringify({ models: [{ provider: "openai", baseUrl: base, model: "m", tier: "fast", apiKey: "sk-live" }] }));
    expect(() => loadModelsFile(file)).toThrow(/apiKey|Unrecognized/);
  });

  it("loads the example file", () => {
    const cfg = loadModelsFile(path.resolve("architect.models.example.json"));
    expect(cfg.models).toHaveLength(3);
    expect(cfg.policy?.act).toBe("fast");
  });

  it("uses a single Claude brain when nothing is configured", () => {
    const b: Brain = brainFromEnv({}, dir);
    expect(b).not.toBeInstanceOf(RouterBrain);
  });
});
