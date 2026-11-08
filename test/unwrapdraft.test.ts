import { describe, expect, it } from "vitest";
import { unwrapDraft } from "../src/brains/openai.js";

describe("unwrapDraft", () => {
  it("unwraps a single wrapper object", () => {
    expect(unwrapDraft({ score: { summary: "s", steps: [] } })).toEqual({ summary: "s", steps: [] });
  });
  it("leaves a proper draft alone", () => {
    const d = { summary: "s", steps: [], extra: { a: 1 } };
    expect(unwrapDraft(d)).toBe(d);
  });
  it("leaves non-objects and multi-key objects alone", () => {
    expect(unwrapDraft("x")).toBe("x");
    const m = { a: {}, b: {} };
    expect(unwrapDraft(m)).toBe(m);
  });
});

import { DRAFT_EXAMPLE, isSchemaEcho } from "../src/brains/openai.js";
import { ScoreDraftSchema } from "../src/brain.js";

describe("isSchemaEcho", () => {
  it("spots a schema reply and passes a real draft", () => {
    expect(isSchemaEcho({ $schema: "x", type: "object", properties: {} })).toBe(true);
    expect(isSchemaEcho({ type: "object", properties: { summary: {} } })).toBe(true);
    expect(isSchemaEcho(DRAFT_EXAMPLE)).toBe(false);
  });
  it("ships an example that is itself a valid draft", () => {
    expect(() => ScoreDraftSchema.parse(DRAFT_EXAMPLE)).not.toThrow();
  });
});
