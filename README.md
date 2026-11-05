# /CNDCTR/™ — Conductor

**Intent in. Outcome out.** /CNDCTR/ is Infinitum's AI execution engine. Describe an outcome; Conductor writes the plan, operates the interfaces (a real browser, your project folder, APIs and other Infinitum products), and proves the result is done before it says so.

It is also the **action layer for the Infinitum ecosystem**: when Spectre spots a renewal risk, METATRON¹⁰⁰ flags an event or [HRVST] captures a fault, a signal starts a Score and Conductor turns it into finished work — with a person's approval at every step that matters.

> You set the direction. Conductor carries it through.

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
- **Handoff** — when Conductor needs a person (sign-in, CAPTCHA, payment details, a judgment call) it writes `handoff/HANDOFF.md`, the browser session state and a last screenshot, then stops.

### Estimates and spending limits

Every Score shows a cost estimate before it runs, and every run tracks tokens and dollars as it goes (CLI, Podium, `run.usage`). Give a limit with `--budget 5` (or `budgetUsd` in the API): when it is reached, Conductor hands off instead of continuing, and `recover --budget 10` resumes with a higher limit.

### Saved Scores, the Marketplace and Autopilot schedules

```bash
cndctr save run_ab12cd34 supplier-quote          # keep a Score that worked
cndctr play supplier-quote -i supplier="Globex"  # rerun it with new inputs
cndctr export supplier-quote > quote.json         # Marketplace package (SHA-256 digest)
cndctr import quote.json                          # install one; tampered packages are rejected
cndctr schedule add weekly-quotes --score supplier-quote --daily 09:00 -i supplier=Acme --budget 3
```

A Score installed from someone else is untrusted: when it is played, its permissions are re-clamped to your account's ceiling and its instruments to the ones you have. Schedules run on Autopilot inside `cndctr serve` and never overlap themselves.

### Safe by design

- Permissions belong to the Score and the account (`permissionCeiling`). The model proposes; the ceiling disposes. Nothing read during a run can expand them.
- Every tool output reaches the model wrapped as `<tool_output trust="untrusted">`, and the prompts treat it as data, never instructions.
- Conductor never types into password or payment-card fields, never creates accounts and never solves CAPTCHAs — those become a Handoff.
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
CNDCTR_API_TOKEN=change-me node dist/cli.js serve      # http://localhost:7337/?token=change-me
```

## Folding Conductor into every Infinitum product

Each product integrates in one of three ways:

**1. Call it (SDK).** Dependency-free, runs in Node, browsers, VEIL</> and edge runtimes.

```ts
import { CndctrClient } from "cndctr/sdk";
const cndctr = new CndctrClient({ baseUrl: process.env.CNDCTR_URL, token: process.env.CNDCTR_TOKEN });

const run = await cndctr.run({ goal: "Compare these suppliers, prepare the order and bring me the final price for approval" });
for await (const ev of cndctr.events(run.id)) console.log(ev.type, ev.data);
```

**2. Signal it (triggers).** A product posts a signal; a matching rule starts a Score.

```ts
await cndctr.signal("spectre", "renewal_risk", { account: "Acme", owner: "dana@acme.example", reason: "usage down 40%" });
```

Rules live in `cndctr.triggers.json` (see `cndctr.triggers.example.json`). Built-in defaults cover Spectre `renewal_risk`, [HRVST] `fault`, METATRON¹⁰⁰ `event` and Cumulus://Cloud `alert`. Signal payloads are flattened into the goal as data.

**3. Be played by it (Conductor action contract).** A product exposes actions Conductor can call as an Instrument. `cndctr/adapter` implements the contract in a few lines (see [examples/spectre-adapter.ts](examples/spectre-adapter.ts)):

```ts
import { createActionHandler } from "cndctr/adapter";
const cndctr = createActionHandler({
  token: process.env.CNDCTR_PRODUCT_TOKEN,
  actions: {
    find_account:   { description: "Look up an account", risk: "read",  run: ({ query }) => crm.find(query) },
    draft_followup: { description: "Save a draft email", risk: "write", run: (p) => crm.draft(p) },
  },
});
http.createServer(async (req, res) => { if (await cndctr(req, res)) return; /* your app */ });
```

The wire format:

```
GET  {baseUrl}/cndctr/v1/actions            -> [{ name, description, risk }]
POST {baseUrl}/cndctr/v1/actions/{action}   <- { runId, payload }   -> JSON
```

Configure with `CNDCTR_PRODUCT_<KEY>_URL` / `CNDCTR_PRODUCT_<KEY>_TOKEN` for `scalvs`, `spectre`, `hrvst`, `metatron`, `cumulus`, `firmament`, `veil`, `throne`, `fabric`, `eidetic`, `eon`, `conjure`.

| Product | Role with /CNDCTR/ |
|---|---|
| SCALVS.ai | the intelligence behind every step (swap in via the `Brain` interface) |
| +SPCTR (Spectre) | CRM follow-ups and routing; renewal-risk triggers |
| [HRVST] | Observe → Understand → Act: field faults become tickets |
| METATRON¹⁰⁰ | event triggers |
| Cumulus://Cloud | secure execution environments; alert triggers |
| Firmament Network | verified-outcome attestation (`attest` action) |
| VEIL</> | Conductor in the browser sidebar via the SDK |
| #THRONE | local / on-prem runs: point `Brain` at a local model, run `serve` on the box |
| CONJURE | pre-flight rehearsal of a Score's stakeholder reactions (planned) |

`/CNDCTR/ MIL` (ODIN° Decide layer) is a separate product on accredited infrastructure and is **not** built from this repository.

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

All `/v1` routes require `Authorization: Bearer $CNDCTR_API_TOKEN` when the token is set (set it whenever the server is reachable by others).

## Library

```ts
import { createConductor } from "cndctr";

const conductor = createConductor({ workspace: "./my-app", browser: { headless: false } });
conductor.on("event", (e) => console.log(e.type));
const run = await conductor.run("Build a landing page for the spring sale and check it renders", { autonomy: "accompaniment" });
console.log(run.status, run.verdict);
```

Bring your own `Instrument` (any object with `tools` and `execute`) or your own `Brain`.

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | or an `ant auth login` profile |
| `CNDCTR_MODEL` | `claude-opus-5-5` | |
| `CNDCTR_EFFORT` | `high` | `low` … `max` |
| `CNDCTR_FALLBACKS` | on | server-side refusal fallback; set `off` on Bedrock / Vertex / Foundry |
| `CNDCTR_DATA_DIR` | `.cndctr` | runs, events, evidence |
| `CNDCTR_WORKSPACE` | `.cndctr/workspace` | the folder Conductor may build in |
| `CNDCTR_API_TOKEN` | — | bearer token for `serve` |

## Layout

```
src/
  types.ts            Score, Run, Evidence, Permission, Autonomy
  policy.ts           the autonomy gate and risk classifiers
  brain.ts            Claude (compose with structured output; perform with tool use)
  conductor.ts        Compose → Perform → Verify, Encore / Recover / Handoff, approvals
  prompts.ts          system prompts and safety rules
  instruments/        browser (Playwright), workspace, http, ecosystem
  triggers.ts         ecosystem signal → Score rules
  server.ts           HTTP API + SSE + Podium
  sdk.ts              client for other products
  adapter.ts          action-contract handler for products Conductor plays
  usage.ts            token pricing, estimates, spending limits
  library.ts          saved Scores and Marketplace packages
  schedules.ts        Autopilot schedules
  cli.ts              `cndctr`
podium/index.html     the Podium
test/                 gate, conductor end-to-end, real Chromium, API + SDK, budgets, library, schedules, ecosystem + Firmament
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
