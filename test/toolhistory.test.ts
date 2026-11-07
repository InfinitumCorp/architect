import { describe, expect, it } from "vitest";
import { toTextToolHistory, type OAMessage } from "../src/brains/openai.js";

describe("toTextToolHistory", () => {
  it("replays tool calls and results as plain text", () => {
    const native = [
      { role: "system", content: "sys" },
      { role: "user", content: "open it" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "nav", arguments: '{"url":"x"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "loaded" },
      { role: "user", content: "screenshot omitted" },
    ] as unknown as OAMessage[];
    const out = toTextToolHistory(native);
    expect(out.some((m) => m.role === "tool")).toBe(false);
    expect(out.some((m) => "tool_calls" in m)).toBe(false);
    expect(out[2]).toEqual({ role: "assistant", content: '[tool call nav {"url":"x"}]' });
    expect(out[3]).toEqual({ role: "user", content: "[tool result for nav]\nloaded\n\nscreenshot omitted" });
  });
});
