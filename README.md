# :\ARCHITECT\™ — Architect

**Intent in. Outcome out.** :\ARCHITECT\ is Infinitum's AI execution engine. Describe an outcome; Architect writes the plan, operates the interfaces (a real browser, your project folder, APIs and other Infinitum products), and proves the result is done before it says so.

It is also the **action layer for the Infinitum ecosystem**: when Spectre spots a renewal risk, METATRON¹⁰⁰ flags an event or [HRVST] captures a fault, a signal starts a Score and Architect turns it into finished work — with a person's approval at every step that matters.

> You set the direction. Architect carries it through.

## How it works

| | | |
|---|---|---|
| **01 Compose** | Write the **Score** | An executable plan: steps, permissions, checkpoints and a definition of success |
| **02 Connect** | Choose the **Instruments** | `browser` (Playwright/Chromium), `workspace` (files + shell), `http`, `ecosystem` (Infinitum products) |
| **03 Perform** | Run the **Performance** | An Observe → Think → Act loop on Claude. Every action is recorded with its risk, outcome and evidence |
| **04 Verify** | **Prove it worked** | An independent verifier with read-only tools checks every success criterion against live state and evidence |

### Three levels of autonomy

| Level | Reads | Routine writes | Irreversible (submit, pay, send, delete, publish, push) |
|---|---|---|---|
| **Rehearsal** | run | drafted, not run | drafted, not run |
| **Accompaniment** (default) | run | run | pause for approval |
| **Autopilot** | run | run | pause, unless the Score holds `standing.irreversible` |

The gate (`src/policy.ts`) is pure and deterministic. A tool whose permission the Score was not granted is blocked at every level.

### Encore · Recover · Handoff

- **Encore** — rerun a Score with new inputs (`{{name}}` placeholders in step instructions).
- **Recover** — resume a failed or handed-off run; completed steps are not repeated and the performer sees what the last attempt did.
- **Handoff** — when Architect needs a person (sign-in, CAPTCHA, payment details, a judgment call) it writes `handoff/HANDOFF.md`, the browser session state and a last screenshot, then stops.

### Estimates and spending limits

Every Score shows a cost estimate before it runs, and every run tracks tokens and dollars as it goes (CLI, Podium, `run.usage`). Give a limit with `--budget 5` (or `budgetUsd` in the API): when it is reached, Architect hands off instead of continuing, and `recover --budget 10` resumes with a higher limit.

### Saved Scores, the Marketplace and Autopilot schedules

```bash
architect save run_ab12cd34 supplier-quote          # keep a Score that worked
architect play supplier-quote -i supplier="Globex"  # rerun it with new inputs
architect export supplier-quote > quote.json         # Marketplace package (SHA-256 digest)
architect import quote.json                          # install one; tampered packages are rejected
architect schedule add weekly-quotes --score supplier-quote --daily 09:00 -i supplier=Acme --budget 3
```

A Score installed from someone else is untrusted: when it is played, its permissions are re-clamped to your account's ceiling and its instruments to the ones you have. Schedules run on Autopilot inside `architect serve` and never overlap themselves.

### Safe by design

- Permissions belong to the Score and the account (`permissionCeiling`). The model proposes; the ceiling disposes. Nothing read during a run can expand them.
- Every tool output reaches the model wrapped as `<tool_output trust="untrusted">`, and the prompts treat it as data, never instructions.
- Architect never types into password or payment-card fields, never creates accounts and never solves CAPTCHAs — those become a Handoff.
- Workspace paths are confined to the workspace folder; browser hosts can be allow-listed (`--allow-host`).
- Verified outcomes are attested on **Firmament Network** when it is connected (SHA-256 digest of Score, verdict and evidence).

## Quick start

```bash
npm install
npx playwright install chromium
export ANTHROPIC_API_KEY=...        # or an `ant auth login` profile
npm run build
```

```bash
# Rehearse first: plan and draft, change nothing
node dist/cli.js run "Find the three cheapest 27-inch 4K monitors on example-shop.com and list them with prices" -a rehearsal --headed

# Accompaniment: runs routine steps, asks before anything irreversible
node dist/cli.js run "Add a /healthz endpoint to this project, run the tests, and fix anything that fails" -w ../my-app

# Rerun a Score with new inputs
node dist/cli.js encore run_ab12cd34 -i supplier="Acme Corp"

# Resume after a failure or handoff
node dist/cli.js recover run_ab12cd34

# API + Podium (live view, approvals, evidence)
ARCHITECT_API_TOKEN=change-me node dist/cli.js serve      # http://localhost:7337/?token=change-me
```

## Folding Architect into every Infinitum product

Each product integrates in one of three ways:

**1. Call it (SDK).** Dependency-free, runs in Node, browsers, VEIL</> and edge runtimes.

```ts
import { ArchitectClient } from "architect/sdk";
const architect = new ArchitectClient({ baseUrl: process.env.ARCHITECT_URL, token: process.env.ARCHITECT_TOKEN });

const run = await architect.run({ goal: "Compare these suppliers, prepare the order and bring me the final price for approval" });
for await (const ev of architect.events(run.id)) console.log(ev.type, ev.data);
```

**2. Signal it (triggers).** A product posts a signal; a matching rule starts a Score.

```ts
await architect.signal("spectre", "renewal_risk", { account: "Acme", owner: "dana@acme.example", reason: "usage down 40%" });
```

Rules live in `architect.triggers.json` (see `architect.triggers.example.json`). Built-in defaults cover Spectre `renewal_risk`, [HRVST] `fault`, METATRON¹⁰⁰ `event` and Cumulus://Cloud `alert`. Signal payloads are flattened into the goal as data.

**3. Be played by it (Architect action contract).** A product exposes actions Architect can call as an Instrument. `architect/adapter` implements the contract in a few lines (see [examples/spectre-adapter.ts](examples/spectre-adapter.ts)):

```ts
import { createActionHandler } from "architect/adapter";
const architect = createActionHandler({
  token: process.env.ARCHITECT_PRODUCT_TOKEN,
  actions: {
    find_account:   { description: "Look up an account", risk: "read",  run: ({ query }) => crm.find(query) },
    draft_followup: { description: "Save a draft email", risk: "write", run: (p) => crm.draft(p) },
  },
});
http.createServer(async (req, res) => { if (await architect(req, res)) return; /* your app */ });
```

The wire format:

```
GET  {baseUrl}/architect/v1/actions            -> [{ name, description, risk }]
POST {baseUrl}/architect/v1/actions/{action}   <- { runId, payload }   -> JSON
```

Configure with `ARCHITECT_PRODUCT_<KEY>_URL` / `ARCHITECT_PRODUCT_<KEY>_TOKEN` for `scalvs`, `spectre`, `hrvst`, `metatron`, `cumulus`, `firmament`, `veil`, `throne`, `fabric`, `eidetic`, `eon`, `conjure`.

| Product | Role with :\ARCHITECT\ |
|---|---|
| SCALVS.ai | the intelligence behind every step (swap in via the `Brain` interface) |
| +SPCTR (Spectre) | CRM follow-ups and routing; renewal-risk triggers |
| [HRVST] | Observe → Understand → Act: field faults become tickets |
| METATRON¹⁰⁰ | event triggers |
| Cumulus://Cloud | secure execution environments; alert triggers |
| Firmament Network | verified-outcome attestation (`attest` action) |
| VEIL</> | Architect in the browser sidebar via the SDK |
| #THRONE | local / on-prem runs: point `Brain` at a local model, run `serve` on the box |
| CONJURE | pre-flight rehearsal of a Score's stakeholder reactions (planned) |

`:\ARCHITECT\ MIL` (ODIN° Decide layer) is a separate product on accredited infrastructure and is **not** built from this repository.

## Web app and Android app

**Web app (Podium).** `architect serve` serves the Podium at http://localhost:7337. It is an installable web app: in Chrome or Edge choose *Install app*, or on a phone *Add to Home screen*. The page shell works offline, and runs always go to the live API.

**Android app.** `com.infinitum.architect` is a native shell around the Podium. It shows a connect screen for the server address and token, and the token stays on the phone. Build it without Gradle (you need the Android SDK build-tools and a JDK):

```bash
bash android/build.sh          # -> android/build/architect.apk (debug-signed)
adb install -r android/build/architect.apk
```

To reach the server over USB, run `adb reverse tcp:7337 tcp:7337` and use http://localhost:7337. If port 7337 is already taken on the phone, map another one, for example `adb reverse tcp:7338 tcp:7337` and http://localhost:7338. Over Wi-Fi, use http://<computer-ip>:7337 and run `architect serve` with a token. Screenshots are in [android/screenshots](android/screenshots).

## HTTP API

| Method | Path | |
|---|---|---|
| `POST` | `/v1/runs` | start `{ goal, autonomy?, inputs?, startUrl?, permissions?, composeOnly? }` |
| `GET` | `/v1/runs`, `/v1/runs/:id` | list / get |
| `GET` | `/v1/runs/:id/events` | server-sent events (replay + live) |
| `POST` | `/v1/runs/:id/{perform,recover,encore,cancel}` | lifecycle |
| `GET` | `/v1/approvals` | decisions waiting for a person |
| `POST` | `/v1/approvals/:id` | `{ approved, note?, by? }` |
| `POST` | `/v1/signals/:product` | `{ type, payload }` ecosystem trigger |
| `GET` / `POST` / `DELETE` | `/v1/scores[/:name]` | saved Scores (`POST { runId, name }` saves) |
| `POST` | `/v1/scores/:name/play` | `{ inputs?, autonomy?, budgetUsd? }` |
| `POST` | `/v1/scores/import` | install a Marketplace package |
| `GET` / `POST` / `DELETE` | `/v1/schedules[/:name]` | Autopilot schedules |

`POST /v1/runs`, `/recover` and `/encore` also accept `budgetUsd`.

All `/v1` routes require `Authorization: Bearer $ARCHITECT_API_TOKEN` when the token is set (set it whenever the server is reachable by others).

## MCP server (Claude Code, Cursor, other agents)

`architect mcp` speaks MCP over stdio and drives a running `architect serve` (at `ARCHITECT_URL`, default `http://localhost:7337`, with `ARCHITECT_API_TOKEN`). Add it to Claude Code:

```bash
claude mcp add architect -- node /path/to/architect/dist/cli.js mcp
```

Tools: `architect_run` (with `wait`), `architect_get_run`, `architect_list_runs`, `architect_pending_approvals`, `architect_recover`, `architect_cancel`. There is deliberately no approve tool: a calling agent can start and watch runs, but risky actions still wait for a person in the Podium or CLI.

## Library

```ts
import { createArchitect } from "architect";

const architect = createArchitect({ workspace: "./my-app", browser: { headless: false } });
architect.on("event", (e) => console.log(e.type));
const run = await architect.run("Build a landing page for the spring sale and check it renders", { autonomy: "accompaniment" });
console.log(run.status, run.verdict);
```

Bring your own `Instrument` (any object with `tools` and `execute`) or your own `Brain`.

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | or an `ant auth login` profile |
| `ARCHITECT_MODEL` | `claude-opus-5-5` | |
| `ARCHITECT_EFFORT` | `high` | `low` … `max` |
| `ARCHITECT_FALLBACKS` | on | server-side refusal fallback; set `off` on Bedrock / Vertex / Foundry |
| `ARCHITECT_DATA_DIR` | `.architect` | runs, events, evidence |
| `ARCHITECT_WORKSPACE` | `.architect/workspace` | the folder Architect may build in |
| `ARCHITECT_API_TOKEN` | — | bearer token for `serve` |
| `ARCHITECT_BRAIN` | automatic | `anthropic` forces one Claude model; `auto` requires routed models |
| `OMNIROUTE_URL` | — | route through OmniRoute, e.g. `http://localhost:20128/v1` (see below) |

## Automatic model selection (OmniRoute, Ollama and other open models)

Architect can run on open-source and gateway models instead of, or alongside, Claude. A router picks a model for every call:

| Call | Tier | Why |
|---|---|---|
| Composing a Score | `strong` | the plan decides everything that follows |
| Ordinary step turns | `act` tier (default `balanced`) | most clicks and reads are routine |
| A step whose tool calls keep failing | one tier up | escalate instead of looping |
| Verification | `strong` | the verdict must be trustworthy |

Within a tier the cheapest healthy model goes first. A model that errors, rate-limits or returns malformed output is skipped, and the call moves to the next one. The failing model then sits out for a cooldown. When no model of the needed tier exists, a stronger one is used, then a weaker one. Every call is priced with the model that actually answered.

**Quickest setup with [OmniRoute](https://github.com/diegosouzapw/OmniRoute)**, a self-hosted, OpenAI-compatible gateway in front of many providers, including free ones:

```bash
OMNIROUTE_URL=http://localhost:20128/v1      # OmniRoute's "auto" model routes upstream
OMNIROUTE_API_KEY=...                        # if your OmniRoute requires one
OMNIROUTE_FAST_MODEL=qwen3:8b                # optional: a cheap model for routine steps
OMNIROUTE_STRONG_MODEL=...                   # optional: a strong model for plans and verdicts
```

With `ANTHROPIC_API_KEY` also set, Claude becomes the `strong` model and OmniRoute handles the rest. `ARCHITECT_OPENAI_BASE_URL` plus `ARCHITECT_OPENAI_MODEL` does the same for any other OpenAI-compatible endpoint, such as Ollama, LM Studio, vLLM, OpenRouter or LiteLLM.

**Full control** comes from a `architect.models.json` file (copy `architect.models.example.json`). It lists models with a `tier`, an optional `price` in USD per million tokens, a `vision` flag for models that can read screenshots, and `apiKeyEnv`, the *name* of the env var that holds the key. Keys themselves are rejected in this file. You can also override the routing `policy`.

```bash
architect models     # routing table, and whether each model is reachable
```

During a run the CLI shows each routing decision, such as `⇢ act → ollama/qwen3 [fast]`.

Open models drive the browser well enough for routine steps. Keep a strong model for planning and verification, because that is where weak models make the most expensive mistakes. Text-only models get a note in place of screenshots, so set `vision: true` only for models that can actually read images.

## Safety and optional tools

| Topic | Doc |
|---|---|
| OS sandbox and command policy for workspace commands | [docs/sandbox.md](docs/sandbox.md) |
| One folder per run, concurrency limits, recovery | [docs/isolation.md](docs/isolation.md) |
| Playwright MCP as an alternative browser backend | [docs/playwright-mcp.md](docs/playwright-mcp.md) |
| `architect scan`: osv-scanner, git-secrets, SkillSpector, garak | [docs/safety-scanning.md](docs/safety-scanning.md) |
| `architect eval`: code-writing evals run in the sandbox | [docs/evals.md](docs/evals.md) |

Reading PDFs, Office files and other documents uses markitdown when it is installed
(`pipx install 'markitdown[all]'`). Open-source components and their licenses are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Layout

```
src/
  types.ts            Score, Run, Evidence, Permission, Autonomy
  policy.ts           the autonomy gate and risk classifiers
  brain.ts            Claude (compose with structured output; perform with tool use)
  brains/openai.ts    any OpenAI-compatible model (OmniRoute, Ollama, vLLM, OpenRouter …)
  brains/router.ts    automatic model selection: tiers, escalation, failover, cooldowns
  brains/config.ts    architect.models.json and OMNIROUTE_URL / ARCHITECT_OPENAI_* shortcuts
  mcp.ts              MCP server for Claude Code, Cursor and other agents
  architect.ts        Compose → Perform → Verify, Encore / Recover / Handoff, approvals
  prompts.ts          system prompts and safety rules
  instruments/        browser (Playwright), workspace, http, ecosystem
  triggers.ts         ecosystem signal → Score rules
  server.ts           HTTP API + SSE + Podium
  sdk.ts              client for other products
  adapter.ts          action-contract handler for products Architect plays
  usage.ts            token pricing, estimates, spending limits
  library.ts          saved Scores and Marketplace packages
  schedules.ts        Autopilot schedules
  cli.ts              `architect`
podium/index.html     the Podium
test/                 gate, architect end-to-end, real Chromium, API + SDK, budgets, library, schedules, ecosystem + Firmament
examples/             spectre-adapter.ts
```

## Development

```bash
npm test          # vitest; the browser test drives real Chromium
npm run typecheck
npm run dev -- run "…" -a rehearsal
```

---

© Infinitum Corporation. Proprietary. AI-powered · Blockchain-governed™.
