import { randomUUID } from "node:crypto";
import type { Autonomy, Permission, Risk } from "./types.js";

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const now = () => new Date().toISOString();

export function truncate(text: string, max = 12_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

/** What the gate decides for a single action. */
export type GateDecision =
  | { kind: "execute" }
  | { kind: "simulate"; reason: string }
  | { kind: "approve"; reason: string }
  | { kind: "block"; reason: string };

/**
 * The autonomy gate. Pure and deterministic so it can be audited and tested.
 *
 *  Rehearsal      – reads run; anything that changes the world is drafted, not executed.
 *  Accompaniment  – reads and routine writes run; irreversible actions pause for a person.
 *  Autopilot      – everything inside the granted permissions runs; irreversible actions still
 *                   pause unless the Score was granted `standing.irreversible`.
 *
 * A tool whose permission was not granted is always blocked, at every autonomy level.
 */
export function gate(opts: {
  autonomy: Autonomy;
  risk: Risk;
  required: Permission;
  granted: readonly Permission[];
}): GateDecision {
  const { autonomy, risk, required, granted } = opts;
  if (!granted.includes(required)) {
    return { kind: "block", reason: `permission "${required}" was not granted to this Score` };
  }
  if (risk === "read") return { kind: "execute" };
  if (autonomy === "rehearsal") {
    return { kind: "simulate", reason: "Rehearsal prepares drafts and never changes anything" };
  }
  if (risk === "write") return { kind: "execute" };
  // irreversible
  if (autonomy === "autopilot" && granted.includes("standing.irreversible")) return { kind: "execute" };
  return { kind: "approve", reason: "irreversible action needs a person's approval" };
}

/** Words that make a click or keypress consequential (submits, payments, deletions, messages). */
const IRREVERSIBLE_WORDS =
  /\b(submit|pay|payment|purchase|buy|order|place order|checkout|check out|delete|remove|erase|send|publish|post|confirm|transfer|sign|agree|accept|book|reserve|subscribe|unsubscribe|deploy|merge|approve|cancel (?:subscription|order|account))\b/i;

export function classifyByLabel(label: string): Risk {
  return IRREVERSIBLE_WORDS.test(label) ? "irreversible" : "write";
}

const IRREVERSIBLE_COMMANDS =
  /\b(rm\s+-[a-z]*r|rmdir|del\s+\/|git\s+push|git\s+reset\s+--hard|npm\s+publish|vercel\s+(?:--prod|deploy)|kubectl\s+(?:delete|apply)|terraform\s+(?:apply|destroy)|drop\s+(?:table|database)|shutdown|format\s+[a-z]:)/i;

export function classifyCommand(command: string): Risk {
  return IRREVERSIBLE_COMMANDS.test(command) ? "irreversible" : "write";
}

/** Bad input from a caller (API body, CLI flag, imported package). Maps to HTTP 400. */
export class InputError extends Error {}
/** A named thing that does not exist. Maps to HTTP 404. */
export class NotFoundError extends Error {}
