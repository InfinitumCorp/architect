/**
 * Optional browser backend: Microsoft's Playwright MCP server (`@playwright/mcp`, Apache-2.0),
 * driven over stdio with the MCP client SDK Architect already depends on.
 *
 * It is an alternative to `BrowserInstrument`, not a replacement: the Cloudflare Worker edition
 * keeps using `BrowserInstrument` with Browser Rendering. See docs/playwright-mcp.md for the
 * evaluation. The package is an optional peer dependency: install it with
 * `npm install @playwright/mcp@0.0.84` to use this backend. Nothing is downloaded at run time.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { classifyByLabel, truncate } from "../policy.js";
import type { Risk } from "../types.js";
import type { Instrument, JsonSchemaObject, ToolContext, ToolOutput, ToolSpec } from "./types.js";

export interface PlaywrightMcpOptions {
  headless?: boolean;
  /** Hosts the browser may visit. Empty means any host. */
  allowedHosts?: string[];
  /** Playwright storage state to reuse a session a person signed in to themselves. */
  storageStatePath?: string;
  /** Run the server some other way (tests, a custom build). Defaults to the installed package. */
  command?: string;
  args?: string[];
}

/** Tools never offered to the model: arbitrary page scripts, host file access, browser installs. */
export const EXCLUDED_TOOLS = new Set(["browser_evaluate", "browser_run_code", "browser_file_upload", "browser_install", "browser_pdf_save"]);

/** Fields whose label means a person should type the value, not the model. */
const SENSITIVE_FIELD = /\b(password|passcode|pin|card number|credit card|cvv|cvc|security code|ssn|social security|iban|routing)\b/i;

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Risk of one Playwright MCP tool call, from the server's hints and the element being acted on. */
export function riskFor(tool: McpTool, input: Record<string, unknown>): Risk {
  if (tool.annotations?.readOnlyHint) return "read";
  if (tool.name === "browser_navigate" || tool.name === "browser_navigate_back" || tool.name === "browser_tabs") return "read";
  const label = [input.element, input.text, input.key, input.values, input.fields].map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))).join(" ");
  if (SENSITIVE_FIELD.test(label)) return "irreversible";
  if (tool.annotations?.destructiveHint && !/click|type|select|press|hover|fill|drag|wait|resize|dialog/.test(tool.name)) return "irreversible";
  return classifyByLabel(label);
}

/** Resolve the installed @playwright/mcp CLI, or explain how to install it. */
export function resolvePlaywrightMcp(): { command: string; args: string[] } {
  const require = createRequire(import.meta.url);
  try {
    const pkg = require.resolve("@playwright/mcp/package.json");
    return { command: process.execPath, args: [path.join(path.dirname(pkg), "cli.js")] };
  } catch {
    throw new Error("The Playwright MCP backend needs @playwright/mcp: npm install @playwright/mcp@0.0.84");
  }
}

function hostAllowed(url: string, hosts: string[]): boolean {
  if (!hosts.length) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => host === h.toLowerCase() || host.endsWith(`.${h.toLowerCase()}`));
}

export class PlaywrightMcpInstrument implements Instrument {
  name = "browser";
  description =
    "A real Chromium browser driven through Playwright MCP. Navigate, read accessibility snapshots, click, type, select and take screenshots. Use when a task needs a website or web app that has no direct integration.";
  tools: ToolSpec[];

  private constructor(
    private client: Client,
    private mcpTools: Map<string, McpTool>,
    private opts: PlaywrightMcpOptions,
  ) {
    this.tools = [...mcpTools.values()].map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      input_schema: {
        type: "object",
        properties: (t.inputSchema?.properties ?? {}) as Record<string, unknown>,
        required: t.inputSchema?.required,
      } satisfies JsonSchemaObject,
      permission: "browser",
      risk: (input: Record<string, unknown>) => riskFor(t, input),
    }));
  }

  /** Start the server and read its tool list. Call `dispose()` when done. */
  static async start(opts: PlaywrightMcpOptions = {}): Promise<PlaywrightMcpInstrument> {
    const base = opts.command ? { command: opts.command, args: opts.args ?? [] } : resolvePlaywrightMcp();
    const args = [...base.args, "--isolated"];
    if (opts.headless !== false) args.push("--headless");
    if (opts.storageStatePath) args.push("--storage-state", opts.storageStatePath);
    if (opts.allowedHosts?.length) {
      args.push("--allowed-origins", opts.allowedHosts.flatMap((h) => [`https://${h}`, `http://${h}`]).join(";"));
    }
    const transport = new StdioClientTransport({ command: base.command, args, stderr: "ignore" });
    const client = new Client({ name: "architect", version: "0.1.0" });
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = new Map<string, McpTool>();
    for (const t of listed.tools as McpTool[]) if (!EXCLUDED_TOOLS.has(t.name)) tools.set(t.name, t);
    return new PlaywrightMcpInstrument(client, tools, opts);
  }

  async execute(tool: string, input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolOutput> {
    if (!this.mcpTools.has(tool)) throw new Error(`unknown browser tool ${tool}`);
    if (tool === "browser_navigate" && !hostAllowed(String(input.url), this.opts.allowedHosts ?? [])) {
      return { text: `Navigation to ${String(input.url)} is outside the allowed hosts.`, isError: true };
    }
    const result = (await this.client.callTool({ name: tool, arguments: input })) as {
      content?: { type: string; text?: string; data?: string; mimeType?: string }[];
      isError?: boolean;
    };
    const texts: string[] = [];
    let image: ToolOutput["image"];
    for (const c of result.content ?? []) {
      if (c.type === "text" && c.text) texts.push(c.text);
      else if (c.type === "image" && c.data && !image && (c.mimeType === "image/png" || c.mimeType === "image/jpeg")) {
        image = { base64: c.data, mediaType: c.mimeType };
      }
    }
    return { text: truncate(texts.join("\n"), 40_000) || "(no output)", image, isError: result.isError || undefined };
  }

  async dispose() {
    await this.client.close().catch(() => {});
  }
}
