import { describe, expect, it } from "vitest";
import { performSystem } from "../src/prompts.js";
import type { Run, ScoreStep } from "../src/types.js";

const steps = [
  { id: "s1", title: "Read greet.js" },
  { id: "s2", title: "Add farewell" },
  { id: "s3", title: "Run tests" },
] as ScoreStep[];

const run = {
  autonomy: "autopilot",
  score: { goal: "Add farewell()", summary: "Add and test farewell", inputs: {}, successCriteria: ["tests pass"], steps },
  steps: [
    { id: "s1", status: "completed", summary: "Read greet.js and already added farewell()" },
    { id: "s2", status: "running" },
    { id: "s3", status: "pending" },
  ],
} as unknown as Run;

describe("step prompt", () => {
  it("marks the current step and keeps the model to it", () => {
    const text = performSystem(run, steps[1]!, []);
    expect(text).toContain("2. [running] Add farewell   <- this step");
    expect(text).not.toContain("Read greet.js and already added farewell()   <- this step");
    expect(text).toMatch(/do only the step marked "<- this step" \(Add farewell\)/);
    expect(text).toMatch(/without redoing it/);
  });
});
