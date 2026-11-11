import { describe, expect, it } from "vitest";
import { FREE_MAX_TOKENS, freeModel } from "../src/free.js";

const at = (path: string, init?: RequestInit) => new Request(`https://rchtch.app${path}`, init);
const chat = (body: unknown, ip = "1.2.3.4") =>
  at("/free/v1/chat/completions", { method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": ip } });

function fakeAi() {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    async run(model: string, input: Record<string, unknown>) {
      calls.push({ model, input });
      return { response: "hello", usage: { prompt_tokens: 3, completion_tokens: 1 } };
    },
  };
}

describe("free model endpoint", () => {
  it("answers OpenAI chat completions with the free model, capped", async () => {
    const ai = fakeAi();
    const res = (await freeModel(chat({ model: "gpt-5", max_tokens: 100_000, stream: true, messages: [{ role: "user", content: "hi" }] }), { AI: ai }))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const out = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(out.choices[0]!.message.content).toBe("hello");
    // Another model name is replaced by the free one; the reply size is capped; no streaming.
    expect(ai.calls[0]!.model).toBe("@cf/zai-org/glm-4.7-flash");
    expect(ai.calls[0]!.input.max_tokens).toBe(FREE_MAX_TOKENS);
    expect(ai.calls[0]!.input.stream).toBeUndefined();
  });

  it("lists models, ignores other paths, and refuses bad or excess requests", async () => {
    const ai = fakeAi();
    expect(await freeModel(at("/v1/runs"), { AI: ai })).toBeUndefined();
    const list = (await (await freeModel(at("/free/v1/models"), { AI: ai }))!.json()) as { data: Array<{ id: string }> };
    expect(list.data.map((m) => m.id)).toEqual(["@cf/zai-org/glm-4.7-flash"]);
    expect((await freeModel(chat({}), { AI: ai }))!.status).toBe(400);
    expect((await freeModel(at("/free/v1/chat/completions"), { AI: ai }))!.status).toBe(405);
    expect((await freeModel(chat({ messages: [{ role: "user", content: "x" }] }), {}))!.status).toBe(503);
    expect((await freeModel(chat({ messages: [{ role: "user", content: "x" }] }), { AI: ai, ARCHITECT_FREE: "off" }))!.status).toBe(503);
    const seen = new Map<string, number>();
    const FREE_RATE = { async limit({ key }: { key: string }) { seen.set(key, (seen.get(key) ?? 0) + 1); return { success: seen.get(key)! <= 1 }; } };
    const msg = { messages: [{ role: "user", content: "x" }] };
    expect((await freeModel(chat(msg), { AI: ai, FREE_RATE }))!.status).toBe(200);
    const limited = (await freeModel(chat(msg), { AI: ai, FREE_RATE }))!;
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await freeModel(chat(msg, "5.6.7.8"), { AI: ai, FREE_RATE }))!.status).toBe(200);
  });
});
