import { safeRel, type RunStoreLike } from "../store.js";
import type { Run, RunEvent } from "../types.js";

/** Calls one of the architect_* functions with named arguments and returns its result. */
export type RpcCaller = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

export type SupabaseStoreOptions =
  | {
      /** Project URL, e.g. https://<ref>.supabase.co */
      url: string;
      /** Service-role key. Server-side only (a Worker secret); never sent to a browser. */
      serviceKey: string;
      fetch?: typeof fetch;
      call?: undefined;
    }
  | {
      /** Direct database path, e.g. postgresCaller() over Hyperdrive as the architect_worker login. */
      call: RpcCaller;
    };

const ARCHITECT_FNS = new Set([
  "architect_save_run", "architect_get_run", "architect_list_runs", "architect_append_event",
  "architect_events", "architect_put_file", "architect_get_file",
]);

/** The subset of a postgres.js client this store needs. */
export interface UnsafeSql {
  unsafe(query: string, params?: unknown[]): Promise<Array<Record<string, unknown>>>;
}

/**
 * An RpcCaller over a Postgres connection. Only the architect_* functions can be called, arguments
 * always travel as bound parameters, and objects are sent as jsonb.
 */
export function postgresCaller(sql: UnsafeSql): RpcCaller {
  return async (fn, args) => {
    if (!ARCHITECT_FNS.has(fn)) throw new Error(`not an Architect function: ${fn}`);
    const names = Object.keys(args);
    for (const n of names) if (!/^p_[a-z0-9_]+$/.test(n)) throw new Error(`bad argument name ${n}`);
    const params = names.map((n) => {
      const v = args[n];
      return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
    });
    const list = names.map((n, i) => {
      const v = args[n];
      // JSON goes over the wire as text: a param typed jsonb would be JSON-encoded a second time.
      const cast = v !== null && typeof v === "object" ? "::text::jsonb" : typeof v === "number" ? "::int" : "::text";
      return `${n} => $${i + 1}${cast}`;
    });
    const rows = await sql.unsafe(`select public.${fn}(${list.join(", ")}) as r`, params);
    const r = rows[0]?.r;
    return typeof r === "string" && (fn === "architect_get_run" || fn === "architect_list_runs" || fn === "architect_events") ? JSON.parse(r) : (r ?? null);
  };
}

/**
 * Runs, events and files in the shared Supabase project (schema `architect`), reached through
 * the service-role-only RPC functions in supabase/migrations/20261107_architect_runs.sql.
 */
export class SupabaseRunStore implements RunStoreLike {
  readonly root = "supabase:architect";
  private f: typeof fetch;
  private writes = new Map<string, Promise<void>>();

  constructor(private opts: SupabaseStoreOptions) {
    this.f = (opts.call === undefined && opts.fetch) || ((...a) => fetch(...a));
  }

  runDir(runId: string) {
    if (!/^run_[a-z0-9]+$/i.test(runId)) throw new Error(`invalid run id ${runId}`);
    return `${this.root}/${runId}`;
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    if (this.opts.call) return (await this.opts.call(fn, args)) as T;
    const res = await this.f(`${this.opts.url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: this.opts.serviceKey,
        authorization: `Bearer ${this.opts.serviceKey}`,
      },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${fn}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Saves for one run go out in order, so a slow earlier save never overwrites a later one. */
  save(run: Run): Promise<void> {
    const doc = JSON.parse(JSON.stringify(run)) as Run;
    const prev = this.writes.get(run.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.rpc<void>("architect_save_run", { p_run: doc }));
    this.writes.set(run.id, next);
    void next
      .finally(() => {
        if (this.writes.get(run.id) === next) this.writes.delete(run.id);
      })
      .catch(() => {});
    return next;
  }

  async load(runId: string): Promise<Run> {
    this.runDir(runId);
    const run = await this.rpc<Run | null>("architect_get_run", { p_id: runId });
    if (!run || !("score" in run)) throw new Error(`run ${runId} not found`);
    return run;
  }

  async exists(runId: string) {
    return this.load(runId).then(
      () => true,
      () => false,
    );
  }

  async appendEvent(ev: RunEvent) {
    await this.rpc<void>("architect_append_event", { p_event: ev });
  }

  async events(runId: string): Promise<RunEvent[]> {
    return (await this.rpc<RunEvent[] | null>("architect_events", { p_run_id: runId })) ?? [];
  }

  async list(limit = 50): Promise<Run[]> {
    return (await this.rpc<Run[] | null>("architect_list_runs", { p_limit: limit })) ?? [];
  }

  async putFile(runId: string, rel: string, data: Uint8Array | string) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await this.rpc<void>("architect_put_file", { p_run_id: runId, p_path: safeRel(rel), p_base64: toBase64(bytes) });
  }

  async getFile(runId: string, rel: string): Promise<Uint8Array> {
    const b64 = await this.rpc<string | null>("architect_get_file", { p_run_id: runId, p_path: safeRel(rel) });
    if (b64 == null) throw new Error(`file ${rel} not found for ${runId}`);
    const bin = atob(b64.replace(/\s/g, ""));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
