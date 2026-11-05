/**
 * @infinitum/cndctr SDK — how every Infinitum product folds Conductor in.
 *
 *   const cndctr = new CndctrClient({ baseUrl: process.env.CNDCTR_URL, token: process.env.CNDCTR_TOKEN });
 *
 *   // Spectre: turn a renewal risk into finished work
 *   await cndctr.signal("spectre", "renewal_risk", { account: "Acme", owner: "dana@acme.example", reason: "usage down 40%" });
 *
 *   // Any product: describe an outcome directly
 *   const run = await cndctr.run({ goal: "Compare these suppliers and bring me the final price", autonomy: "accompaniment" });
 *   for await (const ev of cndctr.events(run.id)) console.log(ev.type);
 *
 * Dependency-free (uses global fetch), so it runs in Node 18+, browsers, VEIL</> and edge runtimes.
 */
import type { ApprovalRequest, Autonomy, Permission, Run, RunEvent } from "./types.js";

export type { ApprovalRequest, Autonomy, Permission, Run, RunEvent } from "./types.js";

export interface CndctrClientOptions {
  baseUrl?: string;
  token?: string;
  fetch?: typeof fetch;
}

export interface StartRunRequest {
  goal: string;
  autonomy?: Autonomy;
  inputs?: Record<string, string>;
  startUrl?: string;
  permissions?: Permission[];
  /** Compose the Score only; perform later with `perform(runId)`. */
  composeOnly?: boolean;
}

export class CndctrError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const TERMINAL = new Set(["succeeded", "failed", "rehearsed", "handed_off"]);

export class CndctrClient {
  private baseUrl: string;
  private token?: string;
  private f: typeof fetch;

  constructor(opts: CndctrClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:7337").replace(/\/$/, "");
    this.token = opts.token;
    this.f = opts.fetch ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.f(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new CndctrError(res.status, (data as { error?: string })?.error ?? res.statusText);
    return data as T;
  }

  run(request: StartRunRequest): Promise<Run> {
    return this.req("POST", "/v1/runs", request);
  }
  getRun(runId: string): Promise<Run> {
    return this.req("GET", `/v1/runs/${runId}`);
  }
  listRuns(limit = 50): Promise<Run[]> {
    return this.req("GET", `/v1/runs?limit=${limit}`);
  }
  perform(runId: string) {
    return this.req<{ ok: true }>("POST", `/v1/runs/${runId}/perform`, {});
  }
  recover(runId: string) {
    return this.req<{ ok: true }>("POST", `/v1/runs/${runId}/recover`, {});
  }
  encore(runId: string, inputs: Record<string, string>, autonomy?: Autonomy) {
    return this.req<{ ok: true }>("POST", `/v1/runs/${runId}/encore`, { inputs, autonomy });
  }
  cancel(runId: string) {
    return this.req<{ ok: true }>("POST", `/v1/runs/${runId}/cancel`, {});
  }
  approvals(): Promise<ApprovalRequest[]> {
    return this.req("GET", "/v1/approvals");
  }
  decide(approvalId: string, approved: boolean, note?: string, by?: string) {
    return this.req<{ ok: true }>("POST", `/v1/approvals/${approvalId}`, { approved, note, by });
  }
  /** Send a product signal; a matching trigger rule starts a Score. */
  signal(product: string, type: string, payload: Record<string, unknown>) {
    return this.req<{ accepted: boolean; started: boolean; runId?: string; reason?: string }>(
      "POST",
      `/v1/signals/${encodeURIComponent(product)}`,
      { type, payload },
    );
  }

  /** Poll until the run reaches a terminal state. */
  async waitForRun(runId: string, { intervalMs = 2_000, timeoutMs = 60 * 60 * 1000 } = {}): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.getRun(runId);
      if (TERMINAL.has(run.status)) return run;
      if (Date.now() > deadline) throw new CndctrError(408, `run ${runId} still ${run.status}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /** Stream a run's events (replay, then live) until the run finishes. */
  async *events(runId: string): AsyncGenerator<RunEvent> {
    const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
    const res = await this.f(`${this.baseUrl}/v1/runs/${runId}/events${qs}`);
    if (!res.ok || !res.body) throw new CndctrError(res.status, "could not open event stream");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const ev = JSON.parse(data.slice(6)) as RunEvent;
        yield ev;
        if (ev.type === "run.status" && TERMINAL.has(String(ev.data.status))) {
          await reader.cancel();
          return;
        }
      }
    }
  }
}
