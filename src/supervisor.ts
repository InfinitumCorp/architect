/**
 * Isolated runs: every run gets its own working folder, handed out and taken back by a supervisor.
 *
 * The shape follows two published designs (Apache-2.0, studied for ideas only, no code copied):
 *  - openai/symphony: a workspace manager maps each unit of work to a deterministic folder under one
 *    root, runs lifecycle hooks around it, keeps it across retries, and cleans it up when the work
 *    is finished; dispatch is bounded by a concurrency limit.
 *  - awslabs/cli-agent-orchestrator: a supervisor owns the sessions of the agents it starts, tracks
 *    which are live, and reclaims what a crashed one left behind.
 *
 * Here the unit of work is an Architect run. Folders live at <baseDir>/runs/<runId>; the
 * supervisor's own records live at <baseDir>/leases, outside every run's folder, so a command in
 * one run can neither see nor change another run's files or the supervisor's bookkeeping.
 */
import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export type RunOutcome = "succeeded" | "failed" | "rehearsed" | "handed_off" | "cancelled" | string;

/** How a new run folder is filled before the first command runs. */
export type WorkspaceSeed =
  | { kind: "empty" }
  /** Copy a template folder (node_modules and .git are skipped). */
  | { kind: "copy"; from: string }
  /** `git worktree add --detach` from a local repository, at `ref` or its HEAD. */
  | { kind: "git-worktree"; repo: string; ref?: string };

/** What happens to a run's folder when the run ends. */
export type RetainPolicy = "always" | "on-failure" | "never";

export interface SupervisorOptions {
  baseDir: string;
  seed?: WorkspaceSeed;
  /** Runs that may hold a folder at once. Further runs wait for a free slot. Default 4. */
  maxConcurrent?: number;
  /** Default "on-failure": failed and handed-off runs keep their folder for a person to inspect. */
  retain?: RetainPolicy;
  /** Operator-configured shell hooks, run in the run folder (not model-supplied). */
  hooks?: { afterCreate?: string; beforeRemove?: string };
  hookTimeoutMs?: number;
}

export interface LeaseRecord {
  runId: string;
  root: string;
  pid: number;
  startedAt: string;
  seed: WorkspaceSeed["kind"];
}

export interface Lease extends LeaseRecord {
  release(outcome: RunOutcome): Promise<void>;
}

/** Run ids become folder names: keep them to a safe alphabet. */
export function workspaceKey(runId: string): string {
  const key = runId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
  if (!key || key === "_" || /^_+$/.test(key)) throw new Error(`run id "${runId}" cannot name a workspace`);
  return key;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class RunSupervisor {
  readonly baseDir: string;
  private leases = new Map<string, Lease>();
  private pending = new Map<string, Promise<Lease>>();
  private waiting: (() => void)[] = [];

  constructor(private opts: SupervisorOptions) {
    this.baseDir = path.resolve(opts.baseDir);
  }

  get maxConcurrent() {
    return Math.max(1, this.opts.maxConcurrent ?? 4);
  }

  runsDir() {
    return path.join(this.baseDir, "runs");
  }

  private leaseFile(key: string) {
    return path.join(this.baseDir, "leases", `${key}.json`);
  }

  /** The folder a run works in. Not created until `acquire`. */
  rootFor(runId: string) {
    return path.join(this.runsDir(), workspaceKey(runId));
  }

  active(): LeaseRecord[] {
    return [...this.leases.values()].map(({ release: _r, ...rec }) => rec);
  }

  get(runId: string): Lease | undefined {
    return this.leases.get(runId);
  }

  /**
   * The run's folder, created and seeded the first time. A run that is recovered or resumed gets
   * the same folder back with its files intact. Waits while `maxConcurrent` runs hold folders.
   */
  acquire(runId: string): Promise<Lease> {
    const held = this.leases.get(runId);
    if (held) return Promise.resolve(held);
    const inFlight = this.pending.get(runId);
    if (inFlight) return inFlight;
    const p = this.open(runId).finally(() => this.pending.delete(runId));
    this.pending.set(runId, p);
    return p;
  }

  private async open(runId: string): Promise<Lease> {
    while (this.leases.size + this.opening >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.opening++;
    try {
      const key = workspaceKey(runId);
      const root = this.rootFor(runId);
      const fresh = !(await exists(root));
      if (fresh) await this.seed(root);
      if (fresh && this.opts.hooks?.afterCreate) await this.hook(this.opts.hooks.afterCreate, root, "afterCreate");
      const rec: LeaseRecord = { runId, root, pid: process.pid, startedAt: new Date().toISOString(), seed: this.opts.seed?.kind ?? "empty" };
      await mkdir(path.dirname(this.leaseFile(key)), { recursive: true });
      await writeFile(this.leaseFile(key), JSON.stringify(rec, null, 2));
      const lease: Lease = {
        ...rec,
        release: async (outcome) => {
          await this.release(runId, outcome);
        },
      };
      this.leases.set(runId, lease);
      return lease;
    } finally {
      this.opening--;
    }
  }
  private opening = 0;

  /** Give a run's folder back. Whether the folder is kept depends on the retain policy. */
  async release(runId: string, outcome: RunOutcome): Promise<{ kept: boolean; root: string } | undefined> {
    const lease = this.leases.get(runId);
    if (!lease) return undefined;
    this.leases.delete(runId);
    const retain = this.opts.retain ?? "on-failure";
    const keep = retain === "always" || (retain === "on-failure" && outcome !== "succeeded" && outcome !== "rehearsed");
    try {
      if (!keep) await this.remove(lease.root);
      await rm(this.leaseFile(workspaceKey(runId)), { force: true });
    } finally {
      this.waiting.shift()?.();
    }
    return { kept: keep, root: lease.root };
  }

  /**
   * Startup cleanup: leases written by a process that is no longer alive are dropped. Their folders
   * are kept (a person may want them); returns the run ids that were reclaimed.
   */
  async reclaimStale(): Promise<string[]> {
    const dir = path.join(this.baseDir, "leases");
    const names = await readdir(dir).catch(() => [] as string[]);
    const reclaimed: string[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(dir, name);
      try {
        const rec = JSON.parse(await readFile(file, "utf8")) as LeaseRecord;
        if (rec.pid === process.pid || pidAlive(rec.pid)) continue;
        await rm(file, { force: true });
        reclaimed.push(rec.runId);
      } catch {
        await rm(file, { force: true });
      }
    }
    return reclaimed;
  }

  private async seed(root: string) {
    const seed = this.opts.seed ?? { kind: "empty" };
    await mkdir(path.dirname(root), { recursive: true });
    if (seed.kind === "empty") {
      await mkdir(root, { recursive: true });
    } else if (seed.kind === "copy") {
      const from = path.resolve(seed.from);
      await cp(from, root, {
        recursive: true,
        filter: (src) => {
          const base = path.basename(src);
          return base !== "node_modules" && base !== ".git";
        },
      });
    } else {
      const args = ["-C", path.resolve(seed.repo), "worktree", "add", "--detach", root];
      if (seed.ref) args.push(seed.ref);
      await exec("git", args, this.opts.hookTimeoutMs ?? 120_000);
    }
  }

  private async remove(root: string) {
    if (this.opts.hooks?.beforeRemove) await this.hook(this.opts.hooks.beforeRemove, root, "beforeRemove").catch(() => {});
    const seed = this.opts.seed;
    if (seed?.kind === "git-worktree") {
      await exec("git", ["-C", path.resolve(seed.repo), "worktree", "remove", "--force", root], 60_000).catch(() => {});
    }
    // Only ever delete inside our own runs folder.
    const rel = path.relative(this.runsDir(), root);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`refusing to remove ${root}`);
    await rm(root, { recursive: true, force: true });
  }

  private async hook(command: string, cwd: string, name: string) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, { cwd, shell: true, stdio: "ignore" });
      const timer = setTimeout(() => child.kill(), this.opts.hookTimeoutMs ?? 120_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`${name} hook exited with ${code}`));
      });
    });
  }
}

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function exec(file: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${file} ${args.join(" ")} exited with ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Supervisor settings from the environment:
 *   ARCHITECT_ISOLATION=per-run          turn per-run folders on
 *   ARCHITECT_MAX_CONCURRENT_RUNS=4      runs that may hold a folder at once
 *   ARCHITECT_WORKSPACE_SEED=<dir>       copy this folder into each new run folder
 *   ARCHITECT_WORKSPACE_SEED=git:<repo>[#ref]   or make each run a git worktree of a local repo
 *   ARCHITECT_RETAIN=on-failure|always|never
 */
export function supervisorFromEnv(baseDir: string, env: NodeJS.ProcessEnv = process.env): RunSupervisor | undefined {
  if ((env.ARCHITECT_ISOLATION ?? "shared").toLowerCase() !== "per-run") return undefined;
  const raw = env.ARCHITECT_WORKSPACE_SEED;
  let seed: WorkspaceSeed = { kind: "empty" };
  if (raw?.startsWith("git:")) {
    const [repo, ref] = raw.slice(4).split("#");
    seed = { kind: "git-worktree", repo, ref: ref || undefined };
  } else if (raw) seed = { kind: "copy", from: raw };
  const retain = env.ARCHITECT_RETAIN as RetainPolicy | undefined;
  return new RunSupervisor({
    baseDir,
    seed,
    maxConcurrent: env.ARCHITECT_MAX_CONCURRENT_RUNS ? Number(env.ARCHITECT_MAX_CONCURRENT_RUNS) : undefined,
    retain: retain === "always" || retain === "never" || retain === "on-failure" ? retain : undefined,
  });
}
