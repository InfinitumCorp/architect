/**
 * Agent-manager features: plan review policy, slash commands, comments on artifacts,
 * the walkthrough, knowledge from earlier verified runs, and per-run host lists.
 * Everything here is pure, so it is shared by the CLI server, the Worker and the tests.
 */
import type { Autonomy, Run, RunComment, ReviewPolicy, Score } from "./types.js";

export const REVIEW_POLICIES: ReviewPolicy[] = ["always_proceed", "agent_decides", "request_review"];

// ───────────────────────────── Slash commands ─────────────────────────────

export interface ParsedGoal {
  goal: string;
  review?: ReviewPolicy;
  autonomy?: Autonomy;
}

const COMMANDS: Record<string, Omit<ParsedGoal, "goal">> = {
  "/plan": { review: "request_review" },
  "/fast": { review: "always_proceed" },
  "/rehearse": { autonomy: "rehearsal" },
  "/rehearsal": { autonomy: "rehearsal" },
  "/autopilot": { autonomy: "autopilot" },
  "/browser": {},
};

/** Leading slash commands set options; the rest is the goal. "/plan /autopilot book a room" works. */
export function parseGoal(input: string): ParsedGoal {
  let rest = input.trim();
  const out: ParsedGoal = { goal: rest };
  for (;;) {
    const m = /^(\/[a-z]+)\b\s*/i.exec(rest);
    const cmd = m && COMMANDS[m[1]!.toLowerCase()];
    if (!m || !cmd) break;
    Object.assign(out, cmd);
    rest = rest.slice(m[0].length);
  }
  out.goal = rest.trim();
  return out;
}

// ───────────────────────────── Plan review ─────────────────────────────

/**
 * Whether a composed Score waits for a person to review the plan before it is performed.
 * "agent_decides" asks when the plan can change things that are hard to undo or is long.
 */
export function planReview(score: Score, policy: ReviewPolicy, autonomy: Autonomy): { required: boolean; reason: string } {
  if (policy === "always_proceed") return { required: false, reason: "review policy is Always proceed" };
  if (policy === "request_review") return { required: true, reason: "review policy is Request review" };
  if (autonomy === "rehearsal") return { required: false, reason: "Rehearsal changes nothing" };
  const risky = score.permissions.filter((p) => ["http.write", "shell", "ecosystem", "standing.irreversible"].includes(p));
  if (risky.length) return { required: true, reason: `the plan can use ${risky.join(", ")}` };
  if (score.steps.length > 6) return { required: true, reason: `the plan has ${score.steps.length} steps` };
  return { required: false, reason: "short plan with routine permissions" };
}

// ───────────────────────────── Comments ─────────────────────────────

/** "score", "step:<id>", "evidence:<id>" or "walkthrough". */
export function validTarget(run: Run, target: string): boolean {
  if (target === "score" || target === "walkthrough") return true;
  const [kind, id] = target.split(":");
  if (kind === "step") return run.score.steps.some((s) => s.id === id);
  if (kind === "evidence") return run.evidence.some((e) => e.id === id);
  return false;
}

/** How a person's comments reach the performer: trusted, from the person, unlike tool output. */
export function commentsMessage(comments: RunComment[], run: Run): string {
  const lines = comments.map((c) => {
    const step = c.target.startsWith("step:") ? run.score.steps.find((s) => `step:${s.id}` === c.target) : undefined;
    const where = step ? `on step ${step.id} "${step.title}"` : `on the ${c.target.split(":")[0]}`;
    return `- ${where}: ${c.text}`;
  });
  return `<person_feedback>\nThe person reviewing this run left comments. Take them into account from now on; they come from the person, not from a tool.\n${lines.join("\n")}\n</person_feedback>`;
}

// ───────────────────────────── Walkthrough ─────────────────────────────

/** A reviewable account of the run: what was planned, what happened, the proof. Markdown. */
export function walkthrough(run: Run): string {
  const s = run.score;
  const out: string[] = [`# Walkthrough: ${s.goal}`, "", `**Status:** ${run.status.replace(/_/g, " ")} · **Autonomy:** ${run.autonomy}`];
  if (run.usage) out.push(`**Cost:** $${run.usage.costUsd.toFixed(4)} · ${run.usage.inputTokens + run.usage.outputTokens} tokens`);
  out.push("", s.summary, "", "## Steps");
  for (const step of s.steps) {
    const st = run.steps.find((x) => x.id === step.id);
    const mark = st?.status === "done" ? "[x]" : "[ ]";
    out.push(`- ${mark} **${step.title}** (${st?.status ?? "pending"})${st?.summary ? ` — ${st.summary}` : ""}`);
    const acts = run.actions.filter((a) => a.stepId === step.id);
    for (const a of acts.slice(-8)) out.push(`  - \`${a.tool}\` ${a.outcome}${a.approval ? (a.approval.approved ? " (approved)" : " (declined)") : ""}`);
    if (acts.length > 8) out.push(`  - …and ${acts.length - 8} earlier actions`);
  }
  const ev = run.evidence;
  if (ev.length) {
    out.push("", "## Evidence");
    for (const e of ev) out.push(`- **${e.label}** (${e.kind})${e.content ? `: ${e.content.slice(0, 200)}` : ""}${e.path ? ` — \`${e.path}\`` : ""}`);
  }
  if (run.verdict) {
    out.push("", `## Verification: ${run.verdict.passed ? "passed" : "not passed"}`, "", run.verdict.summary);
    for (const c of run.verdict.criteria) out.push(`- ${c.met ? "[x]" : "[ ]"} ${c.criterion} — ${c.evidence}`);
  }
  if (run.error) out.push("", "## Problem", "", run.error);
  if (run.comments?.length) {
    out.push("", "## Comments");
    for (const c of run.comments) out.push(`- (${c.target}) ${c.text}`);
  }
  return out.join("\n") + "\n";
}

// ───────────────────────────── Knowledge ─────────────────────────────

export interface KnowledgeItem {
  runId: string;
  goal: string;
  summary: string;
  steps: string[];
  startUrl?: string;
  score: number;
}

const STOP = new Set("a an the and or of to in on for with from at by is are be it this that my our your".split(" "));
const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)));

/** Verified earlier runs that resemble this goal, best first. */
export function relatedKnowledge(goal: string, runs: Run[], limit = 3): KnowledgeItem[] {
  const want = words(goal);
  if (!want.size) return [];
  return runs
    .filter((r) => r.status === "succeeded" && r.verdict?.passed)
    .map((r) => {
      const have = words(`${r.score.goal} ${r.score.summary}`);
      let hit = 0;
      for (const w of want) if (have.has(w)) hit++;
      return {
        runId: r.id,
        goal: r.score.goal,
        summary: r.verdict?.summary ?? r.score.summary,
        steps: r.score.steps.map((s) => s.title),
        startUrl: r.score.startUrl,
        score: hit / want.size,
      };
    })
    .filter((k) => k.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function knowledgePrompt(items: KnowledgeItem[]): string {
  if (!items.length) return "";
  return [
    "Knowledge from earlier verified runs of similar outcomes (reuse what worked; the current request wins where they differ):",
    ...items.map((k) => `- "${k.goal}"${k.startUrl ? ` (start ${k.startUrl})` : ""}: ${k.steps.join(" → ")}. Result: ${k.summary.slice(0, 200)}`),
  ].join("\n");
}

// ───────────────────────────── Host lists ─────────────────────────────

const host = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};
const matches = (h: string, rule: string) => {
  const r = rule.toLowerCase().replace(/^\*\./, "");
  return h === r || h.endsWith(`.${r}`);
};

/** Any URL field in a tool's input must pass the run's allow and block lists. Returns the reason when it does not. */
export function hostRefusal(input: Record<string, unknown>, hosts: Score["hosts"]): string | undefined {
  if (!hosts || (!hosts.allow?.length && !hosts.block?.length)) return undefined;
  for (const [k, v] of Object.entries(input)) {
    // Only fields that address a location (url, href, endpoint…), so file contents that mention a URL still pass.
    if (!/url|href|endpoint|link|origin/i.test(k)) continue;
    if (typeof v !== "string" || !/^https?:\/\//i.test(v)) continue;
    const h = host(v);
    if (!h) return `unreadable URL ${v}`;
    if (hosts.block?.some((r) => matches(h, r))) return `${h} is on this run's block list`;
    if (hosts.allow?.length && !hosts.allow.some((r) => matches(h, r))) return `${h} is not on this run's allow list`;
  }
  return undefined;
}

export function hostList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v.map((x) => String(x).trim().toLowerCase()).filter((x) => /^(\*\.)?[a-z0-9.-]+$/.test(x));
  return list.length ? list.slice(0, 50) : undefined;
}
