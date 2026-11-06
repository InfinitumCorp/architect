import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { classifyByLabel, truncate } from "../policy.js";
import type { Instrument, ToolContext, ToolOutput, ToolSpec } from "./types.js";

export interface BrowserInstrumentOptions {
  headless?: boolean;
  /** Playwright storage state file: reuse a signed-in session the user prepared themselves. */
  storageStatePath?: string;
  viewport?: { width: number; height: number };
  /** Hosts the browser may visit. Empty means any host. */
  allowedHosts?: string[];
}

const SNAPSHOT_SCRIPT = () => {
  const selector = [
    "a[href]", "button", "input", "select", "textarea", "summary", "[contenteditable='true']",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]",
    "[role=menuitem]", "[role=option]", "[role=switch]", "[role=combobox]", "[role=textbox]",
  ].join(",");
  const lines: string[] = [];
  let n = 0;
  document.querySelectorAll("[data-architect-ref]").forEach((el) => el.removeAttribute("data-architect-ref"));
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
    if ((el as HTMLInputElement).type === "hidden") continue;
    const ref = `e${++n}`;
    el.setAttribute("data-architect-ref", ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") ?? (tag === "a" ? "link" : tag);
    const input = el as HTMLInputElement;
    const label =
      el.getAttribute("aria-label") ??
      (input.labels && input.labels[0]?.innerText) ??
      el.innerText?.trim() ??
      "";
    const bits = [`[${ref}] ${role}${input.type && tag === "input" ? `:${input.type}` : ""}`];
    const clean = label.replace(/\s+/g, " ").trim().slice(0, 80);
    if (clean) bits.push(JSON.stringify(clean));
    if (input.placeholder) bits.push(`placeholder=${JSON.stringify(input.placeholder)}`);
    if ((tag === "input" || tag === "textarea") && input.type !== "password" && input.value) {
      bits.push(`value=${JSON.stringify(input.value.slice(0, 60))}`);
    }
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      bits.push(`options=${JSON.stringify(Array.from(sel.options).map((o) => o.text).slice(0, 15))}`);
    }
    if (tag === "a") bits.push(`href=${(el as HTMLAnchorElement).getAttribute("href")?.slice(0, 80)}`);
    if ((el as HTMLButtonElement).disabled) bits.push("disabled");
    if (input.checked) bits.push("checked");
    lines.push(bits.join(" "));
    if (n >= 250) break;
  }
  const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
  return { elements: lines, text };
};

/**
 * Visual control of any web interface through Playwright.
 * Elements are addressed by refs from `browser_snapshot`, never by guessed coordinates.
 */
export class BrowserInstrument implements Instrument {
  name = "browser";
  description =
    "A real Chromium browser. Navigate, read pages, click, type, select and take screenshots. Use when a task needs a website or web app that has no direct integration.";
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  constructor(private opts: BrowserInstrumentOptions = {}) {}

  tools: ToolSpec[] = [
    {
      name: "browser_navigate",
      description: "Open a URL in the browser tab. Returns the page title and URL.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      permission: "browser",
      risk: "read",
    },
    {
      name: "browser_snapshot",
      description:
        "List the visible interactive elements with refs like [e12], plus the page's visible text. Call this before clicking or typing, and again after the page changes; refs are only valid for the latest snapshot.",
      input_schema: { type: "object", properties: {} },
      permission: "browser",
      risk: "read",
    },
    {
      name: "browser_click",
      description: "Click an element by ref from the latest snapshot.",
      input_schema: {
        type: "object",
        properties: { ref: { type: "string" }, why: { type: "string", description: "What this click should achieve" } },
        required: ["ref"],
      },
      permission: "browser",
      risk: (input) => this.classifyRef(String(input.ref)),
    },
    {
      name: "browser_type",
      description:
        "Type text into an input by ref. Set submit=true to press Enter afterwards. Password and payment-card fields are refused: those need a person (use request_handoff).",
      input_schema: {
        type: "object",
        properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } },
        required: ["ref", "text"],
      },
      permission: "browser",
      risk: (input) => (input.submit ? "irreversible" : "write"),
    },
    {
      name: "browser_select",
      description: "Choose an option in a <select> by ref, using the option's visible text.",
      input_schema: {
        type: "object",
        properties: { ref: { type: "string" }, option: { type: "string" } },
        required: ["ref", "option"],
      },
      permission: "browser",
      risk: "write",
    },
    {
      name: "browser_press",
      description: "Press a keyboard key such as Enter, Escape, Tab, ArrowDown.",
      input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      permission: "browser",
      risk: (input) => (String(input.key).toLowerCase() === "enter" ? "irreversible" : "write"),
    },
    {
      name: "browser_scroll",
      description: "Scroll the page up or down by about one screen.",
      input_schema: {
        type: "object",
        properties: { direction: { type: "string", enum: ["up", "down"] } },
        required: ["direction"],
      },
      permission: "browser",
      risk: "read",
    },
    {
      name: "browser_back",
      description: "Go back one page in history.",
      input_schema: { type: "object", properties: {} },
      permission: "browser",
      risk: "read",
    },
    {
      name: "browser_wait",
      description: "Wait for text to appear on the page (up to timeout_ms, default 10000), or just wait timeout_ms.",
      input_schema: {
        type: "object",
        properties: { text: { type: "string" }, timeout_ms: { type: "integer" } },
      },
      permission: "browser",
      risk: "read",
    },
    {
      name: "browser_screenshot",
      description: "Take a screenshot of the viewport. It is saved as evidence and shown to you.",
      input_schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] },
      permission: "browser",
      risk: "read",
    },
  ];

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.browser ??= await chromium.launch({ headless: this.opts.headless ?? true });
    const storageState =
      this.opts.storageStatePath && existsSync(this.opts.storageStatePath) ? this.opts.storageStatePath : undefined;
    this.context ??= await this.browser.newContext({
      viewport: this.opts.viewport ?? { width: 1280, height: 860 },
      storageState,
    });
    this.page = await this.context.newPage();
    return this.page;
  }

  private locator(page: Page, ref: string) {
    if (!/^e\d+$/.test(ref)) throw new Error(`"${ref}" is not a snapshot ref; call browser_snapshot first`);
    return page.locator(`[data-architect-ref="${ref}"]`).first();
  }

  private async classifyRef(ref: string) {
    try {
      const page = await this.ensurePage();
      const el = this.locator(page, ref);
      const label = await el.evaluate((node) => {
        const h = node as HTMLInputElement;
        // Classify by what the person sees. (Every plain <button> defaults to type=submit, so the type says little.)
        return [h.getAttribute("aria-label"), h.innerText, h.tagName === "INPUT" ? h.value : ""].filter(Boolean).join(" ");
      }, undefined, { timeout: 2000 });
      return classifyByLabel(label);
    } catch {
      return "write" as const;
    }
  }

  private checkHost(url: string) {
    const allowed = this.opts.allowedHosts ?? [];
    const parsed = new URL(url);
    if (!["http:", "https:", "data:"].includes(parsed.protocol)) throw new Error(`protocol ${parsed.protocol} is not allowed`);
    if (allowed.length && parsed.protocol !== "data:") {
      const ok = allowed.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`));
      if (!ok) throw new Error(`host ${parsed.hostname} is outside this Score's allowed hosts`);
    }
  }

  async execute(tool: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> {
    const page = await this.ensurePage();
    switch (tool) {
      case "browser_navigate": {
        const url = String(input.url);
        this.checkHost(url);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
        ctx.addEvidence({ kind: "url", label: "visited", content: page.url() });
        return { text: `Opened ${page.url()} — "${await page.title()}"` };
      }
      case "browser_snapshot": {
        const snap = await page.evaluate(SNAPSHOT_SCRIPT);
        return {
          text: [
            `URL: ${page.url()}`,
            `Title: ${await page.title()}`,
            "Interactive elements:",
            snap.elements.join("\n") || "(none)",
            "",
            "Visible text:",
            truncate(snap.text, 8_000),
          ].join("\n"),
        };
      }
      case "browser_click": {
        const el = this.locator(page, String(input.ref));
        await el.scrollIntoViewIfNeeded({ timeout: 5_000 });
        await el.click({ timeout: 10_000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        return { text: `Clicked ${input.ref}. Now at ${page.url()}. Take a new snapshot before the next interaction.` };
      }
      case "browser_type": {
        const el = this.locator(page, String(input.ref));
        const sensitive = await el.evaluate((node) => {
          const i = node as HTMLInputElement;
          const hint = `${i.name} ${i.id} ${i.autocomplete} ${i.getAttribute("aria-label") ?? ""}`.toLowerCase();
          return i.type === "password" || /cc-number|card.?number|cvv|cvc|security.?code|ssn/.test(hint);
        });
        if (sensitive) {
          return {
            text: "Refused: this is a password or payment field. Credentials are entered by a person, never by Architect. Use request_handoff.",
            isError: true,
          };
        }
        await el.fill(String(input.text), { timeout: 10_000 });
        if (input.submit) {
          await el.press("Enter");
          await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
        }
        return { text: `Typed into ${input.ref}${input.submit ? " and pressed Enter" : ""}.` };
      }
      case "browser_select": {
        await this.locator(page, String(input.ref)).selectOption({ label: String(input.option) }, { timeout: 10_000 });
        return { text: `Selected "${input.option}" in ${input.ref}.` };
      }
      case "browser_press": {
        await page.keyboard.press(String(input.key));
        return { text: `Pressed ${input.key}.` };
      }
      case "browser_scroll": {
        await page.mouse.wheel(0, input.direction === "up" ? -700 : 700);
        return { text: `Scrolled ${input.direction}.` };
      }
      case "browser_back": {
        await page.goBack({ timeout: 15_000 });
        return { text: `Back at ${page.url()}.` };
      }
      case "browser_wait": {
        const timeout = Number(input.timeout_ms ?? 10_000);
        if (input.text) {
          await page.getByText(String(input.text)).first().waitFor({ timeout });
          return { text: `"${input.text}" is visible.` };
        }
        await page.waitForTimeout(Math.min(timeout, 30_000));
        return { text: `Waited ${timeout}ms.` };
      }
      case "browser_screenshot": {
        const buf = await page.screenshot({ type: "png" });
        const rel = path.join("evidence", `${ctx.stepId}-${Date.now()}.png`);
        await mkdir(path.join(ctx.runDir, "evidence"), { recursive: true });
        await writeFile(path.join(ctx.runDir, rel), buf);
        ctx.addEvidence({ kind: "screenshot", label: String(input.label), path: rel, content: page.url() });
        return { text: `Screenshot saved (${rel}).`, image: { base64: buf.toString("base64"), mediaType: "image/png" } };
      }
      default:
        throw new Error(`unknown browser tool ${tool}`);
    }
  }

  async handoff(ctx: ToolContext): Promise<Record<string, string>> {
    if (!this.context || !this.page) return {};
    const dir = path.join(ctx.runDir, "handoff");
    await mkdir(dir, { recursive: true });
    await this.context.storageState({ path: path.join(dir, "browser-state.json") });
    await this.page.screenshot({ path: path.join(dir, "last-screen.png") });
    return { url: this.page.url(), storageState: "handoff/browser-state.json", screenshot: "handoff/last-screen.png" };
  }

  async dispose() {
    await this.browser?.close().catch(() => {});
    this.browser = this.context = this.page = undefined;
  }
}
