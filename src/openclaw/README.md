# @scalvs / @scalus in this product

[OpenClaw](https://openclaw.ai) is a self-hosted agent gateway: one AI agent, connected to the person's chat apps and skills. Anyone using this product can type **@scalvs** (or **@scalus**) and a task, for example `@scalvs summarise this thread and send it to my Telegram`. The product sends the task, plus whatever the person is looking at, to the SCALVS agent, which runs on OpenClaw, and shows the answer. Typing **@conjure** and a question still starts a Conjure™ forecast. `@openclaw` is not a trigger.

`openclaw.mjs` is the whole client: no dependencies, works in Node 18+, Cloudflare Workers, Deno and Bun. Its source of truth is `InfinitumCorp/infinitum-nexus`, `packages/ai/src/openclaw/` (inside the monorepo, import `@infinitum/ai/openclaw`). Copies in other repos are synced from there with `node packages/ai/scripts/sync-openclaw.mjs <dest-folder>`. Don't edit a copy.

## How to turn it on

It is **off by default**. Until both variables below are set, `@scalvs` replies with how to connect it, and everything else in the product works as before.

1. On the OpenClaw gateway, set `gateway.http.endpoints.chatCompletions.enabled = true` and make the gateway reachable over https (for example with Tailscale Funnel). For people in Russia, use a host that is reachable there without a VPN, not one behind Cloudflare.
2. Set these in the product's **server** environment (Cloudflare/Vercel secrets, or `.env` locally, which is never committed):

   | Variable | Value |
   |---|---|
   | `OPENCLAW_GATEWAY_URL` | The gateway's https URL. `http://localhost` / `127.0.0.1` is allowed for development. |
   | `OPENCLAW_GATEWAY_TOKEN` | The gateway's `gateway.auth.token`. A **server secret**: it gives full control of the gateway. |
   | `OPENCLAW_AGENT` (optional) | `openclaw` for the default agent, or `openclaw/<agentId>`. |

3. Redeploy. `GET /api/openclaw` (signed in) answers `{ "connected": true, "agent": "openclaw" }`.

## Wiring it into a product

```js
import { openClawRoutesFromEnv } from "./openclaw/openclaw.mjs";

const openclaw = openClawRoutesFromEnv(env, { product: "mail" }); // off until configured

// In the router, AFTER Cumulus ID sign-in:
const res = await openclaw(request, { user: session.cid, context: "What the person is looking at" });
if (res) return res; // null for paths it doesn't own
```

The browser posts `{ text, context? }` to `POST /api/openclaw` whenever the person's text contains `@scalvs` or `@scalus`, and shows `text` from the reply:

| Reply | Meaning |
|---|---|
| `200 { mention: false }` | No `@scalvs` / `@scalus` in the text. Handle it as usual. |
| `200 { mention: true, text, agent }` | The agent's answer. |
| `400` | A bare `@scalvs` with no task. |
| `401` | Not signed in. |
| `503` | SCALVS isn't connected here (the error says how to connect it). |
| `429` / `502` / `504` | The gateway is busy, refused the token, is unreachable or timed out. |

To let each person bring their own gateway, pass a lookup instead of the environment: `createOpenClawRoutes({ openclaw: (user) => clientFromTheirSettings(user), product })`.

## Safety

- The gateway token never leaves the server. It isn't in responses, errors or `GET /api/openclaw`.
- The product sends text only and gives the agent no tools inside the product, so the agent can't change the product's data.
- URLs must be https (localhost excepted) and can't contain credentials. Agent names are checked. Tasks are capped at 4,000 characters, context at 60,000, answers at 20 KB, and requests time out after 120 s.
- The OpenAI `user` field is `<product>:<user>`, so each person keeps their own OpenClaw session.
- `fetch` is called as a plain function, which avoids the Workers "Illegal invocation" bug.
