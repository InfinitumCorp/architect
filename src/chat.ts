/**
 * The interactive coding session: run `architect` in a project folder, like Claude Code or Codex.
 * Each message is a task in this folder; later messages follow up on the earlier ones.
 *
 *   /plan /ask /auto /rehearse   switch mode (Shift+Tab has no terminal equivalent, so commands)
 *   /model [id]                  show or pick the model
 *   /diff                        what changed in the folder (git)
 *   /new                         start a new session (forget earlier messages)
 *   /help  /exit
 *   !command                     run one shell command in the folder
 *   @path                        attach a file's contents to the message
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type { Architect, PerformOptions } from "./architect.js";
import { expandMentions, runShell } from "./mentions.js";
import type { Run } from "./types.js";

const C = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", blue: "\x1b[34m", off: "\x1b[0m" };

export const MODES = {
  ask: { name: "Ask before acting", autonomy: "accompaniment", review: "agent_decides", hint: "pauses at risky actions" },
  plan: { name: "Plan first", autonomy: "accompaniment", review: "request_review", hint: "shows the plan before it acts" },
  auto: { name: "Autopilot", autonomy: "autopilot", review: "always_proceed", hint: "runs within standing permissions" },
  rehearse: { name: "Rehearse", autonomy: "rehearsal", review: "always_proceed", hint: "plans and drafts only, changes nothing" },
} as const;
export type ModeKey = keyof typeof MODES;

const HELP = `${C.bold}Commands${C.off}
  /plan /ask /auto /rehearse   switch mode
  /model [id]                  show or pick the model
  /diff                        what changed in this folder
  /new                         new session (forget earlier messages)
  /exit                        quit (or Ctrl+D)
  !command                     run a shell command here
  @path                        attach a file to your message
  Ctrl+C                       stop the running task`;

export interface ChatOptions {
  architect: Architect;
  /** The project folder: tasks read, edit and run commands here. */
  folder: string;
  /** First message, from `architect "<task>"`. */
  initial?: string;
  mode?: ModeKey;
  budgetUsd?: number;
}

/** Keep Architect's own data (.architect) out of the project's git history. */
export async function ignoreDataDir(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, ".gitignore"), "*\n", { flag: "wx" }).catch(() => {});
}

export async function chat(opts: ChatOptions): Promise<void> {
  const { architect, folder } = opts;
  let mode: ModeKey = opts.mode ?? "ask";
  let model = "auto";
  let last: Run | undefined;
  let active: string | undefined;

  const models = architect.models();
  console.log(`\n${C.bold}:\\ARCHITECT\\™${C.off} ${C.dim}coding agent${C.off}`);
  console.log(`${C.dim}${folder}${C.off}`);
  console.log(`${C.dim}model ${models.options.find((o) => o.id === model)?.label ?? model} · mode ${MODES[mode].name} · /help for commands${C.off}\n`);

  // Ctrl+C stops the running task; at the prompt, twice in a row quits.
  let lastInterrupt = 0;
  const onSigint = () => {
    if (active) {
      console.log(`\n${C.yellow}Stopping…${C.off}`);
      architect.cancel(active);
      return;
    }
    if (Date.now() - lastInterrupt < 1500) process.exit(130);
    lastInterrupt = Date.now();
    console.log(`\n${C.dim}Press Ctrl+C again to quit.${C.off}`);
  };
  process.on("SIGINT", onSigint);

  const ask = async (q: string): Promise<string | null> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.on("SIGINT", () => { rl.close(); onSigint(); });
    try {
      return await rl.question(q);
    } catch {
      return null; // Ctrl+D or closed
    } finally {
      rl.close();
    }
  };

  const perform = async (text: string) => {
    const m = MODES[mode];
    const goal = await expandMentions(text, folder);
    const startOpts: PerformOptions = {
      autonomy: m.autonomy,
      review: m.review,
      budgetUsd: opts.budgetUsd,
      ...(model !== "auto" ? { model } : {}),
    };
    let run = await (last ? architect.followUp(last.id, goal, startOpts) : architect.start(goal, startOpts));
    active = run.id;
    try {
      if (architect.awaitingPlanReview(run)) {
        const yes = await ask(`${C.yellow}${C.bold}Go ahead with this plan?${C.off} [Y/n/what to change] `);
        if (yes === null || /^n(o)?$/i.test(yes.trim())) {
          console.log(`${C.dim}Plan not performed. Say what to change, or give a new task.${C.off}`);
          last = run;
          return;
        }
        if (yes.trim() && !/^y(es)?$/i.test(yes.trim())) {
          await architect.comment(run.id, "score", yes.trim(), "terminal");
        }
        run = await architect.approvePlan(run.id, "terminal");
      }
      run = await architect.perform(run);
    } finally {
      active = undefined;
    }
    last = run;
    const cost = run.usage ? ` · $${run.usage.costUsd.toFixed(2)}` : "";
    const stopped = run.error === "cancelled";
    const colour = run.status === "succeeded" || run.status === "rehearsed" ? C.green : stopped ? C.yellow : C.red;
    const label = stopped ? "stopped" : run.status.replace(/_/g, " ");
    console.log(`\n${colour}${label}${C.off}${C.dim}${cost} · ${run.id}${C.off}${run.error && !stopped ? `\n${C.red}${run.error}${C.off}` : ""}\n`);
  };

  const handle = async (line: string): Promise<boolean> => {
    const text = line.trim();
    if (!text) return true;
    if (text.startsWith("!")) {
      const r = await runShell(text.slice(1).trim(), folder);
      if (r.output) process.stdout.write(r.output.endsWith("\n") ? r.output : `${r.output}\n`);
      console.log(`${C.dim}exit ${r.code}${r.timedOut ? " · timed out" : ""}${C.off}\n`);
      return true;
    }
    const [cmd, ...args] = text.split(/\s+/);
    switch (cmd!.toLowerCase()) {
      case "/exit":
      case "/quit":
        return false;
      case "/help":
        console.log(`${HELP}\n`);
        return true;
      case "/new":
      case "/clear":
        last = undefined;
        console.log(`${C.dim}New session.${C.off}\n`);
        return true;
      case "/diff": {
        const r = await runShell("git status --short && git diff --stat", folder);
        console.log(r.code === 0 ? r.output || `${C.dim}No changes.${C.off}` : `${C.dim}Not a git repository.${C.off}`);
        return true;
      }
      case "/model": {
        if (!args[0]) {
          for (const o of models.options) console.log(`  ${o.id === model ? `${C.green}●${C.off}` : " "} ${o.id}${o.tier && o.id !== o.tier ? ` ${C.dim}(${o.tier})${C.off}` : ""}`);
          console.log(`${C.dim}/model <id> to pick one${C.off}\n`);
        } else if (models.options.some((o) => o.id === args[0])) {
          model = args[0]!;
          console.log(`${C.dim}Model: ${model}${C.off}\n`);
        } else console.log(`${C.red}Unknown model "${args[0]}". /model lists them.${C.off}\n`);
        return true;
      }
    }
    const key = cmd!.slice(1).toLowerCase();
    if (cmd!.startsWith("/") && key in MODES) {
      mode = key as ModeKey;
      const rest = args.join(" ");
      console.log(`${C.dim}Mode: ${MODES[mode].name} (${MODES[mode].hint})${C.off}\n`);
      if (rest) await perform(rest).catch(report);
      return true;
    }
    if (cmd!.startsWith("/")) {
      console.log(`${C.red}Unknown command ${cmd}. /help lists them.${C.off}\n`);
      return true;
    }
    await perform(text).catch(report);
    return true;
  };

  try {
    if (opts.initial && !(await handle(opts.initial))) return;
    for (;;) {
      const line = await ask(`${C.blue}>${C.off} `);
      if (line === null || !(await handle(line))) break;
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

function report(err: unknown) {
  console.log(`${C.red}${err instanceof Error ? err.message : String(err)}${C.off}\n`);
}
