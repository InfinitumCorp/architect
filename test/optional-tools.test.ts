import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EXCLUDED_TOOLS, riskFor } from "../src/instruments/playwright-mcp.js";
import { DocumentsInstrument } from "../src/instruments/documents.js";
import { SafetyInstrument } from "../src/instruments/safety.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import { hasAgentExtensions, runSafetyChecks } from "../src/safety/scanners.js";
import type { CommandSandbox } from "../src/sandbox/runtime.js";
import type { ToolContext } from "../src/instruments/types.js";

const evidence: { label: string; content?: string }[] = [];
const ctx = {
  runId: "r",
  stepId: "s",
  runDir: ".",
  putFile: async () => {},
  addEvidence: (e: { label: string; content?: string }) => (evidence.push(e), {}),
} as unknown as ToolContext;

/** A sandbox that records commands and answers them from a table instead of running them. */
function fakeSandbox(answers: Record<string, string>): CommandSandbox & { seen: { cmd: string; hosts?: string[] }[] } {
  const seen: { cmd: string; hosts?: string[] }[] = [];
  return {
    name: "fake",
    isolating: true,
    seen,
    async wrap(cmd, { limits }) {
      seen.push({ cmd, hosts: limits?.allowedDomains });
      const key = Object.keys(answers).find((k) => cmd.startsWith(k));
      const script = key === undefined ? "process.exit(127)" : answers[key]!;
      return { command: `node -e "${script}"`, env: {}, done: () => {} };
    },
    async dispose() {},
  };
}

const node = (code: number, out = "") => `process.stdout.write(${JSON.stringify(out).replace(/"/g, "'")});process.exit(${code})`;

describe("Playwright MCP backend", () => {
  const tool = (name: string, annotations = {}) => ({ name, annotations });

  it("never offers page scripts, host files or browser installs", () => {
    for (const t of ["browser_evaluate", "browser_run_code_unsafe", "browser_file_upload", "browser_drop", "browser_install"]) {
      expect(EXCLUDED_TOOLS.has(t), t).toBe(true);
    }
  });

  it("takes risk from what is acted on, not from destructiveHint", () => {
    expect(riskFor(tool("browser_snapshot", { readOnlyHint: true }), {})).toBe("read");
    expect(riskFor(tool("browser_navigate", { destructiveHint: true }), { url: "https://example.com" })).toBe("read");
    expect(riskFor(tool("browser_click", { destructiveHint: true }), { element: "Next page link" })).not.toBe("irreversible");
    expect(riskFor(tool("browser_click"), { element: "Place order button" })).toBe("irreversible");
    expect(riskFor(tool("browser_type"), { element: "Password field", text: "x" })).toBe("irreversible");
    expect(riskFor(tool("browser_fill_form"), { fields: [{ name: "Card number" }] })).toBe("irreversible");
  });
});

describe("documents (markitdown)", () => {
  it("explains how to install markitdown when it is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arch-docs-"));
    await writeFile(path.join(root, "a.pdf"), "x");
    const ws = new WorkspaceInstrument(root, { sandbox: fakeSandbox({}) });
    const out = await new DocumentsInstrument(ws).execute("document_to_markdown", { path: "a.pdf" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/markitdown/);
  });

  it("refuses files outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arch-docs-"));
    const ws = new WorkspaceInstrument(root, { sandbox: fakeSandbox({}) });
    await expect(new DocumentsInstrument(ws).execute("document_to_markdown", { path: "../x.pdf" }, ctx)).rejects.toThrow(/outside/);
  });
});

describe("safety checks", () => {
  it("skips scanners that are not installed and says how to install them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arch-scan-"));
    const ws = new WorkspaceInstrument(root, { sandbox: fakeSandbox({}) });
    const results = await runSafetyChecks(ws, root, { env: {} });
    const osv = results.find((r) => r.id === "osv-scanner")!;
    expect(osv.status).toBe("skipped");
    expect(osv.install).toMatch(/osv-scanner/);
    expect(results.find((r) => r.id === "git-secrets")!.summary).toMatch(/not a git repository/);
    expect(results.find((r) => r.id === "garak")!.summary).toMatch(/ARCHITECT_GARAK_ARGS/);
  });

  it("reports findings and limits each scanner to its own hosts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arch-scan-"));
    const sandbox = fakeSandbox({
      "osv-scanner --version": node(0),
      "osv-scanner scan": node(1, "GHSA-xxxx lodash"),
    });
    const ws = new WorkspaceInstrument(root, { sandbox });
    const [osv] = await runSafetyChecks(ws, root, { only: ["osv-scanner"], env: {} });
    expect(osv!.status).toBe("findings");
    expect(osv!.output).toMatch(/GHSA/);
    expect(sandbox.seen.find((s) => s.cmd.startsWith("osv-scanner scan"))!.hosts).toContain("api.osv.dev");
    expect(sandbox.seen.find((s) => s.cmd.startsWith("osv-scanner --version"))!.hosts).toEqual([]);
  });

  it("runs SkillSpector only on projects with agent skills or plugins", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arch-scan-"));
    expect(await hasAgentExtensions(root)).toBe(false);
    await mkdir(path.join(root, "pkg", "skills", "x"), { recursive: true });
    await writeFile(path.join(root, "pkg", "skills", "x", "SKILL.md"), "---\nname: x\n---");
    expect(await hasAgentExtensions(root)).toBe(true);
  });

  it("is offered to the model as a read-only tool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "arch-scan-"));
    const ws = new WorkspaceInstrument(root, { sandbox: fakeSandbox({}) });
    const safety = new SafetyInstrument(ws);
    expect(safety.tools[0]!.risk).toBe("read");
    const out = await safety.execute("safety_scan", { checks: "osv-scanner" }, ctx);
    expect(out.text).toMatch(/not installed/);
  });
});
