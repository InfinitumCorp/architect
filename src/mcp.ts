/**
 * :\ARCHITECT\ as an MCP server, so Claude Code, Cursor and other agents can hand Architect a goal.
 *
 *   architect mcp                      # stdio; talks to `architect serve` at ARCHITECT_URL (default http://localhost:7337)
 *
 * It is a thin client over the Architect HTTP API. Approvals are deliberately NOT exposed:
 * a calling agent can start, watch, recover and cancel runs, but risky actions still wait
 * for a person in the Podium or the CLI. An agent must never approve its own actions.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ArchitectClient } from "./sdk.js";
import { PERMISSIONS, type Run } from "./types.js";

const TERMINAL = new Set(["succeeded", "failed", "rehearsed", "handed_off"]);

/** A compact, model-friendly view of a run. */
export function summarizeRun(run: Run) {
  return {
    id: run.id,
    status: run.status,
    goal: run.score.goal,
    autonomy: run.autonomy,
    summary: run.score.summary,
    steps: run.score.steps.map((s) => {
      const st = run.steps.find((x) => x.id === s.id);
      return { title: s.title, status: st?.status ?? "pending", summary: st?.summary };
    }),
    verdict: run.verdict && { passed: run.verdict.passed, summary: run.verdict.summary, criteria: run.verdict.criteria },
    error: run.error,
    actions: run.actions.length,
    spendUsd: Number(run.usage.costUsd.toFixed(4)),
    budgetUsd: run.budgetUsd,
    updatedAt: run.updatedAt,
  };
}

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
}

async function waitFor(client: ArchitectClient, runId: string, timeoutSec: number, intervalMs: number) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const run = await client.getRun(runId);
    if (TERMINAL.has(run.status) || Date.now() >= deadline) return run;
    // Stop for a person only while this run really has an open approval (the status lags a decision briefly).
    if (run.status === "awaiting_approval" && (await client.approvals()).some((a) => a.runId === runId)) return run;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface McpOptions {
  client?: ArchitectClient;
  /** Poll interval while waiting on a run. */
  pollMs?: number;
}

export function createMcpServer(opts: McpOptions = {}): McpServer {
  const client =
    opts.client ?? new ArchitectClient({ baseUrl: process.env.ARCHITECT_URL, token: process.env.ARCHITECT_API_TOKEN });
  const pollMs = opts.pollMs ?? 2_000;
  const server = new McpServer({ name: "architect", version: "0.1.0" });
  const approvalNote = (run: Run) =>
    run.status === "awaiting_approval"
      ? { note: "This run is waiting for a person to approve an action in the Podium or CLI. You cannot approve it." }
      : {};

  server.registerTool(
    "architect_run",
    {
      title: "Start an Architect run",
      description:
        "Give Architect a goal in plain language. It plans a Score, drives a browser and other instruments, and verifies the result. " +
        "autonomy: rehearsal (plan and simulate, no side effects), accompaniment (default; risky actions wait for a person), autopilot. " +
        "With wait=true, returns when the run finishes, needs approval, or wait_seconds pass.",
      inputSchema: {
        goal: z.string().min(1),
        autonomy: z.enum(["rehearsal", "accompaniment", "autopilot"]).optional(),
        start_url: z.string().url().optional(),
        inputs: z.record(z.string(), z.string()).optional(),
        permissions: z.array(z.enum(PERMISSIONS)).optional(),
        budget_usd: z.number().positive().optional(),
        wait: z.boolean().optional(),
        wait_seconds: z.number().int().positive().max(1800).optional(),
      },
    },
    async (a) => {
      try {
        let run = await client.run({
          goal: a.goal,
          autonomy: a.autonomy,
          startUrl: a.start_url,
          inputs: a.inputs,
          permissions: a.permissions,
          budgetUsd: a.budget_usd,
        });
        if (a.wait) run = await waitFor(client, run.id, a.wait_seconds ?? 600, pollMs);
        return json({ ...summarizeRun(run), ...approvalNote(run) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "architect_get_run",
    {
      title: "Get a run",
      description: "Status, Score steps, verdict and spend for one run. With wait=true, waits until it finishes or needs approval.",
      inputSchema: { run_id: z.string().min(1), wait: z.boolean().optional(), wait_seconds: z.number().int().positive().max(1800).optional() },
    },
    async (a) => {
      try {
        const run = a.wait ? await waitFor(client, a.run_id, a.wait_seconds ?? 600, pollMs) : await client.getRun(a.run_id);
        return json({ ...summarizeRun(run), ...approvalNote(run) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "architect_list_runs",
    {
      title: "List runs",
      description: "Recent runs, newest first.",
      inputSchema: { limit: z.number().int().positive().max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async (a) => {
      try {
        const runs = await client.listRuns(a.limit ?? 20);
        return json(runs.map((r) => ({ id: r.id, status: r.status, goal: r.score.goal, spendUsd: Number(r.usage.costUsd.toFixed(4)), updatedAt: r.updatedAt })));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "architect_pending_approvals",
    {
      title: "Pending approvals",
      description: "Actions waiting for a person. Read-only: approve or decline them in the Podium or CLI, not through this server.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return json(await client.approvals());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "architect_recover",
    {
      title: "Recover a run",
      description: "Resume a failed or handed-off run from where it stopped, optionally with a new spending limit.",
      inputSchema: { run_id: z.string().min(1), budget_usd: z.number().positive().optional() },
    },
    async (a) => {
      try {
        await client.recover(a.run_id, a.budget_usd);
        return json({ ok: true, run_id: a.run_id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "architect_cancel",
    {
      title: "Cancel a run",
      description: "Stop a run that is in progress.",
      inputSchema: { run_id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    async (a) => {
      try {
        await client.cancel(a.run_id);
        return json({ ok: true, run_id: a.run_id });
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
