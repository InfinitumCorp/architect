import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpInstrument, isBlockedAddress } from "../src/instruments/http.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import type { ToolContext } from "../src/instruments/types.js";

const ctx = { runId: "r", stepId: "s", runDir: ".", addEvidence: () => ({}) } as unknown as ToolContext;

describe("public HTTP", () => {
  it("treats loopback, private, and link-local addresses as blocked", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.5", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
    expect(isBlockedAddress("1.1.1.1")).toBe(false);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
  });

  it("refuses private, local, and credentialed URLs before connecting", async () => {
    const http = new HttpInstrument();
    await expect(http.execute("http_get", { url: "http://127.0.0.1/" })).rejects.toThrow(/not allowed/);
    await expect(http.execute("http_get", { url: "http://169.254.169.254/latest/meta-data" })).rejects.toThrow(/not allowed/);
    await expect(http.execute("http_get", { url: "http://localhost/health" })).rejects.toThrow(/not allowed/);
    await expect(http.execute("http_get", { url: "http://user:secret@example.com/" })).rejects.toThrow(/credentials/);
    await expect(http.execute("http_get", { url: "file:///etc/passwd" })).rejects.toThrow(/http/);
  });
});

describe("workspace confinement", () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes a dotted name and refuses a symlink that leaves the workspace", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "cndctr-safe-"));
    const root = path.join(dir, "ws");
    await mkdir(root);
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(root, "escape"));
    const ws = new WorkspaceInstrument(root);

    await ws.execute("workspace_write", { path: "..notes.txt", content: "kept" }, ctx);
    expect(await readFile(path.join(root, "..notes.txt"), "utf8")).toBe("kept");

    await expect(ws.execute("workspace_write", { path: "escape/pwned.txt", content: "no" }, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(ws.execute("workspace_read", { path: "../outside" }, ctx)).rejects.toThrow(/outside the workspace/);
    await expect(readFile(path.join(outside, "pwned.txt"), "utf8")).rejects.toThrow();
  });
});
