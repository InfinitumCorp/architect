import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stepInstruments } from "../src/architect.js";
import { ignoreDataDir, MODES } from "../src/chat.js";

describe("coding session", () => {
  it("never leaves a composed step without tools", () => {
    const installed = new Set(["workspace", "repo", "browser"]);
    expect(stepInstruments([], installed)).toEqual(["workspace"]);
    expect(stepInstruments(["shell", "files"], installed)).toEqual(["workspace"]);
    expect(stepInstruments(["github", "browser"], installed)).toEqual(["repo", "browser"]);
    expect(stepInstruments(["nope"], new Set(["browser"]))).toEqual([]);
  });

  it("keeps Architect's data out of the project's git, without overwriting", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "architect-session-"));
    try {
      await ignoreDataDir(path.join(dir, ".architect"));
      expect(await readFile(path.join(dir, ".architect", ".gitignore"), "utf8")).toBe("*\n");
      await writeFile(path.join(dir, ".architect", ".gitignore"), "custom\n");
      await ignoreDataDir(path.join(dir, ".architect"));
      expect(await readFile(path.join(dir, ".architect", ".gitignore"), "utf8")).toBe("custom\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps modes to autonomy and review", () => {
    expect(MODES.plan).toMatchObject({ autonomy: "accompaniment", review: "request_review" });
    expect(MODES.auto).toMatchObject({ autonomy: "autopilot", review: "always_proceed" });
    expect(MODES.rehearse.autonomy).toBe("rehearsal");
  });
});
