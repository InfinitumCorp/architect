import { CHECKS, formatResults, runSafetyChecks } from "../safety/scanners.js";
import { truncate } from "../policy.js";
import type { Instrument, ToolContext, ToolOutput, ToolSpec } from "./types.js";
import type { WorkspaceInstrument } from "./workspace.js";

/**
 * Safety scans of the project in the workspace, using whichever open-source scanners are installed
 * (see src/safety/scanners.ts). Scanners that are missing are reported as skipped with an install hint.
 */
export class SafetyInstrument implements Instrument {
  name = "safety";
  description =
    "Scan the project in the workspace for vulnerable dependencies, committed secrets, risky agent skills or plugins, and (when configured) LLM prompt-injection weaknesses. Uses the scanners installed on this machine.";

  constructor(private workspace: WorkspaceInstrument) {}

  tools: ToolSpec[] = [
    {
      name: "safety_scan",
      description: `Run safety checks in the workspace and report findings. Checks: ${CHECKS.map((c) => c.id).join(", ")}. Omit "checks" to run all that apply.`,
      input_schema: {
        type: "object",
        properties: { checks: { type: "string", description: "Comma-separated check ids to run" } },
      },
      permission: "shell",
      risk: "read",
    },
  ];

  async execute(tool: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    if (tool !== "safety_scan") throw new Error(`unknown safety tool ${tool}`);
    const only = typeof input.checks === "string" ? input.checks.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const root = await this.workspace.rootFor(ctx);
    const results = await runSafetyChecks(this.workspace, root, { only });
    const summary = formatResults(results);
    ctx.addEvidence({ kind: "text", label: "safety scan", content: summary });
    const details = results
      .filter((r) => r.output && r.status !== "passed")
      .map((r) => `--- ${r.id} ---\n${truncate(r.output!, 8_000)}`)
      .join("\n\n");
    return {
      text: `${summary}${details ? `\n\n${details}` : ""}`,
      isError: results.some((r) => r.status === "error") || undefined,
    };
  }
}
