#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import path from "node:path";
import { createArchitect } from "./index.js";
import { createArchitectServer } from "./server.js";
import { readFile } from "node:fs/promises";
import { TriggerRouter } from "./triggers.js";
import { ScoreLibrary } from "./library.js";
import { ScheduleStore, Scheduler, validateSchedule } from "./schedules.js";
import { RouterBrain } from "./brains/router.js";
import { OpenAICompatBrain } from "./brains/openai.js";
import { PERMISSIONS, type ApprovalHandler, type Autonomy, type Permission, type Run, type RunEvent } from "./types.js";

const HELP = `:\\ARCHITECT\\ — intent in, outcome out.

Usage
  architct run "<goal>" [options]     Compose a Score, perform it, verify the result
  architct compose "<goal>" [opts]    Compose and print the Score without performing it
  architct recover <runId>            Resume a failed or handed-off run
  architct encore <runId> -i k=v ...  Rerun a Score with new inputs
  architct runs                       List recent runs
  architct show <runId>               Print a run as JSON
  architct serve [--port 7337]        Start the API, triggers, schedules and the Podium
  architct models                     Show the automatic model routing table and check each model
  architct mcp                        MCP server (stdio) for Claude Code, Cursor and other agents;
                                      talks to \`serve\` at ARCHITCT_URL. Approvals stay with people.

Saved Scores (reusable workflows)
  architct save <runId> <name>        Save a run's Score to the library
  architct scores                     List saved Scores
  architct play <name> -i k=v ...     Perform a saved Score with inputs
  architct export <name>              Print a Marketplace package (JSON) for a saved Score
  architct import <file.json>         Install a Score package

Autopilot schedules (run by \`serve\`)
  architct schedule add <name> --score <saved> (--every <min> | --daily HH:MM) [-i k=v] [--budget usd]
  architct schedule list
  architct schedule remove <name>

Options
  -a, --autonomy <level>     rehearsal | accompaniment (default) | autopilot
  -u, --url <url>            Start URL for the browser
  -i, --input k=v            Score input (repeatable)
  -p, --permit <perm>        Limit permissions (repeatable): ${PERMISSIONS.join(", ")}
  -w, --workspace <dir>      Folder Architect may build in (default: .architct/workspace)
      --headed               Show the browser window
      --state <file>         Playwright storage state to reuse a session you signed in to yourself
      --allow-host <host>    Restrict the browser to these hosts (repeatable)
  -b, --budget <usd>         Spending limit for the run; it hands off instead of going over
      --data <dir>           Data directory (default: .architct)
      --json                 Print the final run as JSON

Environment
  ANTHROPIC_API_KEY    (or an \`ant auth login\` profile)
  ARCHITCT_MODEL         default claude-opus-5-5     ARCHITCT_EFFORT  default high
  ARCHITCT_API_TOKEN     bearer token for \`serve\`    ARCHITCT_PRODUCT_<KEY>_URL / _TOKEN  ecosystem products`;

const C = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", off: "\x1b[0m" };

function printEvent(ev: RunEvent) {
  const d = ev.data;
  switch (ev.type) {
    case "run.composed": {
      const score = d.score as Run["score"];
      console.log(`\n${C.bold}Score${C.off} ${score.summary}`);
      score.steps.forEach((s, i) => console.log(`  ${i + 1}. ${s.title}${s.checkpoint ? `${C.yellow} [checkpoint]${C.off}` : ""}`));
      console.log(`${C.dim}  permissions: ${score.permissions.join(", ")}${C.off}`);
      console.log(`${C.dim}  done when: ${score.successCriteria.join(" · ")}${C.off}`);
      const est = d.estimate as { lowUsd: number; highUsd: number } | undefined;
      if (est) {
        const limit = d.budgetUsd ? ` · limit $${Number(d.budgetUsd).toFixed(2)}` : " · no limit (set one with --budget)";
        console.log(`${C.dim}  estimate: $${est.lowUsd.toFixed(2)}–$${est.highUsd.toFixed(2)}${limit}${C.off}`);
      }
      console.log();
      break;
    }
    case "step.started":
      console.log(`${C.cyan}▶ ${d.title}${C.off}`);
      break;
    case "step.completed":
      console.log(`${C.green}✓ ${d.summary}${C.off}`);
      break;
    case "step.failed":
      console.log(`${C.red}✗ ${d.reason}${C.off}`);
      break;
    case "action": {
      const mark = { executed: "·", simulated: "◌", denied: "⊘", error: "!", blocked: "⊘" }[String(d.outcome)] ?? "·";
      const input = JSON.stringify(d.input);
      console.log(`${C.dim}  ${mark} ${d.tool} ${input.length > 100 ? `${input.slice(0, 100)}…` : input}${C.off}`);
      break;
    }
    case "architct.note":
      console.log(`${C.dim}  ${String(d.text).split("\n")[0]?.slice(0, 160)}${C.off}`);
      break;
    case "run.verified":
      console.log(`\n${d.passed ? C.green : C.red}${C.bold}${d.passed ? "VERIFIED" : "NOT VERIFIED"}${C.off} ${d.summary}`);
      for (const c of (d.criteria as { criterion: string; met: boolean; evidence: string }[]) ?? []) {
        console.log(`  ${c.met ? "✓" : "✗"} ${c.criterion} ${C.dim}— ${c.evidence}${C.off}`);
      }
      break;
    case "run.handed_off":
      console.log(`\n${C.yellow}Handed off:${C.off} ${d.reason}\n${d.instructions ?? ""}`);
      break;
  }
}

function cliApprovals(): ApprovalHandler {
  return async (req) => {
    if (!process.stdin.isTTY) return { approved: false, note: "no interactive terminal to approve", by: "cli" };
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const what = req.kind === "checkpoint" ? req.reason : `${req.tool} ${JSON.stringify(req.input)}\n  (${req.reason})`;
    const answer = await rl.question(`\n${C.yellow}${C.bold}Approve?${C.off} ${what}\n[y/N/note] `);
    rl.close();
    const approved = /^y(es)?$/i.test(answer.trim());
    return { approved, note: approved || !answer.trim() || /^no?$/i.test(answer.trim()) ? undefined : answer.trim(), by: "cli" };
  };
}

async function main() {
  // Pick up ANTHROPIC_API_KEY and ARCHITCT_* from a local .env (gitignored). Real env vars win.
  try {
    process.loadEnvFile(".env");
  } catch {
    /* no .env */
  }
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      autonomy: { type: "string", short: "a" },
      url: { type: "string", short: "u" },
      input: { type: "string", short: "i", multiple: true },
      permit: { type: "string", short: "p", multiple: true },
      workspace: { type: "string", short: "w" },
      headed: { type: "boolean" },
      state: { type: "string" },
      "allow-host": { type: "string", multiple: true },
      data: { type: "string" },
      port: { type: "string" },
      json: { type: "boolean" },
      budget: { type: "string", short: "b" },
      score: { type: "string" },
      every: { type: "string" },
      daily: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  if (command === "mcp") {
    // stdout carries the MCP protocol: nothing else may print there.
    const { createMcpServer } = await import("./mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    await createMcpServer().connect(new StdioServerTransport());
    return;
  }

  const inputs = Object.fromEntries(
    (values.input ?? []).map((kv) => {
      const i = kv.indexOf("=");
      if (i < 1) throw new Error(`--input must be key=value, got "${kv}"`);
      return [kv.slice(0, i), kv.slice(i + 1)];
    }),
  );
  const permit = values.permit?.filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p));
  const autonomy = (values.autonomy ?? "accompaniment") as Autonomy;
  if (!["rehearsal", "accompaniment", "autopilot"].includes(autonomy)) throw new Error(`unknown autonomy "${autonomy}"`);

  const budgetUsd = values.budget !== undefined ? Number(values.budget) : undefined;
  if (budgetUsd !== undefined && !(budgetUsd > 0)) throw new Error("--budget must be a positive number of USD");

  const architct = createArchitect({
    dataDir: values.data,
    workspace: values.workspace,
    browser: { headless: !values.headed, storageStatePath: values.state, allowedHosts: values["allow-host"] },
    approvalHandler: command === "serve" ? undefined : cliApprovals(),
  });
  if (command !== "serve" && !values.json) architct.on("event", printEvent);
  const router = architct.brain instanceof RouterBrain ? architct.brain : undefined;
  if (router && command !== "serve" && !values.json) {
    router.onRoute = (d) => {
      const skipped = d.failures.length ? ` ${C.yellow}(after ${d.failures.map((f) => f.id).join(", ")} failed)${C.off}` : "";
      console.log(`${C.dim}  ⇢ ${d.task} → ${d.used} [${d.tier}]${C.off}${skipped}`);
    };
  }
  const library = new ScoreLibrary(path.join(architct.store.root, "scores"));
  const schedules = new ScheduleStore(architct.store.root);

  const finish = async (run: Run) => {
    await architct.dispose();
    if (values.json) console.log(JSON.stringify(run, null, 2));
    else console.log(`\n${C.dim}run ${run.id} · ${run.status}${run.error ? ` · ${run.error}` : ""} · ${path.join(architct.store.runDir(run.id))}${C.off}`);
    process.exitCode = run.status === "succeeded" || run.status === "rehearsed" ? 0 : 1;
  };

  switch (command) {
    case "run": {
      const goal = rest.join(" ").trim();
      if (!goal) throw new Error('give a goal: architct run "…"');
      return finish(await architct.run(goal, { autonomy, inputs, startUrl: values.url, permissions: permit, budgetUsd }));
    }
    case "compose": {
      const goal = rest.join(" ").trim();
      const score = await architct.compose(goal, { inputs, startUrl: values.url, permissions: permit });
      console.log(JSON.stringify(score, null, 2));
      const est = architct.estimate(score);
      console.error(`${C.dim}estimate to perform: $${est.lowUsd.toFixed(2)}–$${est.highUsd.toFixed(2)}${C.off}`);
      return architct.dispose();
    }
    case "recover":
      return finish(await architct.recover(required(rest[0], "runId"), { budgetUsd }));
    case "encore":
      return finish(
        await architct.encore(required(rest[0], "runId"), inputs, values.autonomy ? autonomy : undefined, budgetUsd),
      );
    case "save": {
      const run = await architct.store.load(required(rest[0], "runId"));
      const saved = await library.save(required(rest[1], "name"), run.score);
      console.log(`Saved "${saved.name}"${saved.inputs.length ? ` (inputs: ${saved.inputs.join(", ")})` : ""}`);
      return;
    }
    case "scores": {
      for (const s of await library.list()) {
        console.log(`${s.name.padEnd(28)} ${s.inputs.length ? `[${s.inputs.join(", ")}] ` : ""}${s.description.slice(0, 80)}`);
      }
      return;
    }
    case "play": {
      const saved = await library.get(required(rest[0], "name"));
      const run = await architct.prepare(saved.score, { inputs, autonomy, budgetUsd, source: `score:${saved.name}` });
      return finish(await architct.perform(run));
    }
    case "export": {
      const { savedAt: _s, inputs: _i, ...pkg } = await library.get(required(rest[0], "name"));
      console.log(JSON.stringify(pkg, null, 2));
      return;
    }
    case "import": {
      const raw = JSON.parse(await readFile(required(rest[0], "file"), "utf8"));
      const saved = await library.import(raw);
      console.log(`Installed "${saved.name}" — permissions it asks for: ${saved.score.permissions.join(", ") || "none"}`);
      return;
    }
    case "schedule": {
      const sub = rest[0];
      if (sub === "list") {
        for (const s of await schedules.list()) {
          const when = s.everyMinutes ? `every ${s.everyMinutes}m` : `daily ${s.dailyAt}`;
          console.log(
            `${s.name.padEnd(24)} ${s.score.padEnd(24)} ${when.padEnd(14)} ${s.autonomy.padEnd(13)} ${s.enabled ? "on " : "off"} last: ${s.lastRunAt ?? "never"}`,
          );
        }
        return;
      }
      if (sub === "remove") return schedules.remove(required(rest[1], "name"));
      if (sub === "add") {
        const s = validateSchedule({
          name: required(rest[1], "name"),
          score: required(values.score, "--score"),
          everyMinutes: values.every ? Number(values.every) : undefined,
          dailyAt: values.daily,
          inputs,
          autonomy: values.autonomy ? autonomy : "autopilot",
          budgetUsd,
        });
        await library.get(s.score);
        await schedules.upsert(s);
        console.log(`Scheduled "${s.name}". It runs while \`architct serve\` is running.`);
        return;
      }
      throw new Error("usage: architct schedule add|list|remove");
    }
    case "models": {
      if (!router) {
        console.log(`single model: ${architct.brain.model} (set OMNIROUTE_URL or add architct.models.json to route automatically)`);
        return;
      }
      const p = router.policy;
      console.log(`routing: plan → ${p.plan} · verify → ${p.verify} · act → ${p.act} · escalate after ${p.escalateAfterErrors} errors\n`);
      for (const c of router.candidates) {
        const probe = c.brain instanceof OpenAICompatBrain ? await c.brain.probe() : { ok: Boolean(process.env.ANTHROPIC_API_KEY), error: "ANTHROPIC_API_KEY not set" };
        const state = probe.ok
          ? `${C.green}up${C.off}${"listed" in probe && probe.listed === false ? ` ${C.yellow}(model not listed)${C.off}` : ""}`
          : `${C.red}down${C.off} ${C.dim}${probe.error}${C.off}`;
        console.log(`  ${c.tier.padEnd(9)} ${c.id.padEnd(36)} ${state}`);
      }
      return;
    }
    case "runs": {
      for (const r of await architct.store.list()) {
        console.log(`${r.id}  ${r.status.padEnd(17)} ${r.autonomy.padEnd(13)} ${r.createdAt}  ${r.score.goal.slice(0, 70)}`);
      }
      return;
    }
    case "show":
      console.log(JSON.stringify(await architct.store.load(required(rest[0], "runId")), null, 2));
      return;
    case "serve": {
      const port = Number(values.port ?? process.env.PORT ?? 7337);
      const token = process.env.ARCHITCT_API_TOKEN;
      const triggers = await TriggerRouter.fromFile(path.resolve("architct.triggers.json"));
      createArchitectServer({ architct, token, triggers, library, schedules }).listen(port, () => {
        new Scheduler(architct, library, schedules).start();
        console.log(`:\\ARCHITECT\\ listening on http://localhost:${port}  (Podium at /)`);
        if (!token) console.log(`${C.yellow}ARCHITCT_API_TOKEN is not set: the API is open to anyone who can reach this port.${C.off}`);
      });
      return;
    }
    default:
      throw new Error(`unknown command "${command}"\n\n${HELP}`);
  }
}

function required(v: string | undefined, name: string): string {
  if (!v) throw new Error(`missing ${name}`);
  return v;
}

main().catch((err) => {
  console.error(`${C.red}architct:${C.off} ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
