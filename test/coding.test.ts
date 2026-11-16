import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lineDiff, WorkspaceInstrument } from "../src/instruments/workspace.js";
import type { ToolContext } from "../src/instruments/types.js";

let dir: string;
let ws: WorkspaceInstrument;
const evidence: Array<{ label: string; content?: string }> = [];
const ctx = { runId: "run_t", stepId: "s1", runDir: "", putFile: async () => {}, addEvidence: (e: { label: string; content?: string }) => (evidence.push(e), e) } as unknown as ToolContext;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architect-code-"));
  ws = new WorkspaceInstrument(dir, { sandbox: "off" });
  await mkdir(path.join(dir, "src", "lib"), { recursive: true });
  await mkdir(path.join(dir, "node_modules", "dep"), { recursive: true });
  await writeFile(path.join(dir, "src", "app.ts"), "export const a = 1;\nexport function hello() {\n  return 'hi';\n}\n");
  await writeFile(path.join(dir, "src", "lib", "util.ts"), "export const hello = 'util';\n");
  await writeFile(path.join(dir, "node_modules", "dep", "index.js"), "hello from a dependency\n");
  await writeFile(path.join(dir, "AGENTS.md"), "Use tabs. Run npm test before finishing.\n");
  evidence.length = 0;
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("coding tools", () => {
  it("edits by exact unique replacement and records a diff", async () => {
    const out = await ws.execute("workspace_edit", { path: "src/app.ts", old_string: "return 'hi';", new_string: "return 'hello';" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(await readFile(path.join(dir, "src", "app.ts"), "utf8")).toContain("return 'hello';");
    expect(out.text).toContain("-  return 'hi';");
    expect(out.text).toContain("+  return 'hello';");
    expect(evidence[0]!.label).toBe("edited src/app.ts");
  });

  it("refuses missing, ambiguous and no-op edits", async () => {
    expect((await ws.execute("workspace_edit", { path: "src/app.ts", old_string: "nope", new_string: "x" }, ctx)).isError).toBe(true);
    expect((await ws.execute("workspace_edit", { path: "src/app.ts", old_string: "export", new_string: "x" }, ctx)).text).toMatch(/matches 2 places/);
    expect((await ws.execute("workspace_edit", { path: "src/app.ts", old_string: "a", new_string: "a" }, ctx)).isError).toBe(true);
    const all = await ws.execute("workspace_edit", { path: "src/app.ts", old_string: "export", new_string: "export /*x*/", replace_all: true }, ctx);
    expect(all.text).toContain("2 replacements");
    expect((await ws.execute("workspace_edit", { path: "../outside.ts", old_string: "a", new_string: "b" }, ctx).catch((e) => ({ text: String(e), isError: true }))).text).toMatch(/outside the workspace/);
  });

  it("edits and rewrites CRLF files (Windows checkouts) from \\n text, keeping CRLF", async () => {
    const file = path.join(dir, "src", "win.js");
    await writeFile(file, "export function add(a, b) {\r\n  return a - b;\r\n}\r\n");
    const out = await ws.execute("workspace_edit", { path: "src/win.js", old_string: "export function add(a, b) {\n  return a - b;\n}", new_string: "export function add(a, b) {\n  return a + b;\n}" }, ctx);
    expect(out.isError).toBeFalsy();
    expect(await readFile(file, "utf8")).toBe("export function add(a, b) {\r\n  return a + b;\r\n}\r\n");
    expect(out.text).toContain("+  return a + b;");

    await ws.execute("workspace_write", { path: "src/win.js", content: "export const x = 1;\nexport const y = 2;\n" }, ctx);
    expect(await readFile(file, "utf8")).toBe("export const x = 1;\r\nexport const y = 2;\r\n");
    // A new or LF file is written as given.
    await ws.execute("workspace_write", { path: "src/new.js", content: "a\nb\n" }, ctx);
    expect(await readFile(path.join(dir, "src", "new.js"), "utf8")).toBe("a\nb\n");
  });

  it("searches and globs without dependency folders", async () => {
    const hits = await ws.execute("workspace_search", { pattern: "hello" }, ctx);
    expect(hits.text).toContain("src/app.ts:2:");
    expect(hits.text).toContain("src/lib/util.ts:1:");
    expect(hits.text).not.toContain("node_modules");
    expect((await ws.execute("workspace_search", { pattern: "HELLO", ignore_case: true, glob: "**/util.ts" }, ctx)).text).toBe("src/lib/util.ts:1: export const hello = 'util';");
    expect((await ws.execute("workspace_search", { pattern: "(" }, ctx)).isError).toBe(true);
    expect((await ws.execute("workspace_glob", { pattern: "**/*.ts" }, ctx)).text).toBe("src/app.ts\nsrc/lib/util.ts");
  });

  it("reads project rule files for the prompts", async () => {
    expect(await ws.rules()).toContain("--- AGENTS.md ---\nUse tabs.");
  });

  it("makes a compact diff", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\n", "f.txt")).toBe("--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n a\n-b\n+B\n c\n ");
  });
});
