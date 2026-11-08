import { describe, expect, it } from "vitest";
import { OpenAICompatBrain } from "../src/brains/openai.js";
import { toChatCompletion, WORKERS_AI_BASE_URL, workersAiFetch } from "../src/brains/workersai.js";

describe("Workers AI adapter", () => {
  it("converts { response, tool_calls } replies to chat completions", () => {
    const out = toChatCompletion({ response: null, tool_calls: [{ name: "nav", arguments: { url: "x" } }] }, "m");
    expect(out.choices).toEqual([
      { index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: "nav", arguments: '{"url":"x"}' } }] } },
    ]);
  });

  it("drives OpenAICompatBrain through the binding, retrying without response_format", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ai = {
      async run(model: string, input: Record<string, unknown>) {
        calls.push({ model, ...input });
        if (input.response_format) throw new Error("response_format not supported");
        return { choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "browser_navigate", arguments: '{"url":"https://example.com"}' } }] } }] };
      },
    };
    const brain = new OpenAICompatBrain({ baseUrl: WORKERS_AI_BASE_URL, model: "@cf/test", fetch: workersAiFetch(ai) });
    const res = await brain.turn({ system: "s", messages: [{ role: "user", content: "go" }], tools: [{ name: "browser_navigate", description: "", input_schema: { type: "object", properties: {} } }] });
    expect(res.stop_reason).toBe("tool_use");
    expect(res.content[0]).toMatchObject({ type: "tool_use", name: "browser_navigate", input: { url: "https://example.com" } });
    expect(calls[0]!.model).toBe("@cf/test");
  });
});
