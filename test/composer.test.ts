import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Architect, validImages } from "../src/architect.js";
import type { Brain, TurnRequest } from "../src/brain.js";
import { RouterBrain } from "../src/brains/router.js";
import { WorkspaceInstrument } from "../src/instruments/workspace.js";
import { expandMentions, findFiles, MENTION_MARK, mentionedPaths, runShell } from "../src/mentions.js";
import { createArchitectServer } from "../src/server.js";
import { ScriptedBrain, toolUse } from "./helpers.js";

const DRAFT = {
  summary: "Look at the screenshot",
  permissions: ["workspace.read" as const],
  startUrl: null,
  steps: [{ title: "Look", instruction: "look", instruments: ["workspace"], checkpoint: false }],
  successCriteria: ["looked"],
};
const PNG = "iVBORw0KGgo="; // a PNG signature is enough here

function named(model: string, calls: string[]): Brain {
  return {
    model,
    async compose() {
      calls.push(model);
      return { draft: DRAFT };
    },
    async turn() {
      calls.push(model);
      return { content: [], stop_reason: "end_turn" };
    },
  };
}

describe("model picker", () => {
  it("offers auto, tiers and models, and pins a person's choice", async () => {
    const calls: string[] = [];
    const r = new RouterBrain([
      { id: "local/fast", tier: "fast", brain: named("fast-model", calls) },
      { id: "local/strong", tier: "strong", brain: named("strong-model", calls) },
      { id: "cloud/strong", tier: "strong", cost: 5, brain: named("cloud-model", calls) },
    ]);
    expect(r.choices().map((c) => c.id)).toEqual(["auto", "fast", "strong", "local/fast", "local/strong", "cloud/strong"]);
    const req: TurnRequest = { system: "s", messages: [{ role: "user", content: "go" }], tools: [] };

    await r.pinned("cloud/strong").turn(req); // a model: tried first even though it costs more
    await r.pinned("fast").compose("s", "p"); // a tier: planning too runs at that tier
    await r.compose("s", "p"); // the router itself is unchanged
    expect(calls).toEqual(["cloud-model", "fast-model", "strong-model"]);
    expect(() => r.pinned("nope")).toThrow(/unknown model/);
    expect(r.pinned("auto")).toBe(r);
  });
});

describe("image attachments", () => {
  it("accepts a few known images and refuses the rest", () => {
    expect(validImages(undefined)).toEqual([]);
    expect(validImages([{ mediaType: "image/png", base64: `data:image/png;base64,${PNG}` }])).toEqual([{ mediaType: "image/png", base64: PNG }]);
    expect(() => validImages([{ mediaType: "image/svg+xml", base64: PNG }])).toThrow(/PNG, JPEG/);
    expect(() => validImages([{ mediaType: "image/png", base64: "not base64!" }])).toThrow(/not base64/);
    expect(() => validImages(Array(5).fill({ mediaType: "image/png", base64: PNG }))).toThrow(/at most 4/);
  });
});

describe("@-mentions and ! commands", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "architect-mentions-"));
    await mkdir(path.join(root, "src", "ui"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(root, "src", "ui", "Button.tsx"), "export const Button = 1;\n");
    await writeFile(path.join(root, "src", "app.ts"), "import './ui/Button';\n");
    await writeFile(path.join(root, "README.md"), "# Demo\n");
    await writeFile(path.join(root, "node_modules", "x", "button.js"), "ignored");
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("finds files by name, skipping dependency folders", async () => {
    expect(await findFiles(root, "butt")).toEqual(["src/ui/Button.tsx"]);
    expect(await findFiles(root, "src/")).toEqual(["src/app.ts", "src/ui/Button.tsx"]);
  });

  it("attaches the mentioned files and ignores paths outside the project", async () => {
    expect(mentionedPaths("fix @src/app.ts and @./README.md, mail me@x.com")).toEqual(["src/app.ts", "README.md"]);
    const goal = await expandMentions("Rename the export in @src/ui/Button.tsx, see @src/ui and @../secret", root);
    const [own, files] = goal.split(MENTION_MARK);
    expect(own).toBe("Rename the export in @src/ui/Button.tsx, see @src/ui and @../secret");
    expect(files).toContain("export const Button = 1;");
    expect(files).toContain("@src/ui (folder):\nsrc/ui/Button.tsx");
    expect(files).not.toContain("secret");
    expect(await expandMentions("nothing here", root)).toBe("nothing here");
  });

  it("runs a command in the project", async () => {
    const r = await runShell('node -e "console.log(process.cwd())"', root);
    expect(r.code).toBe(0);
    expect(path.resolve(r.output.trim()).toLowerCase()).toBe(path.resolve(root).toLowerCase());
    expect((await runShell('node -e "process.exit(3)"', root)).code).toBe(3);
  });
});

describe("composer endpoints", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let brain: ScriptedBrain;
  let architect: Architect;
  const call = (p: string, init: RequestInit = {}) =>
    fetch(`${base}${p}`, { ...init, headers: { authorization: "Bearer t", "content-type": "application/json" } });

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "architect-composer-"));
    const ws = new WorkspaceInstrument(path.join(dir, "ws"));
    await mkdir(ws.root, { recursive: true });
    await writeFile(path.join(ws.root, "index.html"), "<h1>hi</h1>");
    brain = new ScriptedBrain(DRAFT, [
      () => [toolUse("step_complete", { summary: "looked" })],
      () => [toolUse("submit_verdict", { passed: true, summary: "ok", criteria: [{ criterion: "looked", met: true, evidence: "x" }] })],
    ]);
    architect = new Architect({ brain, instruments: [ws], dataDir: path.join(dir, "data") });
    server = createArchitectServer({ architect, token: "t" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("lists models, files and offers ! commands from this computer", async () => {
    expect(await (await call("/v1/models")).json()).toEqual({
      default: "auto",
      options: [{ id: "auto", label: "claude-opus-5-5" }],
      files: true,
      shell: true,
      labyrinth: false,
    });
    expect(await (await call("/v1/files?q=ind")).json()).toEqual({ files: ["index.html"] });
    const out = (await (await call("/v1/shell", { method: "POST", body: JSON.stringify({ command: "node -e \"console.log('ok')\"" }) })).json()) as { code: number; output: string };
    expect(out).toMatchObject({ code: 0, output: "ok\n" });
    expect((await call("/v1/shell", { method: "POST", body: "{}" })).status).toBe(400);
  });

  it("starts a run with a mention and an image; the first step sees the image", async () => {
    const bad = await call("/v1/runs", { method: "POST", body: JSON.stringify({ goal: "x", model: "gpt-nope" }) });
    expect(bad.status).toBe(400);
    const res = await call("/v1/runs", {
      method: "POST",
      body: JSON.stringify({ goal: "/fast Match @index.html to the screenshot", autonomy: "autopilot", images: [{ mediaType: "image/png", base64: PNG }] }),
    });
    expect(res.status).toBe(202);
    const run = (await res.json()) as { id: string; score: { goal: string }; attachments: unknown };
    expect(run.score.goal).toContain(`${MENTION_MARK}@index.html:`);
    expect(run.attachments).toEqual([{ file: "attachments/image-1.png", mediaType: "image/png" }]);
    for (let i = 0; i < 50 && (await architect.store.load(run.id)).status !== "succeeded"; i++) await new Promise((r) => setTimeout(r, 50));
    const first = brain.requests[0]!.messages[0]!.content as Array<{ type: string; source?: { data: string } }>;
    expect(first.map((b) => b.type)).toEqual(["text", "image"]);
    expect(first[1]!.source!.data).toBe(PNG);
  });
});
