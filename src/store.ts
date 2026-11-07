import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Run, RunEvent } from "./types.js";

/**
 * File-backed run store. Every action is checkpointed here, which is what makes
 * Recover (resume after a failed step) and Handoff (package state for a person) possible.
 *
 *   <root>/runs/<runId>/run.json       – the run, rewritten atomically after every action
 *   <root>/runs/<runId>/events.jsonl   – append-only event log
 *   <root>/runs/<runId>/evidence/      – screenshots and other binary evidence
 */
/** What Architect needs from storage. RunStore keeps runs on disk; the Worker uses Supabase. */
export interface RunStoreLike {
  /** Base location (a directory on disk; a label for remote stores). */
  readonly root: string;
  /** Where a run's files live (a directory on disk, or a key prefix elsewhere). */
  runDir(runId: string): string;
  save(run: Run): Promise<void>;
  load(runId: string): Promise<Run>;
  exists(runId: string): Promise<boolean>;
  appendEvent(ev: RunEvent): Promise<void>;
  events(runId: string): Promise<RunEvent[]>;
  list(limit?: number): Promise<Run[]>;
  /** Evidence, handoff notes and other files, by path relative to the run. */
  putFile(runId: string, rel: string, data: Uint8Array | string): Promise<void>;
  getFile(runId: string, rel: string): Promise<Uint8Array>;
}

/** Reject absolute paths and `..` so a run file can never escape its run. */
export function safeRel(rel: string): string {
  const clean = rel.replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || /^[a-z]:/i.test(clean) || clean.split("/").includes("..")) {
    throw new Error(`invalid run file path ${rel}`);
  }
  return clean;
}

export class RunStore implements RunStoreLike {
  constructor(readonly root: string) {}

  runDir(runId: string) {
    if (!/^run_[a-z0-9]+$/i.test(runId)) throw new Error(`invalid run id ${runId}`);
    return path.join(this.root, "runs", runId);
  }

  private writes = new Map<string, Promise<void>>();

  /** Saves for one run are applied in order, so a slow earlier write never overwrites a later one. */
  save(run: Run): Promise<void> {
    const data = JSON.stringify(run, null, 2);
    const prev = this.writes.get(run.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.write(run.id, data));
    this.writes.set(run.id, next);
    void next.finally(() => {
      if (this.writes.get(run.id) === next) this.writes.delete(run.id);
    }).catch(() => {});
    return next;
  }

  private async write(runId: string, data: string) {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `run.json.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    await writeFile(tmp, data);
    // Windows refuses to replace a file another handle is reading (EPERM/EBUSY/EACCES): retry briefly.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, path.join(dir, "run.json"));
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")) {
          await rm(tmp, { force: true });
          throw err;
        }
        await new Promise((r) => setTimeout(r, 10 + attempt * 10));
      }
    }
  }

  async load(runId: string): Promise<Run> {
    return JSON.parse(await readFile(path.join(this.runDir(runId), "run.json"), "utf8")) as Run;
  }

  async exists(runId: string) {
    return existsSync(path.join(this.runDir(runId), "run.json"));
  }

  async appendEvent(ev: RunEvent) {
    const dir = this.runDir(ev.runId);
    await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, "events.jsonl"), `${JSON.stringify(ev)}\n`);
  }

  async events(runId: string): Promise<RunEvent[]> {
    const file = path.join(this.runDir(runId), "events.jsonl");
    if (!existsSync(file)) return [];
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunEvent);
  }

  async list(limit = 50): Promise<Run[]> {
    const dir = path.join(this.root, "runs");
    if (!existsSync(dir)) return [];
    const ids = await readdir(dir);
    const runs = await Promise.all(ids.map((id) => this.load(id).catch(() => undefined)));
    return runs
      .filter((r): r is Run => !!r)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async putFile(runId: string, rel: string, data: Uint8Array | string) {
    const file = path.join(this.runDir(runId), safeRel(rel));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async getFile(runId: string, rel: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path.join(this.runDir(runId), safeRel(rel))));
  }
}
