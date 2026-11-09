/**
 * OS-level sandbox for commands Architect runs on a person's machine.
 *
 * Backed by @anthropic-ai/sandbox-runtime (Apache-2.0), used as an unmodified npm dependency:
 * sandbox-exec on macOS, bubblewrap on Linux, a dedicated low-rights account on Windows, and a
 * filtering proxy for network access. The package is loaded lazily so that code paths which never
 * run a shell command (the Cloudflare Worker edition) never import it.
 */
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export type SandboxMode = "auto" | "required" | "off";

export interface SandboxLimits {
  /** Folders the command may write. Everything else is read-only. */
  allowWrite: string[];
  /** Paths the command may not read at all (keys, cloud credentials). */
  denyRead: string[];
  /** Paths inside the writable folders that stay read-only (secrets, git hooks). */
  denyWrite: string[];
  /** Hosts the command may reach. Empty means no network. */
  allowedDomains: string[];
  /** Hosts that are always refused, even when an allow entry matches. */
  deniedDomains: string[];
}

export interface WrappedCommand {
  /** The command line to hand to a shell. */
  command: string;
  /** Extra environment the wrapper needs (proxy settings). */
  env?: Record<string, string>;
  /** Call when the child exits. */
  done(): void;
}

/** Something that confines a shell command before it runs. */
export interface CommandSandbox {
  readonly name: string;
  /** True when commands really run inside an OS boundary (not a pass-through). */
  readonly isolating: boolean;
  /** Why the sandbox is not isolating, when it is not. */
  readonly note?: string;
  wrap(command: string, opts: { cwd: string; limits?: Partial<SandboxLimits> }): Promise<WrappedCommand>;
  dispose(): Promise<void>;
}

/** Package registries and code hosts a build normally needs. Nothing else is reachable. */
export const DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
];

/** Credentials a command never needs to read. */
export function defaultDenyRead(home = homedir()): string[] {
  return [".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".config/gcloud", ".config/gh", ".npmrc", ".netrc", ".git-credentials", ".wrangler", ".cloudflared", ".supabase"].map(
    (p) => path.join(home, p),
  );
}

export function defaultLimits(cwd: string): SandboxLimits {
  return {
    allowWrite: [cwd, tmpdir()],
    denyRead: defaultDenyRead(),
    denyWrite: [path.join(cwd, ".env"), path.join(cwd, ".git", "hooks"), path.join(cwd, ".git", "config")],
    allowedDomains: [...DEFAULT_ALLOWED_DOMAINS],
    deniedDomains: [],
  };
}

function merge(cwd: string, extra?: Partial<SandboxLimits>): SandboxLimits {
  const base = defaultLimits(cwd);
  if (!extra) return base;
  return {
    allowWrite: extra.allowWrite ?? base.allowWrite,
    denyRead: [...base.denyRead, ...(extra.denyRead ?? [])],
    denyWrite: [...base.denyWrite, ...(extra.denyWrite ?? [])],
    allowedDomains: extra.allowedDomains ?? base.allowedDomains,
    deniedDomains: [...base.deniedDomains, ...(extra.deniedDomains ?? [])],
  };
}

/** Runs commands as they are. Used when sandboxing is off or the platform cannot provide it. */
export class PassthroughSandbox implements CommandSandbox {
  readonly name = "none";
  readonly isolating = false;
  constructor(readonly note = "sandboxing is off") {}
  async wrap(command: string): Promise<WrappedCommand> {
    return { command, done: () => {} };
  }
  async dispose() {}
}

type SandboxManagerApi = typeof import("@anthropic-ai/sandbox-runtime").SandboxManager;

/**
 * The sandbox-runtime manager is process-wide, so one Architect process shares one instance.
 * Per-command limits (each run's own folder) are passed as a custom config on every wrap.
 */
export class RuntimeSandbox implements CommandSandbox {
  readonly name = "sandbox-runtime";
  readonly isolating = true;
  private constructor(
    private manager: SandboxManagerApi,
    private base: SandboxLimits,
  ) {}

  /** Start the sandbox, or explain why this machine cannot. */
  static async start(base: SandboxLimits): Promise<RuntimeSandbox> {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    if (!SandboxManager.isSupportedPlatform()) throw new Error(`sandbox-runtime does not support ${process.platform}`);
    const deps = (await SandboxManager.checkDependenciesAsync()) as unknown as { errors?: string[] } | undefined;
    if (deps?.errors?.length) throw new Error(`sandbox-runtime is missing dependencies: ${deps.errors.join("; ")}`);
    await SandboxManager.initialize({
      network: { allowedDomains: base.allowedDomains, deniedDomains: base.deniedDomains },
      filesystem: { denyRead: base.denyRead, allowWrite: base.allowWrite, denyWrite: base.denyWrite },
    });
    return new RuntimeSandbox(SandboxManager, base);
  }

  async wrap(command: string, opts: { cwd: string; limits?: Partial<SandboxLimits> }): Promise<WrappedCommand> {
    const limits = merge(opts.cwd, { ...this.base, ...opts.limits, allowWrite: opts.limits?.allowWrite ?? [opts.cwd, tmpdir()] });
    const commandId = randomBytes(16).toString("base64url");
    const wrapped = await this.manager.wrapWithSandbox(
      command,
      undefined,
      {
        network: { allowedDomains: limits.allowedDomains, deniedDomains: limits.deniedDomains },
        filesystem: { denyRead: limits.denyRead, allowWrite: limits.allowWrite, denyWrite: limits.denyWrite },
      },
      undefined,
      { commandId, commandText: command },
    );
    return {
      command: wrapped,
      done: () => {
        try {
          this.manager.cleanupAfterCommand();
        } catch {
          // best effort
        }
      },
    };
  }

  /** Add the sandbox's explanation of any blocked access to a command's stderr. */
  annotate(command: string, stderr: string): string {
    try {
      return this.manager.annotateStderrWithSandboxFailures(command, stderr);
    } catch {
      return stderr;
    }
  }

  async dispose() {
    await this.manager.reset().catch(() => {});
  }
}

let shared: Promise<CommandSandbox> | undefined;

/**
 * The sandbox for this process, chosen by mode:
 *   auto      – sandbox-runtime when the machine supports it, otherwise run unconfined and say so
 *   required  – sandbox-runtime or nothing: commands fail when it cannot start
 *   off       – no sandbox
 * Defaults to ARCHITECT_SANDBOX, then "auto".
 */
export function sandboxFor(mode: SandboxMode = modeFromEnv(), base?: Partial<SandboxLimits>): Promise<CommandSandbox> {
  if (mode === "off") return Promise.resolve(new PassthroughSandbox());
  if (mode === "auto" && process.platform === "win32") {
    // The Windows backend needs a one-time administrator install (see `npx srt --help`);
    // starting it unasked could raise a UAC prompt, so "auto" only uses it when asked for.
    return Promise.resolve(new PassthroughSandbox("sandbox not started on Windows: set ARCHITECT_SANDBOX=required after installing it (see docs/sandbox.md)"));
  }
  shared ??= RuntimeSandbox.start(merge(process.cwd(), base)).catch((err: unknown) => {
    shared = undefined;
    throw err;
  });
  return shared.catch((err: unknown) => {
    const why = err instanceof Error ? err.message : String(err);
    if (mode === "required") throw new Error(`sandbox required but unavailable: ${why}`);
    return new PassthroughSandbox(`sandbox unavailable, commands run unconfined: ${why}`);
  });
}

export function modeFromEnv(env: NodeJS.ProcessEnv = process.env): SandboxMode {
  const v = (env.ARCHITECT_SANDBOX ?? "auto").toLowerCase();
  return v === "off" || v === "required" ? v : "auto";
}

/** Environment variables that look like secrets are not passed to commands. */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|SESSION|COOKIE|AUTH)/i;

export function scrubEnv(env: NodeJS.ProcessEnv, keep: readonly string[] = []): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_NAME.test(k) && !keep.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Quote one word for a POSIX shell, or for cmd.exe on Windows. */
export function shellQuote(word: string, platform: NodeJS.Platform = process.platform): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(word)) return word;
  if (platform === "win32") return `"${word.replace(/"/g, '""')}"`;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}
