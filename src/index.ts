import path from "node:path";
import { AnthropicBrain, type AnthropicBrainOptions, type Brain } from "./brain.js";
import { brainFromEnv } from "./brains/config.js";
import { Architect, type ArchitectOptions } from "./architect.js";
import { BrowserInstrument, type BrowserInstrumentOptions } from "./instruments/browser.js";
import { EcosystemInstrument } from "./instruments/ecosystem.js";
import { HttpInstrument } from "./instruments/http.js";
import { WorkspaceInstrument } from "./instruments/workspace.js";
import { RunSupervisor, supervisorFromEnv } from "./supervisor.js";

export * from "./types.js";
export { RunSupervisor, supervisorFromEnv, workspaceKey, type SupervisorOptions, type WorkspaceSeed, type RetainPolicy } from "./supervisor.js";
export { evaluateCommand, policyFrom, loadPolicyFile, DEFAULT_POLICY as DEFAULT_COMMAND_POLICY, type CommandPolicy, type CommandRule, type CommandDecision } from "./sandbox/execpolicy.js";
export { sandboxFor, PassthroughSandbox, RuntimeSandbox, type CommandSandbox, type SandboxLimits, type SandboxMode } from "./sandbox/runtime.js";
export { Architect } from "./architect.js";
export type { ArchitectOptions, ComposeOptions, PerformOptions } from "./architect.js";
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
export { createArchitectServer } from "./server.js";

export interface CreateArchitectOptions extends Partial<Omit<ArchitectOptions, "brain" | "instruments">> {
  brain?: Brain;
  brainOptions?: AnthropicBrainOptions;
  browser?: BrowserInstrumentOptions | false;
  /** Folder Architect may read, write and run commands in. Defaults to <dataDir>/workspace. */
  workspace?: string | false;
  /** Give each run its own folder under the workspace. Defaults to ARCHITECT_ISOLATION=per-run. */
  supervisor?: RunSupervisor | false;
  http?: boolean;
  ecosystem?: boolean;
}

/** An Architect with the standard instruments: browser, workspace, HTTP and the Infinitum ecosystem. */
export function createArchitect(opts: CreateArchitectOptions = {}): Architect {
  const dataDir = path.resolve(opts.dataDir ?? process.env.ARCHITECT_DATA_DIR ?? ".architect");
  const instruments = [];
  if (opts.browser !== false) instruments.push(new BrowserInstrument(opts.browser ?? {}));
  if (opts.workspace !== false) {
    const root = path.resolve(opts.workspace ?? process.env.ARCHITECT_WORKSPACE ?? path.join(dataDir, "workspace"));
    const supervisor = opts.supervisor === false ? undefined : (opts.supervisor ?? supervisorFromEnv(root));
    void supervisor?.reclaimStale().catch(() => {});
    instruments.push(new WorkspaceInstrument(root, { supervisor }));
  }
  if (opts.http !== false) instruments.push(new HttpInstrument());
  if (opts.ecosystem !== false) instruments.push(new EcosystemInstrument());
  return new Architect({
    ...opts,
    dataDir,
    brain: opts.brain ?? (opts.brainOptions ? new AnthropicBrain(opts.brainOptions) : brainFromEnv()),
    instruments,
  });
}
