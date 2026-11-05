import { appendFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
export class RunStore {
  constructor(readonly root: string) {}

  runDir(runId: string) {
    if (!/^run_[a-z0-9]+$/i.test(runId)) throw new Error(`invalid run id ${runId}`);
    return path.join(this.root, "runs", runId);
  }

  async save(run: Run) {
    const dir = this.runDir(run.id);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, "run.json.tmp");
    await writeFile(tmp, JSON.stringify(run, null, 2));
    await rename(tmp, path.join(dir, "run.json"));
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
}
