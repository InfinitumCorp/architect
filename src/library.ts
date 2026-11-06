import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { InputError, NotFoundError, now } from "./policy.js";
import { PERMISSIONS, type Score } from "./types.js";

/**
 * Saved Scores: reusable workflows you can rerun with new inputs, schedule on Autopilot,
 * or package for the Score Marketplace (where creators are paid in $CNDT).
 */
export interface SavedScore {
  name: string;
  description: string;
  score: Score;
  /** Inputs the Score expects ({{name}} placeholders found in its steps). */
  inputs: string[];
  savedAt: string;
  /** SHA-256 of the Score, so a Marketplace listing can be checked against what is installed. */
  digest: string;
  author?: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const ScoreFileSchema = z.object({
  name: z.string().regex(NAME),
  description: z.string().max(2_000),
  author: z.string().max(200).optional(),
  digest: z.string().optional(),
  score: z.object({
    id: z.string(),
    goal: z.string().max(10_000),
    summary: z.string().max(5_000),
    inputs: z.record(z.string(), z.string()),
    permissions: z.array(z.enum(PERMISSIONS)),
    startUrl: z.string().optional(),
    steps: z
      .array(
        z.object({
          id: z.string(),
          title: z.string().max(500),
          instruction: z.string().max(10_000),
          instruments: z.array(z.string()),
          checkpoint: z.boolean(),
        }),
      )
      .min(1)
      .max(30),
    successCriteria: z.array(z.string()).min(1),
    createdAt: z.string(),
  }),
});

export function digestOf(score: Score): string {
  const { id: _id, createdAt: _c, ...stable } = score;
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function placeholders(score: Score): string[] {
  const found = new Set<string>();
  for (const s of score.steps) for (const m of s.instruction.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) found.add(m[1]!);
  return [...found].sort();
}

export class ScoreLibrary {
  constructor(readonly dir: string) {}

  private file(name: string) {
    if (!NAME.test(name)) throw new InputError(`Score names use lowercase letters, digits and dashes (got "${name}")`);
    return path.join(this.dir, `${name}.json`);
  }

  async save(name: string, score: Score, opts: { description?: string; author?: string } = {}): Promise<SavedScore> {
    const saved: SavedScore = {
      name,
      description: opts.description ?? score.summary,
      score,
      inputs: placeholders(score),
      savedAt: now(),
      digest: digestOf(score),
      author: opts.author,
    };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(name), JSON.stringify(saved, null, 2));
    return saved;
  }

  async get(name: string): Promise<SavedScore> {
    const file = this.file(name);
    if (!existsSync(file)) throw new NotFoundError(`no saved Score named "${name}"`);
    return JSON.parse(await readFile(file, "utf8")) as SavedScore;
  }

  async list(): Promise<SavedScore[]> {
    if (!existsSync(this.dir)) return [];
    const names = (await readdir(this.dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
    const all = await Promise.all(names.map((n) => this.get(n).catch(() => undefined)));
    return all.filter((s): s is SavedScore => !!s).sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(name: string) {
    await rm(this.file(name), { force: true });
  }

  /**
   * Install a Score from a Marketplace package. The package is validated, and its digest checked
   * when it carries one. Permissions are clamped again when the Score is played (Architech.prepare).
   */
  async import(raw: unknown): Promise<SavedScore> {
    const parsed = ScoreFileSchema.parse(raw);
    const score = parsed.score as Score;
    if (parsed.digest && parsed.digest !== digestOf(score)) {
      throw new InputError("package digest does not match its Score; it may have been altered");
    }
    return this.save(parsed.name, score, { description: parsed.description, author: parsed.author });
  }
}
