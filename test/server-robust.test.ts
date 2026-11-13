import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Architect } from "../src/architect.js";
import { createArchitectServer } from "../src/server.js";
import { ScriptedBrain } from "./helpers.js";

let dir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "architect-robust-"));
  const architect = new Architect({ brain: new ScriptedBrain({} as never, []), instruments: [], dataDir: path.join(dir, "data") });
  server = createArchitectServer({ architect, token: "t" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe("server robustness", () => {
  it("answers 404 for an unknown run's routes and keeps serving", async () => {
    const auth = { authorization: "Bearer t" };
    for (const action of ["", "/events", "/walkthrough"]) {
      const r = await fetch(`${base}/v1/runs/run_00000000000000ff${action}`, { headers: auth });
      expect(r.status, action || "run").toBe(404);
      await r.body?.cancel();
    }
    expect((await fetch(`${base}/v1/runs?limit=1`, { headers: auth })).status).toBe(200);
  });
});
