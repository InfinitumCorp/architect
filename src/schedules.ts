import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Architect } from "./architect.js";
import type { ScoreLibrary } from "./library.js";
import { InputError, now } from "./policy.js";
import type { Autonomy } from "./types.js";

/**
 * Autopilot schedules: recurring work run from a saved Score, within standing permissions
 * and a per-run spending limit.
 */
export interface Schedule {
  name: string;
  /** Saved Score to play. */
  score: string;
  /** Run every N minutes… */
  everyMinutes?: number;
  /** …or once a day at HH:MM (server local time). */
  dailyAt?: string;
  inputs: Record<string, string>;
  autonomy: Autonomy;
  budgetUsd?: number;
  enabled: boolean;
  lastRunAt?: string;
  lastRunId?: string;
}

export function isDue(s: Schedule, at: Date): boolean {
  if (!s.enabled) return false;
  const last = s.lastRunAt ? new Date(s.lastRunAt) : undefined;
  if (s.everyMinutes) {
    return !last || at.getTime() - last.getTime() >= s.everyMinutes * 60_000;
  }
  if (s.dailyAt) {
    const [h, m] = s.dailyAt.split(":").map(Number);
    const slot = new Date(at);
    slot.setHours(h!, m!, 0, 0);
    if (at < slot) return false;
    return !last || last < slot;
  }
  return false;
}

export function validateSchedule(s: Partial<Schedule>): Schedule {
  if (!s.name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(s.name)) throw new InputError("schedule name: lowercase letters, digits, dashes");
  if (!s.score) throw new InputError("schedule needs a saved Score name");
  if (!s.everyMinutes === !s.dailyAt) throw new InputError("give exactly one of everyMinutes or dailyAt");
  if (s.everyMinutes !== undefined && (!Number.isFinite(s.everyMinutes) || s.everyMinutes < 5)) {
    throw new InputError("everyMinutes must be at least 5");
  }
  if (s.dailyAt && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.dailyAt)) throw new InputError("dailyAt must be HH:MM");
  return {
    name: s.name,
    score: s.score,
    everyMinutes: s.everyMinutes,
    dailyAt: s.dailyAt,
    inputs: s.inputs ?? {},
    autonomy: s.autonomy ?? "autopilot",
    budgetUsd: s.budgetUsd,
    enabled: s.enabled ?? true,
    lastRunAt: s.lastRunAt,
    lastRunId: s.lastRunId,
  };
}

export class ScheduleStore {
  readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, "schedules.json");
  }
  async list(): Promise<Schedule[]> {
    if (!existsSync(this.file)) return [];
    return JSON.parse(await readFile(this.file, "utf8")) as Schedule[];
  }
  async saveAll(all: Schedule[]) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(all, null, 2));
  }
  async upsert(s: Schedule) {
    const all = (await this.list()).filter((x) => x.name !== s.name);
    all.push(s);
    await this.saveAll(all);
  }
  async remove(name: string) {
    await this.saveAll((await this.list()).filter((x) => x.name !== name));
  }
}

/** Ticks inside `architect serve` and starts due schedules. Never overlaps runs of the same schedule. */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    private architect: Architect,
    private library: ScoreLibrary,
    private store: ScheduleStore,
    private log: (msg: string) => void = (m) => console.log(`[architect schedule] ${m}`),
  ) {}

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  async tick(at = new Date()): Promise<string[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: string[] = [];
    try {
      const all = await this.store.list();
      for (const s of all) {
        if (!isDue(s, at)) continue;
        if (s.lastRunId && this.architect.isActive(s.lastRunId)) continue;
        try {
          const saved = await this.library.get(s.score);
          const run = await this.architect.prepare(saved.score, {
            inputs: s.inputs,
            autonomy: s.autonomy,
            budgetUsd: s.budgetUsd,
            source: `schedule:${s.name}`,
          });
          s.lastRunAt = now();
          s.lastRunId = run.id;
          started.push(run.id);
          this.log(`${s.name} → ${run.id}`);
          void this.architect.perform(run).catch((err) => this.log(`${s.name} failed: ${err}`));
        } catch (err) {
          s.lastRunAt = now(); // do not retry a broken schedule every tick
          this.log(`${s.name} could not start: ${err instanceof Error ? err.message : err}`);
        }
      }
      await this.store.saveAll(all);
    } finally {
      this.ticking = false;
    }
    return started;
  }
}
