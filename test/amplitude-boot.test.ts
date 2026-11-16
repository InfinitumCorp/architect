import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const boot = readFileSync(path.join(__dirname, "..", "web", "amplitude-boot.js"), "utf8");

/** Runs web/amplitude-boot.js with a given user agent and returns the init calls. */
function run(userAgent: string): string[][] {
  const init = vi.fn();
  new Function("initInfinitumAmplitude", "navigator", boot)(init, { userAgent });
  return init.mock.calls as string[][];
}

describe("web Amplitude boot", () => {
  it("starts the Browser SDK with the public key in a browser", () => {
    expect(run("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36")).toEqual([["756c0bc80c5cb27386bfd7b2b13196c8"]]);
  });

  it("stays off inside the Android app, which counts with the native SDK", () => {
    expect(run("Mozilla/5.0 (Linux; Android 15; wv) Chrome/140.0 Mobile Safari/537.36 ArchitectShell/android")).toEqual([]);
  });

  it("still runs in the desktop app, which has no native SDK", () => {
    expect(run("Mozilla/5.0 Electron/38.0 ArchitectShell/desktop")).toHaveLength(1);
  });
});
