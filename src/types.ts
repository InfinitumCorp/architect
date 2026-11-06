/**
 * Core vocabulary of :\ARCHITECT\ (Architect).
 *
 *   Score        – an executable plan: steps, permissions, checkpoints, definition of success
 *   Instrument   – a capability Architect can play (browser, workspace, HTTP, Infinitum products)
 *   Performance  – a run of a Score; every action is recorded with evidence
 *   Verify       – "done" means the success criteria were confirmed, not that the last button was clicked
 */

import type { RunUsage } from "./usage.js";
export type { RunUsage } from "./usage.js";

export type Autonomy ="rehearsal" | "accompaniment" | "autopilot";

/** How consequential a single action is. Drives approval gating. */
export type Risk = "read" | "write" | "irreversible";

/**
 * Permissions belong to the Score and the account that granted it.
 * Nothing observed during a run (web pages, files, tool output) can add to them.
 */
export const PERMISSIONS = [
  "browser", // navigate, read, click and type in the browser
  "http.read", // GET requests to external APIs
  "http.write", // POST/PUT/PATCH/DELETE requests
  "workspace.read", // read files in the run workspace
  "workspace.write", // write files in the run workspace
  "shell", // run commands in the run workspace
  "ecosystem", // call other Infinitum products
  "standing.irreversible", // Autopilot only: irreversible actions run without a per-action approval
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface ScoreStep {
  id: string;
  title: string;
  /** What to do in this step, written for the performer. */
  instruction: string;
  /** Instrument names the step may use. */
  instruments: string[];
  /** A checkpoint pauses for human approval before the step starts (Accompaniment). */
  checkpoint: boolean;
}

export interface Score {
  id: string;
  goal: string;
  summary: string;
  inputs: Record<string, string>;
  permissions: Permission[];
  steps: ScoreStep[];
  /** The definition of done. Verification checks every criterion. */
  successCriteria: string[];
  startUrl?: string;
  createdAt: string;
}

export type EvidenceKind = "screenshot" | "text" | "url" | "file" | "command";

export interface Evidence {
  id: string;
  stepId: string;
  kind: EvidenceKind;
  label: string;
  /** Path relative to the run directory, for binary evidence. */
  path?: string;
  content?: string;
  at: string;
}

export type ActionOutcome = "executed" | "simulated" | "denied" | "error" | "blocked";

export interface ActionRecord {
  id: string;
  stepId: string;
  instrument: string;
  tool: string;
  input: unknown;
  risk: Risk;
  outcome: ActionOutcome;
  output: string;
  approval?: { approved: boolean; by?: string; note?: string };
  at: string;
}

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface StepState {
  id: string;
  status: StepStatus;
  summary?: string;
  attempts: number;
}

export type RunStatus =
  | "composing"
  | "composed"
  | "performing"
  | "awaiting_approval"
  | "verifying"
  | "succeeded"
  | "failed"
  | "rehearsed"
  | "handed_off";

export interface CriterionResult {
  criterion: string;
  met: boolean;
  evidence: string;
}

export interface Verdict {
  passed: boolean;
  criteria: CriterionResult[];
  summary: string;
  at: string;
}

export interface Signal {
  product: string;
  type: string;
  payload: Record<string, unknown>;
  receivedAt: string;
}

export interface Run {
  id: string;
  score: Score;
  autonomy: Autonomy;
  status: RunStatus;
  steps: StepState[];
  actions: ActionRecord[];
  evidence: Evidence[];
  verdict?: Verdict;
  error?: string;
  trigger?: Signal;
  /** Set when this run is an Encore of another run. */
  parentRunId?: string;
  /** Model tokens and cost so far. */
  usage: RunUsage;
  /** Spending limit in USD. When reached, the run hands off instead of continuing. */
  budgetUsd?: number;
  /** Name of the saved Score or schedule that started this run, if any. */
  source?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  stepId: string;
  kind: "action" | "checkpoint";
  tool?: string;
  input?: unknown;
  risk?: Risk;
  reason: string;
  createdAt: string;
}

export interface ApprovalDecision {
  approved: boolean;
  by?: string;
  note?: string;
}

export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

export interface RunEvent {
  runId: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}
