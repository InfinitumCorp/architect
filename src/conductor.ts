import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Brain, ContentBlockParam, MessageParam, ToolDef, ToolResultBlockParam } from "./brain.js";
import { EcosystemInstrument } from "./instruments/ecosystem.js";
import { ToolInputError, validateInput, type Instrument, type ToolContext, type ToolSpec } from "./instruments/types.js";
import { gate, newId, now, truncate } from "./policy.js";
import { composePrompt, composeSystem, interpolate, performSystem, verifySystem } from "./prompts.js";
import { RunStore } from "./store.js";
import { addUsage, emptyUsage, estimateCost, type TurnUsage } from "./usage.js";
import {
  PERMISSIONS,
  type ActionRecord,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
  type Autonomy,
  type Evidence,
  type Permission,
  type Risk,
  type Run,
  type RunEvent,
  type Score,
  type ScoreStep,
  type Signal,
  type Verdict,
} from "./types.js";

export interface ConductorOptions {
  brain: Brain;
  instruments: Instrument[];
  /** Where runs, events and evidence are stored. */
  dataDir?: string;
  /** Upper bound on what any Score may be granted. Defaults to everything except standing.irreversible. */
  permissionCeiling?: Permission[];
  /** Decides approvals interactively (CLI). Without one, approvals wait for `decide()` (server / Podium). */
  approvalHandler?: ApprovalHandler;
  approvalTimeoutMs?: number;
  maxTurnsPerStep?: number;
}

export interface ComposeOptions {
  inputs?: Record<string, string>;
  startUrl?: string;
  /** Narrow the permissions for this Score further than the account ceiling. */
  permissions?: Permission[];
  trigger?: Signal;
}

export interface PerformOptions extends ComposeOptions {
  autonomy?: Autonomy;
  /** Spending limit for the run, in USD. */
  budgetUsd?: number;
  /** Saved Score or schedule name that started the run. */
  source?: string;
}

interface ControlTool {
  def: ToolDef;
  terminal: boolean;
}

const CONTROL_TOOLS: Record<string, ControlTool> = {
  step_complete: {
    terminal: true,
    def: {
      name: "step_complete",
      description: "The step's end state is reached. Summarize what was done, results, and any assumptions you made.",
      input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
    },
  },
  step_failed: {
    terminal: true,
    def: {
      name: "step_failed",
      description: "The step cannot be completed. Explain why and what was tried.",
      input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    },
  },
  request_handoff: {
    terminal: true,
    def: {
      name: "request_handoff",
      description:
        "Stop and package the run for a person: needed for sign-in, CAPTCHAs, payment or credential entry, or a decision only a person can make.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" }, instructions_for_person: { type: "string" } },
        required: ["reason", "instructions_for_person"],
      },
    },
  },
  record_evidence: {
    terminal: false,
    def: {
      name: "record_evidence",
      description: "Record a fact you observed (a price, a confirmation number, a test result) as evidence for verification.",
      input_schema: {
        type: "object",
        properties: { label: { type: "string" }, content: { type: "string" } },
        required: ["label", "content"],
      },
    },
  },
  submit_verdict: {
    terminal: true,
    def: {
      name: "submit_verdict",
      description: "Submit the verification verdict, one entry per success criterion.",
      input_schema: {
        type: "object",
        properties: {
          passed: { type: "boolean" },
          summary: { type: "string" },
          criteria: {
            type: "array",
            items: {
              type: "object",
              properties: { criterion: { type: "string" }, met: { type: "boolean" }, evidence: { type: "string" } },
              required: ["criterion", "met", "evidence"],
            },
          },
        },
        required: ["passed", "summary", "criteria"],
      },
    },
  },
};

class RunCancelled extends Error {}
class BudgetExceeded extends Error {}

/**
 * /CNDCTR/ — Compose a Score, Perform it with Instruments, Verify the outcome.
 * Emits "event" with every RunEvent; the same events are persisted for the Podium.
 */
export class Conductor extends EventEmitter {
  readonly store: RunStore;
  readonly brain: Brain;
  private instruments: Instrument[];
  private toolIndex = new Map<string, { instrument: Instrument; spec: ToolSpec }>();
  private ceiling: Permission[];
  private pending = new Map<string, { req: ApprovalRequest; resolve: (d: ApprovalDecision) => void }>();
  private cancelled = new Set<string>();
  private active = new Set<string>();

  constructor(private opts: ConductorOptions) {
    super();
    this.brain = opts.brain;
    this.instruments = opts.instruments;
    this.store = new RunStore(path.resolve(opts.dataDir ?? ".cndctr"));
    this.ceiling = opts.permissionCeiling ?? PERMISSIONS.filter((p) => p !== "standing.irreversible");
    for (const instrument of opts.instruments) {
      for (const spec of instrument.tools) this.toolIndex.set(spec.name, { instrument, spec });
    }
  }

  get pendingApprovals(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.req);
  }

  isActive(runId: string) {
    return this.active.has(runId);
  }

  // ───────────────────────────── Compose ─────────────────────────────

  async compose(goal: string, opts: ComposeOptions = {}): Promise<Score> {
    return (await this.composeWithUsage(goal, opts)).score;
  }

  /** Rough cost range for performing a Score with the current model. */
  estimate(score: Score) {
    return estimateCost(score, this.brain.model);
  }

  private async composeWithUsage(goal: string, opts: ComposeOptions): Promise<{ score: Score; usage?: TurnUsage; model?: string }> {
    const ceiling = opts.permissions ? this.ceiling.filter((p) => opts.permissions!.includes(p)) : this.ceiling;
    const { draft, usage, model } = await this.brain.compose(
      composeSystem(this.instruments, ceiling),
      composePrompt(goal, opts.inputs ?? {}, opts.startUrl),
    );
    const known = new Set(this.instruments.map((i) => i.name));
    const score: Score = {
      id: newId("score"),
      goal,
      summary: draft.summary,
      inputs: opts.inputs ?? {},
      // The model proposes; the account's ceiling disposes.
      permissions: draft.permissions.filter((p) => ceiling.includes(p)),
      startUrl: opts.startUrl ?? draft.startUrl ?? undefined,
      steps: draft.steps.map((s, i) => ({
        id: `s${i + 1}`,
        title: s.title,
        instruction: s.instruction,
        instruments: s.instruments.filter((n) => known.has(n)),
        checkpoint: s.checkpoint,
      })),
      successCriteria: draft.successCriteria,
      createdAt: now(),
    };
    return { score, usage, model };
  }

  createRun(
    score: Score,
    autonomy: Autonomy,
    extra: Partial<Pick<Run, "trigger" | "parentRunId" | "budgetUsd" | "source">> = {},
  ): Run {
    const t = now();
    return {
      id: newId("run"),
      score,
      autonomy,
      status: "composed",
      steps: score.steps.map((s) => ({ id: s.id, status: "pending", attempts: 0 })),
      actions: [],
      evidence: [],
      usage: emptyUsage(),
      createdAt: t,
      updatedAt: t,
      ...extra,
    };
  }

  /** Compose and perform in one go: intent in, outcome out. */
  async run(goal: string, opts: PerformOptions = {}): Promise<Run> {
    const run = await this.start(goal, opts);
    return this.perform(run);
  }

  /** Compose a Score and persist a run without performing it yet. */
  async start(goal: string, opts: PerformOptions = {}): Promise<Run> {
    const { score, usage, model } = await this.composeWithUsage(goal, opts);
    const run = this.createRun(score, opts.autonomy ?? "accompaniment", {
      trigger: opts.trigger,
      budgetUsd: opts.budgetUsd,
      source: opts.source,
    });
    if (usage) addUsage(run.usage, usage, model ?? this.brain.model);
    await this.store.save(run);
    await this.emitEvent(run.id, "run.composed", { score, estimate: this.estimate(score), budgetUsd: run.budgetUsd });
    return run;
  }

  // ───────────────────────────── Perform ─────────────────────────────

  async perform(run: Run): Promise<Run> {
    if (this.active.has(run.id)) throw new Error(`run ${run.id} is already performing`);
    this.active.add(run.id);
    this.cancelled.delete(run.id);
    try {
      await this.setStatus(run, "performing");
      for (const step of run.score.steps) {
        const state = run.steps.find((s) => s.id === step.id)!;
        if (state.status === "done" || state.status === "skipped") continue;

        if (step.checkpoint && run.autonomy === "accompaniment") {
          const decision = await this.requestApproval(run, {
            stepId: step.id,
            kind: "checkpoint",
            reason: `Checkpoint before "${step.title}": ${interpolate(step.instruction, run.score.inputs)}`,
          });
          if (!decision.approved) {
            state.status = "skipped";
            state.summary = `Checkpoint declined${decision.note ? `: ${decision.note}` : ""}`;
            await this.fail(run, `checkpoint before "${step.title}" was declined`);
            return run;
          }
        }

        state.status = "running";
        state.attempts += 1;
        await this.persist(run);
        await this.emitEvent(run.id, "step.started", { stepId: step.id, title: step.title });

        const outcome = await this.performStep(run, step);
        if (outcome.kind === "complete") {
          state.status = "done";
          state.summary = outcome.text;
          await this.emitEvent(run.id, "step.completed", { stepId: step.id, summary: outcome.text });
        } else if (outcome.kind === "handoff") {
          state.status = "failed";
          state.summary = `Handed off: ${outcome.text}`;
          await this.handoff(run, outcome.text, outcome.instructions);
          return run;
        } else {
          state.status = "failed";
          state.summary = outcome.text;
          await this.emitEvent(run.id, "step.failed", { stepId: step.id, reason: outcome.text });
          await this.fail(run, `step "${step.title}" failed: ${outcome.text}`);
          return run;
        }
        await this.persist(run);
      }

      if (run.autonomy === "rehearsal") {
        await this.setStatus(run, "rehearsed");
        return run;
      }
      await this.verify(run);
      return run;
    } catch (err) {
      if (err instanceof BudgetExceeded) {
        await this.handoff(
          run,
          err.message,
          `Raise the limit and resume: cndctr recover ${run.id} --budget <usd>  (or POST /v1/runs/${run.id}/recover { "budgetUsd": … })`,
        );
      } else if (err instanceof RunCancelled) {
        await this.fail(run, "cancelled");
      } else {
        await this.fail(run, err instanceof Error ? err.message : String(err));
      }
      return run;
    } finally {
      this.active.delete(run.id);
    }
  }

  private async performStep(
    run: Run,
    step: ScoreStep,
  ): Promise<{ kind: "complete" | "failed" | "handoff"; text: string; instructions?: string }> {
    const instruments = this.instruments.filter((i) => step.instruments.includes(i.name));
    const priorAttempt = run.actions.filter((a) => a.stepId === step.id);
    const intro: string[] = [
      `Perform step ${step.id}: ${step.title}`,
      interpolate(step.instruction, run.score.inputs),
    ];
    if (run.score.startUrl && step.id === run.score.steps[0]?.id) intro.push(`Start URL: ${run.score.startUrl}`);
    if (priorAttempt.length) {
      intro.push(
        `This step was attempted before (Recover). Do not repeat work that already succeeded. Earlier actions:\n${priorAttempt
          .slice(-30)
          .map((a) => `- ${a.tool} ${JSON.stringify(a.input).slice(0, 160)} → ${a.outcome}: ${a.output.slice(0, 160)}`)
          .join("\n")}`,
      );
    }
    const result = await this.loop(run, step.id, performSystem(run, step, instruments), intro.join("\n\n"), instruments, [
      "step_complete",
      "step_failed",
      "request_handoff",
      "record_evidence",
    ]);
    if (result.name === "step_complete") return { kind: "complete", text: String(result.input.summary) };
    if (result.name === "request_handoff") {
      return { kind: "handoff", text: String(result.input.reason), instructions: String(result.input.instructions_for_person) };
    }
    return { kind: "failed", text: String(result.input.reason ?? "step failed") };
  }

  /**
   * The Observe–Think–Act loop shared by performing and verifying.
   * Returns when the model calls a terminal control tool.
   */
  private async loop(
    run: Run,
    stepId: string,
    system: string,
    firstMessage: string | ContentBlockParam[],
    instruments: Instrument[],
    controls: string[],
    readOnly = false,
  ): Promise<{ name: string; input: Record<string, unknown> }> {
    const specs = instruments
      .flatMap((i) => i.tools)
      .filter((t) => (readOnly ? t.risk === "read" : true))
      .filter((t) => run.score.permissions.includes(t.permission));
    const tools: ToolDef[] = [
      ...specs.map((s) => ({ name: s.name, description: s.description, input_schema: s.input_schema }) as ToolDef),
      ...controls.map((c) => CONTROL_TOOLS[c]!.def),
    ];
    const allowed = new Set(tools.map((t) => t.name));
    const messages: MessageParam[] = [{ role: "user", content: firstMessage }];
    const maxTurns = this.opts.maxTurnsPerStep ?? 60;
    let nudges = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      if (this.cancelled.has(run.id)) throw new RunCancelled();
      run.usage ??= emptyUsage();
      if (run.budgetUsd !== undefined && run.usage.costUsd >= run.budgetUsd) {
        throw new BudgetExceeded(
          `Spending limit reached: $${run.usage.costUsd.toFixed(2)} spent of a $${run.budgetUsd.toFixed(2)} limit`,
        );
      }
      const res = await this.brain.turn({ system, messages, tools });
      if (res.usage) {
        addUsage(run.usage, res.usage, res.model ?? this.brain.model);
        void this.emitEvent(run.id, "usage", { ...run.usage, model: res.model ?? this.brain.model });
      }
      if (res.stop_reason === "refusal") throw new Error("the model declined to continue this step");
      messages.push({ role: "assistant", content: res.content as ContentBlockParam[] });

      for (const block of res.content) {
        if (block.type === "text" && block.text.trim()) {
          await this.emitEvent(run.id, "conductor.note", { stepId, text: block.text });
        }
      }
      const uses = res.content.filter((b) => b.type === "tool_use");
      if (!uses.length) {
        if (res.stop_reason === "max_tokens") {
          messages.push({ role: "user", content: "Your last response was cut off. Continue, using tools." });
          continue;
        }
        if (++nudges > 3) return { name: "step_failed", input: { reason: "the performer stopped without finishing" } };
        messages.push({
          role: "user",
          content: `Keep going with tools. When finished, call ${controls.filter((c) => CONTROL_TOOLS[c]!.terminal).join(" or ")}.`,
        });
        continue;
      }

      let terminal: { name: string; input: Record<string, unknown> } | undefined;
      const results: ToolResultBlockParam[] = [];
      for (const use of uses) {
        const input = (use.input ?? {}) as Record<string, unknown>;
        if (CONTROL_TOOLS[use.name] && allowed.has(use.name)) {
          if (CONTROL_TOOLS[use.name]!.terminal) {
            terminal ??= { name: use.name, input };
            results.push({ type: "tool_result", tool_use_id: use.id, content: "Recorded." });
          } else {
            this.addEvidence(run, stepId, { kind: "text", label: String(input.label), content: String(input.content) });
            results.push({ type: "tool_result", tool_use_id: use.id, content: "Evidence recorded." });
          }
          continue;
        }
        results.push(await this.act(run, stepId, use.id, use.name, input, allowed));
      }
      await this.persist(run);
      if (terminal) return terminal;
      messages.push({ role: "user", content: results });
    }
    return { name: "step_failed", input: { reason: `no result after ${maxTurns} turns` } };
  }

  /** Validate, classify, gate, (maybe) approve, execute and record one instrument action. */
  private async act(
    run: Run,
    stepId: string,
    toolUseId: string,
    name: string,
    rawInput: Record<string, unknown>,
    allowed: Set<string>,
  ): Promise<ToolResultBlockParam> {
    const entry = this.toolIndex.get(name);
    const record = (risk: Risk, outcome: ActionRecord["outcome"], output: string, approval?: ActionRecord["approval"]) => {
      const action: ActionRecord = {
        id: newId("act"),
        stepId,
        instrument: entry?.instrument.name ?? "unknown",
        tool: name,
        input: rawInput,
        risk,
        outcome,
        output: truncate(output, 2_000),
        approval,
        at: now(),
      };
      run.actions.push(action);
      void this.emitEvent(run.id, "action", { ...action });
    };
    const errorResult = (text: string): ToolResultBlockParam => ({
      type: "tool_result",
      tool_use_id: toolUseId,
      content: text,
      is_error: true,
    });

    if (!entry || !allowed.has(name)) {
      record("read", "blocked", "tool not available in this step");
      return errorResult(`Tool "${name}" is not available in this step.`);
    }
    let input: Record<string, unknown>;
    try {
      input = validateInput(entry.spec.input_schema, rawInput);
    } catch (err) {
      if (err instanceof ToolInputError) {
        record("read", "error", err.message);
        return errorResult(`Invalid input: ${err.message}`);
      }
      throw err;
    }
    const risk = typeof entry.spec.risk === "function" ? await entry.spec.risk(input) : entry.spec.risk;
    const decision = gate({ autonomy: run.autonomy, risk, required: entry.spec.permission, granted: run.score.permissions });

    let approval: ActionRecord["approval"];
    if (decision.kind === "block") {
      record(risk, "blocked", decision.reason);
      return errorResult(`Blocked: ${decision.reason}.`);
    }
    if (decision.kind === "simulate") {
      record(risk, "simulated", decision.reason);
      return {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: `[Rehearsal] Not executed — recorded as a draft. Continue as if it succeeded, and describe the expected effect in your summary.`,
      };
    }
    if (decision.kind === "approve") {
      const d = await this.requestApproval(run, { stepId, kind: "action", tool: name, input, risk, reason: decision.reason });
      approval = { approved: d.approved, by: d.by, note: d.note };
      if (!d.approved) {
        record(risk, "denied", d.note ?? "declined", approval);
        return errorResult(`A person declined this action${d.note ? `: ${d.note}` : ""}. Do not retry it; find another way or report the step as failed.`);
      }
    }

    try {
      const out = await entry.instrument.execute(name, input, this.toolContext(run, stepId));
      record(risk, out.isError ? "error" : "executed", out.text, approval);
      const wrapped = `<tool_output instrument="${entry.instrument.name}" trust="untrusted">\n${out.text}\n</tool_output>`;
      const content: ToolResultBlockParam["content"] = out.image
        ? [
            { type: "text", text: wrapped },
            { type: "image", source: { type: "base64", media_type: out.image.mediaType, data: out.image.base64 } },
          ]
        : wrapped;
      return { type: "tool_result", tool_use_id: toolUseId, content, is_error: out.isError || undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record(risk, "error", message, approval);
      return errorResult(`Error: ${truncate(message, 2_000)}`);
    }
  }

  private toolContext(run: Run, stepId: string): ToolContext {
    return {
      runId: run.id,
      stepId,
      runDir: this.store.runDir(run.id),
      addEvidence: (e) => this.addEvidence(run, stepId, e),
    };
  }

  private addEvidence(run: Run, stepId: string, e: Omit<Evidence, "id" | "stepId" | "at">): Evidence {
    const ev: Evidence = { id: newId("ev"), stepId, at: now(), ...e };
    run.evidence.push(ev);
    void this.emitEvent(run.id, "evidence", { ...ev });
    return ev;
  }

  // ───────────────────────────── Verify ─────────────────────────────

  async verify(run: Run): Promise<Verdict> {
    await this.setStatus(run, "verifying");
    const instruments = this.instruments.filter((i) => run.score.steps.some((s) => s.instruments.includes(i.name)));
    const content: ContentBlockParam[] = [
      {
        type: "text",
        text: [
          "Success criteria:",
          ...run.score.successCriteria.map((c, i) => `${i + 1}. ${c}`),
          "",
          "What the performer reported:",
          ...run.steps.map((s) => `- ${s.id} [${s.status}] ${s.summary ?? ""}`),
          "",
          "Recorded evidence:",
          ...run.evidence
            .filter((e) => e.kind !== "screenshot")
            .slice(-40)
            .map((e) => `- (${e.kind}) ${e.label}: ${truncate(e.content ?? "", 400)}`),
        ].join("\n"),
      },
    ];
    const lastShot = [...run.evidence].reverse().find((e) => e.kind === "screenshot" && e.path);
    if (lastShot?.path) {
      try {
        const data = (await readFile(path.join(this.store.runDir(run.id), lastShot.path))).toString("base64");
        content.push({ type: "text", text: `Last screenshot (${lastShot.label}, ${lastShot.content ?? ""}):` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/png", data } });
      } catch {
        /* evidence file missing; verify from live state */
      }
    }
    const result = await this.loop(run, "verify", verifySystem(run), content, instruments, ["submit_verdict"], true);
    const input = result.input as { passed?: boolean; summary?: string; reason?: string; criteria?: Verdict["criteria"] };
    const verdict: Verdict = {
      passed: result.name === "submit_verdict" && !!input.passed && (input.criteria ?? []).every((c) => c.met),
      summary: String(input.summary ?? input.reason ?? "verification did not complete"),
      criteria: input.criteria ?? [],
      at: now(),
    };
    run.verdict = verdict;
    await this.emitEvent(run.id, "run.verified", { ...verdict });
    if (verdict.passed) await this.attest(run);
    await this.setStatus(run, verdict.passed ? "succeeded" : "failed");
    if (!verdict.passed) run.error = `verification failed: ${verdict.summary}`;
    await this.persist(run);
    return verdict;
  }

  /** Record a verified outcome on Firmament Network when it is connected. */
  private async attest(run: Run) {
    const eco = this.instruments.find((i): i is EcosystemInstrument => i instanceof EcosystemInstrument);
    if (!eco?.connected.includes("firmament")) return;
    const digest = createHash("sha256")
      .update(JSON.stringify({ score: run.score, verdict: run.verdict, evidence: run.evidence }))
      .digest("hex");
    try {
      const res = await eco.call("firmament", "attest", { runId: run.id, goal: run.score.goal, digest, verdict: run.verdict }, run.id);
      await this.emitEvent(run.id, "run.attested", { digest, status: res.status });
    } catch (err) {
      await this.emitEvent(run.id, "run.attest_failed", { error: String(err) });
    }
  }

  // ─────────────────────── Encore · Recover · Handoff ───────────────────────

  /** Rerun a Score with new inputs. */
  async encore(runId: string, inputs: Record<string, string>, autonomy?: Autonomy, budgetUsd?: number): Promise<Run> {
    const prev = await this.store.load(runId);
    const run = await this.prepare(prev.score, {
      inputs,
      autonomy: autonomy ?? prev.autonomy,
      budgetUsd: budgetUsd ?? prev.budgetUsd,
      parentRunId: prev.id,
    });
    await this.emitEvent(run.id, "run.encore", { from: prev.id, inputs });
    return this.perform(run);
  }

  /**
   * Turn an existing Score (saved, scheduled, or from the Score Marketplace) into a new run.
   * A Score from disk or another account is untrusted: its permissions are re-clamped to this
   * account's ceiling and its instruments to the ones installed here.
   */
  async prepare(
    base: Score,
    opts: { inputs?: Record<string, string>; autonomy?: Autonomy; budgetUsd?: number; parentRunId?: string; source?: string } = {},
  ): Promise<Run> {
    const known = new Set(this.instruments.map((i) => i.name));
    const score: Score = {
      ...base,
      id: newId("score"),
      inputs: { ...base.inputs, ...(opts.inputs ?? {}) },
      permissions: base.permissions.filter((p) => this.ceiling.includes(p)),
      steps: base.steps.map((s) => ({ ...s, instruments: s.instruments.filter((n) => known.has(n)) })),
      createdAt: now(),
    };
    const run = this.createRun(score, opts.autonomy ?? "accompaniment", {
      parentRunId: opts.parentRunId,
      budgetUsd: opts.budgetUsd,
      source: opts.source,
    });
    await this.store.save(run);
    await this.emitEvent(run.id, "run.composed", { score, estimate: this.estimate(score), budgetUsd: run.budgetUsd });
    return run;
  }

  /** Resume after a failed step without repeating completed work. */
  async recover(runId: string, opts: { budgetUsd?: number } = {}): Promise<Run> {
    const run = await this.store.load(runId);
    if (["succeeded", "rehearsed"].includes(run.status)) throw new Error(`run ${runId} already finished (${run.status})`);
    run.usage ??= emptyUsage();
    if (opts.budgetUsd !== undefined) run.budgetUsd = opts.budgetUsd;
    for (const s of run.steps) if (s.status !== "done") s.status = "pending";
    run.error = undefined;
    run.verdict = undefined;
    await this.emitEvent(run.id, "run.recovering", {});
    return this.perform(run);
  }

  /** Package the run's state so a person can take over. */
  async handoff(run: Run, reason: string, instructions?: string): Promise<string> {
    const dir = path.join(this.store.runDir(run.id), "handoff");
    await mkdir(dir, { recursive: true });
    const ctx = this.toolContext(run, "handoff");
    const artifacts: Record<string, string> = {};
    for (const i of this.instruments) Object.assign(artifacts, await i.handoff?.(ctx).catch(() => ({})));
    const next = run.score.steps.find((s) => run.steps.find((x) => x.id === s.id)?.status !== "done");
    const md = [
      `# Handoff — ${run.score.goal}`,
      "",
      `Run: ${run.id}  ·  Autonomy: ${run.autonomy}  ·  ${now()}`,
      "",
      `## Why Conductor stopped`,
      reason,
      instructions ? `\n## What you need to do\n${instructions}` : "",
      "",
      "## Progress",
      ...run.score.steps.map((s) => {
        const st = run.steps.find((x) => x.id === s.id)!;
        return `- [${st.status === "done" ? "x" : " "}] ${s.title}${st.summary ? ` — ${st.summary}` : ""}`;
      }),
      next ? `\n## Next step\n${next.title}: ${interpolate(next.instruction, run.score.inputs)}` : "",
      "",
      "## Artifacts",
      ...Object.entries(artifacts).map(([k, v]) => `- ${k}: ${v}`),
      "",
      `When you are done, resume with: \`cndctr recover ${run.id}\``,
    ].join("\n");
    await writeFile(path.join(dir, "HANDOFF.md"), md);
    await this.emitEvent(run.id, "run.handed_off", { reason, instructions, artifacts });
    await this.setStatus(run, "handed_off");
    return path.join(dir, "HANDOFF.md");
  }

  cancel(runId: string) {
    this.cancelled.add(runId);
    for (const [id, p] of this.pending) {
      if (p.req.runId === runId) {
        this.pending.delete(id);
        p.resolve({ approved: false, note: "run cancelled" });
      }
    }
  }

  // ───────────────────────────── Approvals ─────────────────────────────

  private async requestApproval(
    run: Run,
    partial: Omit<ApprovalRequest, "id" | "runId" | "createdAt">,
  ): Promise<ApprovalDecision> {
    const req: ApprovalRequest = { id: newId("apr"), runId: run.id, createdAt: now(), ...partial };
    const previous = run.status;
    await this.setStatus(run, "awaiting_approval");
    await this.emitEvent(run.id, "approval.requested", { ...req });

    let decision: ApprovalDecision;
    if (this.opts.approvalHandler) {
      decision = await this.opts.approvalHandler(req);
    } else {
      decision = await new Promise<ApprovalDecision>((resolve) => {
        const timeout = setTimeout(() => {
          this.pending.delete(req.id);
          resolve({ approved: false, note: "approval timed out" });
        }, this.opts.approvalTimeoutMs ?? 24 * 60 * 60 * 1000);
        this.pending.set(req.id, {
          req,
          resolve: (d) => {
            clearTimeout(timeout);
            resolve(d);
          },
        });
      });
    }
    await this.emitEvent(run.id, "approval.decided", { approvalId: req.id, ...decision });
    if (this.cancelled.has(run.id)) throw new RunCancelled();
    await this.setStatus(run, previous === "awaiting_approval" ? "performing" : previous);
    return decision;
  }

  /** Resolve a pending approval (from the Podium, the API or another product). */
  decide(approvalId: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    this.pending.delete(approvalId);
    p.resolve(decision);
    return true;
  }

  // ───────────────────────────── State ─────────────────────────────

  private async setStatus(run: Run, status: Run["status"]) {
    run.status = status;
    await this.persist(run);
    await this.emitEvent(run.id, "run.status", { status });
  }

  private async fail(run: Run, error: string) {
    run.error = error;
    await this.setStatus(run, "failed");
  }

  private async persist(run: Run) {
    run.updatedAt = now();
    await this.store.save(run);
  }

  private async emitEvent(runId: string, type: string, data: Record<string, unknown>) {
    const ev: RunEvent = { runId, type, data, at: now() };
    this.emit("event", ev);
    await this.store.appendEvent(ev).catch(() => {});
  }

  async dispose() {
    await Promise.all(this.instruments.map((i) => i.dispose?.()));
  }
}
