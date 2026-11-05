import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { Autonomy, Permission, Signal } from "./types.js";

/**
 * "Triggered by the ecosystem": a signal from Spectre, [HRVST], Cumulus://Cloud or METATRON¹⁰⁰
 * starts a Score automatically, so insight becomes action without a hand-off.
 */
export interface TriggerRule {
  product: string;
  /** Signal type to match; "*" matches any. */
  type: string;
  /** Goal template. {{payload.key}} and {{product}} / {{type}} are filled from the signal. */
  goal: string;
  autonomy?: Autonomy;
  permissions?: Permission[];
  startUrl?: string;
}

export const DEFAULT_TRIGGERS: TriggerRule[] = [
  {
    product: "spectre",
    type: "renewal_risk",
    goal: "Spectre flagged a renewal risk for {{payload.account}} ({{payload.reason}}). Review the account's recent activity, draft a personal follow-up for the account owner {{payload.owner}}, and prepare it for approval.",
    autonomy: "accompaniment",
    permissions: ["ecosystem", "http.read"],
  },
  {
    product: "hrvst",
    type: "fault",
    goal: "[HRVST] captured a fault: {{payload.description}} at {{payload.location}}. Open a maintenance ticket with the observation and evidence, and assign it to {{payload.team}}.",
    autonomy: "accompaniment",
    permissions: ["ecosystem", "browser"],
  },
  {
    product: "metatron",
    type: "event",
    goal: "METATRON¹⁰⁰ flagged an event: {{payload.summary}}. Work out what it means for the user and prepare the follow-up actions it calls for.",
    autonomy: "rehearsal",
    permissions: ["ecosystem", "browser", "http.read"],
  },
  {
    product: "cumulus",
    type: "alert",
    goal: "Cumulus://Cloud raised an alert: {{payload.message}} on {{payload.resource}}. Diagnose it with read-only checks and prepare the remediation.",
    autonomy: "rehearsal",
    permissions: ["ecosystem", "http.read"],
  },
];

function fill(template: string, signal: Signal): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key: string) => {
    if (key === "product") return signal.product;
    if (key === "type") return signal.type;
    if (key.startsWith("payload.")) {
      const value = signal.payload[key.slice("payload.".length)];
      // Signal content is data: flatten it so it cannot smuggle structure into the goal.
      return value === undefined ? "(unknown)" : String(typeof value === "object" ? JSON.stringify(value) : value).replace(/\s+/g, " ").slice(0, 500);
    }
    return m;
  });
}

export class TriggerRouter {
  constructor(public rules: TriggerRule[] = DEFAULT_TRIGGERS) {}

  static async fromFile(file: string): Promise<TriggerRouter> {
    if (!existsSync(file)) return new TriggerRouter();
    return new TriggerRouter(JSON.parse(await readFile(file, "utf8")) as TriggerRule[]);
  }

  match(signal: Signal): (Omit<TriggerRule, "goal" | "product" | "type"> & { goal: string }) | undefined {
    const rule = this.rules.find((r) => r.product === signal.product && (r.type === "*" || r.type === signal.type));
    if (!rule) return undefined;
    return { goal: fill(rule.goal, signal), autonomy: rule.autonomy, permissions: rule.permissions, startUrl: rule.startUrl };
  }
}
