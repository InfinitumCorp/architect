import path from "node:path";
import { AnthropicBrain, type AnthropicBrainOptions, type Brain } from "./brain.js";
import { brainFromEnv } from "./brains/config.js";
import { Conductor, type ConductorOptions } from "./conductor.js";
import { BrowserInstrument, type BrowserInstrumentOptions } from "./instruments/browser.js";
import { EcosystemInstrument } from "./instruments/ecosystem.js";
import { HttpInstrument } from "./instruments/http.js";
import { WorkspaceInstrument } from "./instruments/workspace.js";

export * from "./types.js";
export { Conductor } from "./conductor.js";
export type { ConductorOptions, ComposeOptions, PerformOptions } from "./conductor.js";
export { AnthropicBrain, ScoreDraftSchema } from "./brain.js";
export { OpenAICompatBrain, ModelCallError, type OpenAICompatOptions } from "./brains/openai.js";
export { RouterBrain, DEFAULT_POLICY, type Candidate, type RouterPolicy, type Tier, type Task } from "./brains/router.js";
export { brainFromEnv, loadModelsFile, modelsFromEnv, ModelsFileSchema } from "./brains/config.js";
export type { Brain, ScoreDraft, TurnRequest, TurnResult } from "./brain.js";
export { RunStore } from "./store.js";
export { gate, classifyByLabel, classifyCommand } from "./policy.js";
export { BrowserInstrument } from "./instruments/browser.js";
export { WorkspaceInstrument } from "./instruments/workspace.js";
export { HttpInstrument } from "./instruments/http.js";
export { EcosystemInstrument, INFINITUM_PRODUCTS, productsFromEnv } from "./instruments/ecosystem.js";
export type { Instrument, ToolSpec, ToolContext, ToolOutput } from "./instruments/types.js";
export { TriggerRouter, type TriggerRule } from "./triggers.js";
export { ScoreLibrary, type SavedScore, digestOf } from "./library.js";
export { Scheduler, ScheduleStore, validateSchedule, isDue, type Schedule } from "./schedules.js";
export { estimateCost, costOf, type RunUsage, type TurnUsage } from "./usage.js";
export { createConductorServer } from "./server.js";

export interface CreateConductorOptions extends Partial<Omit<ConductorOptions, "brain" | "instruments">> {
  brain?: Brain;
  brainOptions?: AnthropicBrainOptions;
  browser?: BrowserInstrumentOptions | false;
  /** Folder Conductor may read, write and run commands in. Defaults to <dataDir>/workspace. */
  workspace?: string | false;
  http?: boolean;
  ecosystem?: boolean;
}

/** A Conductor with the standard instruments: browser, workspace, HTTP and the Infinitum ecosystem. */
export function createConductor(opts: CreateConductorOptions = {}): Conductor {
  const dataDir = path.resolve(opts.dataDir ?? process.env.CNDCTR_DATA_DIR ?? ".cndctr");
  const instruments = [];
  if (opts.browser !== false) instruments.push(new BrowserInstrument(opts.browser ?? {}));
  if (opts.workspace !== false) {
    instruments.push(new WorkspaceInstrument(opts.workspace ?? process.env.CNDCTR_WORKSPACE ?? path.join(dataDir, "workspace")));
  }
  if (opts.http !== false) instruments.push(new HttpInstrument());
  if (opts.ecosystem !== false) instruments.push(new EcosystemInstrument());
  return new Conductor({
    ...opts,
    dataDir,
    brain: opts.brain ?? (opts.brainOptions ? new AnthropicBrain(opts.brainOptions) : brainFromEnv()),
    instruments,
  });
}
