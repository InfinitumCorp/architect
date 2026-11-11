import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installOpenClaw, installSkill, mcpAddArgs, OPENCLAW_SKILL, printableMcpAdd, skillDir } from "../src/openclaw-skill.js";

let dir: string;
beforeAll(async () => (dir = await mkdtemp(path.join(tmpdir(), "architect-openclaw-"))));
afterAll(() => rm(dir, { recursive: true, force: true }));

const reg = { cli: "/opt/architect/dist/cli.js", url: "http://localhost:7337", node: "/usr/bin/node" };

describe("OpenClaw skill", () => {
  it("has the frontmatter OpenClaw requires and valid openclaw metadata", () => {
    const front = OPENCLAW_SKILL.match(/^---\n([\s\S]*?)\n---\n/)![1]!;
    expect(front).toMatch(/^name: architect$/m);
    expect(front).toMatch(/^description: .*coding agent/m);
    const meta = front.split("metadata:\n")[1]!.trim();
    // OpenClaw reads metadata as JSON5; plain JSON is a subset.
    expect(JSON.parse(meta).openclaw.emoji).toBeTruthy();
    // It names every tool the MCP server offers and tells the assistant never to approve.
    for (const t of ["architect_run", "architect_get_run", "architect_list_runs", "architect_pending_approvals", "architect_recover", "architect_cancel"]) {
      expect(OPENCLAW_SKILL).toContain(t);
    }
    expect(OPENCLAW_SKILL).toMatch(/Never try to approve it yourself/);
  });

  it("installs into the shared skills folder or a workspace", async () => {
    const shared = await installSkill({ home: path.join(dir, ".openclaw") });
    expect(shared).toBe(path.join(dir, ".openclaw", "skills", "architect", "SKILL.md"));
    expect(await readFile(shared, "utf8")).toBe(OPENCLAW_SKILL);
    expect(skillDir({ workspace: path.join(dir, "ws") })).toBe(path.join(dir, "ws", "skills", "architect"));
  });
});

describe("OpenClaw MCP registration", () => {
  it("builds the openclaw mcp add command and never prints the token", () => {
    expect(mcpAddArgs(reg)).toEqual(["mcp", "add", "architect", "--command", "/usr/bin/node", "--arg", "/opt/architect/dist/cli.js", "--arg", "mcp", "--env", "ARCHITECT_URL=http://localhost:7337"]);
    expect(mcpAddArgs({ ...reg, token: "s3cret" })).toContain("ARCHITECT_API_TOKEN=s3cret");
    const shown = printableMcpAdd({ ...reg, token: "s3cret" });
    expect(shown).not.toContain("s3cret");
    expect(shown).toContain("ARCHITECT_API_TOKEN=<your ARCHITECT_API_TOKEN>");
    expect(printableMcpAdd({ ...reg, node: "C:\\Program Files\\nodejs\\node.exe" })).toContain('--command "C:\\Program Files\\nodejs\\node.exe" --arg');
  });

  it("registers when openclaw is installed, and explains when it is not or it fails", async () => {
    const home = path.join(dir, "home2");
    const calls: string[][] = [];
    const ok = await installOpenClaw({ ...reg, home }, (cmd, args) => (calls.push([cmd, ...args]), { status: 0 }));
    expect(ok.mcp.status).toBe("added");
    expect(calls[0]!.slice(0, 4)).toEqual(["openclaw", "mcp", "add", "architect"]);

    const missing = await installOpenClaw({ ...reg, home }, () => ({ status: null, error: Object.assign(new Error("spawn openclaw ENOENT"), { code: "ENOENT" }) }));
    expect(missing.mcp).toMatchObject({ status: "no-openclaw", command: expect.stringContaining("openclaw mcp add architect") });

    const busy = await installOpenClaw({ ...reg, home, token: "s3cret" }, () => ({ status: 1, stderr: "Gateway is running; stop it first (env ARCHITECT_API_TOKEN=s3cret)" }));
    expect(busy.mcp.status).toBe("failed");
    expect(busy.mcp.detail).toContain("Gateway is running");
    expect(JSON.stringify(busy)).not.toContain("s3cret");
  });
});
