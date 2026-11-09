import { safeRel, type RunStoreLike } from "../store.js";
import type { Run, RunEvent } from "../types.js";

/** The part of Durable Object storage this store uses. */
export interface KvStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  list<T>(opts: { prefix: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
}

/**
 * Stopgap store for the Worker until SUPABASE_SERVICE_ROLE_KEY is set: runs live in the
 * Conductor Durable Object's own storage. Supabase remains the system of record.
 */
export class DurableRunStore implements RunStoreLike {
  readonly root = "durable-object";
  private seq = 0;

  constructor(private storage: KvStorage) {}

  runDir(runId: string) {
    if (!/^run_[a-z0-9]+$/i.test(runId)) throw new Error(`invalid run id ${runId}`);
    return `${this.root}/${runId}`;
  }

  async save(run: Run) {
    this.runDir(run.id);
    await this.storage.put(`run:${run.id}`, JSON.parse(JSON.stringify(run)));
  }

  async load(runId: string): Promise<Run> {
    const run = await this.storage.get<Run>(`run:${this.runDir(runId).split("/")[1]}`);
    if (!run) throw new Error(`run ${runId} not found`);
    return run;
  }

  async exists(runId: string) {
    return (await this.storage.get(`run:${runId}`)) !== undefined;
  }

  async appendEvent(ev: RunEvent) {
    const key = `ev:${ev.runId}:${Date.now().toString().padStart(15, "0")}:${String(this.seq++).padStart(6, "0")}`;
    await this.storage.put(key, ev);
  }

  async events(runId: string): Promise<RunEvent[]> {
    return [...(await this.storage.list<RunEvent>({ prefix: `ev:${runId}:` })).values()];
  }

  async list(limit = 50): Promise<Run[]> {
    const runs = [...(await this.storage.list<Run>({ prefix: "run:" })).values()];
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async putFile(runId: string, rel: string, data: Uint8Array | string) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    await this.storage.put(`file:${runId}:${safeRel(rel)}`, bytes);
  }

  async getFile(runId: string, rel: string): Promise<Uint8Array> {
    const data = await this.storage.get<Uint8Array>(`file:${runId}:${safeRel(rel)}`);
    if (!data) throw new Error(`file ${rel} not found for ${runId}`);
    return data;
  }
}
