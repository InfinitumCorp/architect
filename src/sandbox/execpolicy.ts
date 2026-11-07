/**
 * Command policy for the workspace shell: which commands run, which need a person, which never run.
 *
 * The design follows the idea behind openai/codex `execpolicy` (Apache-2.0): rules are prefix
 * patterns over a command's argv, each with a decision, and when a shell line holds several
 * commands the strictest decision wins. No code was taken from that project; this is a small
 * TypeScript rewrite of the idea for Architect's gate.
 *
 *   allow    – runs inside the sandbox like any routine write
 *   approve  – treated as irreversible: pauses for a person (or needs standing.irreversible)
 *   deny     – never runs, at any autonomy level, even with an approval
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Risk } from "../types.js";

export type CommandDecision = "allow" | "approve" | "deny";

/** One token of a pattern: a literal word, or a list of alternatives. */
export type PatternToken = string | string[];

export interface CommandRule {
  /** Matched against the start of a command's argv. `"*"` matches any single word. */
  pattern: PatternToken[];
  decision: CommandDecision;
  /** Shown to the model and recorded with the action when the rule decides. */
  justification?: string;
}

export interface CommandPolicy {
  rules: CommandRule[];
  /** Decision for a command no rule matches. */
  defaultDecision: CommandDecision;
  /** Decision for shell constructs the parser does not follow: `$(...)`, backticks, `eval`. */
  opaqueDecision: CommandDecision;
}

export interface CommandEvaluation {
  decision: CommandDecision;
  /** The rule (or built-in check) that produced the strictest decision. */
  reason: string;
  /** Each simple command found in the line, as argv. */
  commands: string[][];
}

const RANK: Record<CommandDecision, number> = { allow: 0, approve: 1, deny: 2 };
const stricter = (a: CommandDecision, b: CommandDecision) => (RANK[b] > RANK[a] ? b : a);

const r = (pattern: PatternToken[], decision: CommandDecision, justification: string): CommandRule => ({
  pattern,
  decision,
  justification,
});

/** The rules Architect ships with. A policy file adds to these; it cannot remove a deny. */
export const DEFAULT_RULES: CommandRule[] = [
  // Never: privilege, whole-disk and machine-state commands.
  r([["sudo", "su", "doas", "runas"]], "deny", "commands run as the workspace user only"),
  r([["mkfs", "mkfs.ext4", "mkfs.vfat", "fdisk", "diskpart", "format"]], "deny", "disk formatting is never allowed"),
  r([["shutdown", "reboot", "halt", "poweroff"]], "deny", "machine power state is never changed"),
  r(["dd"], "approve", "dd can overwrite devices"),
  r(["chmod", "-R", "777"], "deny", "world-writable trees are not allowed"),
  // Needs a person: anything that publishes, deploys, rewrites history or deletes trees.
  r(["git", "push"], "approve", "pushing changes leaves the machine"),
  r(["git", "reset", "--hard"], "approve", "discards uncommitted work"),
  r(["git", "clean"], "approve", "deletes untracked files"),
  r(["git", "filter-branch"], "approve", "rewrites history"),
  r(["git", "branch", ["-D", "--delete"]], "approve", "deletes a branch"),
  r(["rm", ["-r", "-R", "-rf", "-fr", "-Rf", "-fR", "--recursive"]], "approve", "deletes a directory tree"),
  r(["rmdir"], "approve", "deletes a directory"),
  r(["del", ["/s", "/S", "/q", "/Q"]], "approve", "deletes files"),
  r(["Remove-Item"], "approve", "deletes files"),
  r([["npm", "pnpm", "yarn"], ["publish", "unpublish", "deprecate"]], "approve", "publishes to a package registry"),
  r(["cargo", "publish"], "approve", "publishes to a package registry"),
  r(["twine", "upload"], "approve", "publishes to a package registry"),
  r([["wrangler", "cf"], "deploy"], "approve", "production deploys need a person (BUILD_RULES)"),
  r(["wrangler", ["publish", "delete", "secret"]], "approve", "changes a live Cloudflare Worker"),
  r(["vercel"], "approve", "deploys or changes a Vercel project"),
  r(["supabase", "db", ["push", "reset"]], "approve", "changes a live database"),
  r(["supabase", ["functions", "secrets"], ["deploy", "set", "unset", "delete"]], "approve", "changes a live Supabase project"),
  r(["gh", "pr", ["merge", "close"]], "approve", "changes a pull request on GitHub"),
  r(["gh", "release", ["create", "delete"]], "approve", "changes a GitHub release"),
  r(["gh", "repo", ["delete", "archive", "edit"]], "approve", "changes a GitHub repository"),
  r(["kubectl", ["apply", "delete", "replace", "patch", "scale"]], "approve", "changes a cluster"),
  r(["terraform", ["apply", "destroy", "import"]], "approve", "changes infrastructure"),
  r(["docker", "push"], "approve", "publishes an image"),
];

export const DEFAULT_POLICY: CommandPolicy = {
  rules: DEFAULT_RULES,
  defaultDecision: "allow",
  opaqueDecision: "approve",
};

const RuleSchema = z.object({
  pattern: z.array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])).min(1),
  decision: z.enum(["allow", "approve", "deny"]),
  justification: z.string().optional(),
});

export const PolicyFileSchema = z.object({
  rules: z.array(RuleSchema).default([]),
  defaultDecision: z.enum(["allow", "approve", "deny"]).optional(),
  opaqueDecision: z.enum(["allow", "approve", "deny"]).optional(),
});

/**
 * Build a policy from a JSON policy file's contents, layered over the defaults.
 * File rules are checked as well as the defaults, and the strictest decision wins,
 * so a file can tighten the defaults but never turn a default "deny" into "allow".
 */
export function policyFrom(json: unknown, base: CommandPolicy = DEFAULT_POLICY): CommandPolicy {
  const parsed = PolicyFileSchema.parse(json);
  return {
    rules: [...base.rules, ...parsed.rules],
    defaultDecision: parsed.defaultDecision ?? base.defaultDecision,
    opaqueDecision: parsed.opaqueDecision ?? base.opaqueDecision,
  };
}

export function loadPolicyFile(file: string): CommandPolicy {
  return policyFrom(JSON.parse(readFileSync(file, "utf8")));
}

/** The policy from ARCHITECT_EXECPOLICY (a JSON file), or the defaults. */
export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): CommandPolicy {
  return env.ARCHITECT_EXECPOLICY ? loadPolicyFile(env.ARCHITECT_EXECPOLICY) : DEFAULT_POLICY;
}

// ───────────────────────────── Parsing ─────────────────────────────

interface ParsedLine {
  commands: string[][];
  /** Set when the line uses constructs whose inner commands are not visible to the parser. */
  opaque?: string;
  /** Set when a pipeline feeds a download into an interpreter (`curl … | sh`). */
  pipeToShell?: boolean;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "python", "python3", "node", "iex", "Invoke-Expression"]);
const DOWNLOADERS = new Set(["curl", "wget", "iwr", "Invoke-WebRequest", "irm", "Invoke-RestMethod"]);
const WRAPPERS = new Set(["env", "nohup", "time", "nice", "timeout", "xargs", "command", "exec", "npx", "bunx"]);

/**
 * Split a shell line into simple commands and their words. Handles quotes, escapes and the
 * separators `;`, `&&`, `||`, `|`, `&` and newlines. Redirections are dropped from argv.
 * It is deliberately conservative: anything it cannot follow is reported as opaque.
 */
export function parseCommandLine(line: string): ParsedLine {
  const commands: string[][] = [];
  const pipes: boolean[] = []; // pipes[i]: command i receives a pipe from command i-1
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let opaque: string | undefined;
  let quote: '"' | "'" | null = null;
  let pipedIn = false;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = (nextPiped: boolean) => {
    endWord();
    if (words.length) {
      commands.push(words);
      pipes.push(pipedIn);
    }
    words = [];
    pipedIn = nextPiped;
  };

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < line.length) word += line[++i];
      else {
        if (c === "`" || (c === "$" && line[i + 1] === "(")) opaque ??= "command substitution";
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      word += line[++i];
      inWord = true;
      continue;
    }
    if (c === "`" || (c === "$" && line[i + 1] === "(") || (c === "<" && line[i + 1] === "(") || (c === ">" && line[i + 1] === "(")) {
      opaque ??= "command substitution";
      word += c;
      inWord = true;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      // Subshells and groups: their contents are still split into commands below.
      endCommand(false);
      continue;
    }
    if (c === ";" || c === "\n" || c === "\r") {
      endCommand(false);
      continue;
    }
    if (c === "&") {
      if (line[i + 1] === "&") i++;
      else if (line[i - 1] === ">" || line[i + 1] === ">") continue; // 2>&1, &>file
      endCommand(false);
      continue;
    }
    if (c === "|") {
      if (line[i + 1] === "|") {
        i++;
        endCommand(false);
      } else endCommand(true);
      continue;
    }
    if (c === ">" || c === "<") {
      // Drop the redirection operator and its target from argv.
      endWord();
      if (/^\d+$/.test(words[words.length - 1] ?? "") && line[i - 1] !== " ") words.pop();
      while (line[i + 1] === ">" || line[i + 1] === "&" || line[i + 1] === "|") i++;
      while (line[i + 1] === " " || line[i + 1] === "\t") i++;
      while (i + 1 < line.length && !/[\s;&|<>()]/.test(line[i + 1])) i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    word += c;
    inWord = true;
  }
  if (quote) opaque ??= "unterminated quote";
  endCommand(false);

  let pipeToShell = false;
  for (let i = 1; i < commands.length; i++) {
    if (!pipes[i]) continue;
    const prev = baseCommand(commands[i - 1]);
    const cur = baseCommand(commands[i]);
    if (DOWNLOADERS.has(prev[0] ?? "") && SHELLS.has(cur[0] ?? "")) pipeToShell = true;
  }
  for (const argv of commands) {
    const head = programName(argv[0] ?? "");
    if (head === "eval" || head === "source" || head === ".") opaque ??= `${head} runs text the parser cannot see`;
    if (SHELLS.has(head) && argv.some((a) => a === "-c" || a === "-Command" || a === "/c" || a === "-e")) {
      opaque ??= `${head} runs an inline script`;
    }
  }
  return { commands, opaque, pipeToShell };
}

/** `/usr/bin/git` → `git`, `npm.cmd` → `npm`. */
function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

/** Strip leading `VAR=value` assignments and wrappers like `env`, `npx`, `timeout 10`. */
function baseCommand(argv: string[]): string[] {
  let i = 0;
  for (;;) {
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++;
    const head = programName(argv[i] ?? "");
    if (!WRAPPERS.has(head)) break;
    i++;
    // Wrapper options and a numeric timeout, e.g. `timeout 30 cmd`, `npx -y pkg`.
    while (i < argv.length && (argv[i].startsWith("-") || /^\d+[smh]?$/.test(argv[i]))) i++;
  }
  const rest = argv.slice(i);
  if (rest.length) rest[0] = programName(rest[0]);
  return rest;
}

function tokenMatches(token: PatternToken, word: string): boolean {
  if (token === "*") return true;
  const options = Array.isArray(token) ? token : [token];
  return options.some((o) => o === word || o.toLowerCase() === word.toLowerCase());
}

/** Does the rule's prefix pattern match argv? Flags may appear anywhere after the program word. */
export function ruleMatches(rule: CommandRule, argv: string[]): boolean {
  if (!argv.length || !tokenMatches(rule.pattern[0], argv[0])) return false;
  let at = 1;
  for (const token of rule.pattern.slice(1)) {
    const isFlag = (Array.isArray(token) ? token : [token]).every((t) => t.startsWith("-") || t.startsWith("/"));
    if (isFlag) {
      // A flag token may match any later word, so `rm build -rf` and `git push -f origin` both count.
      if (!argv.slice(at).some((w) => tokenMatches(token, w))) return false;
      continue;
    }
    // A subcommand token must be the next word that is not a flag.
    while (at < argv.length && argv[at].startsWith("-")) at++;
    if (at >= argv.length || !tokenMatches(token, argv[at])) return false;
    at++;
  }
  return true;
}

/** Decide a whole shell line. The strictest decision of all its commands wins. */
export function evaluateCommand(line: string, policy: CommandPolicy = DEFAULT_POLICY): CommandEvaluation {
  const parsed = parseCommandLine(line);
  let decision: CommandDecision = parsed.commands.length ? "allow" : policy.defaultDecision;
  let reason = "no rule matched";
  const raise = (d: CommandDecision, why: string) => {
    if (RANK[d] > RANK[decision]) {
      decision = d;
      reason = why;
    }
  };
  if (parsed.pipeToShell) raise("deny", "piping a download into an interpreter is not allowed");
  if (parsed.opaque) raise(policy.opaqueDecision, parsed.opaque);
  for (const raw of parsed.commands) {
    const argv = baseCommand(raw);
    let matched = false;
    for (const rule of policy.rules) {
      if (!ruleMatches(rule, argv)) continue;
      matched = true;
      raise(rule.decision, rule.justification ?? `matched ${JSON.stringify(rule.pattern)}`);
    }
    if (!matched) raise(policy.defaultDecision, "no rule matched");
  }
  if (decision === "allow") reason = "allowed by policy";
  return { decision, reason, commands: parsed.commands };
}

/** Map a policy decision onto the gate's risk scale. A denied command is refused before it runs. */
export function riskOf(decision: CommandDecision): Risk {
  return decision === "allow" ? "write" : "irreversible";
}

export { stricter as stricterDecision };
