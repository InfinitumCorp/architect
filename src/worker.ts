/**
 * :\ARCHITECT\ on Cloudflare Workers.
 *
 *   /               the Podium (static assets, see wrangler.jsonc)
 *   /healthz        liveness
 *   /v1/...         the API, handled by one Durable Object ("Conductor") that owns the
 *                   Architect instance, so approvals and live runs behave as in `architect serve`
 *
 * Browser: Cloudflare Browser Rendering (BROWSER binding). Storage: the shared Supabase
 * project, schema `architect` (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY secret).
 * Model: the same env settings as the CLI (ANTHROPIC_API_KEY, OMNIROUTE_URL, ARCHITECT_OPENAI_*).
 */
import { DurableObject } from "cloudflare:workers";
import { launch, type BrowserWorker } from "@cloudflare/playwright";
import type { Browser } from "playwright";
import { Architect } from "./architect.js";
import { brainFromEnv, modelsFromEnv } from "./brains/config.js";
import { OpenAICompatBrain } from "./brains/openai.js";
import { DEFAULT_WORKERS_AI_MODEL, WORKERS_AI_BASE_URL, workersAiFetch, type AiBinding } from "./brains/workersai.js";
import { DurableRunStore } from "./stores/durable.js";
import { BrowserInstrument } from "./instruments/browser.js";
import { EcosystemInstrument } from "./instruments/ecosystem.js";
import { HttpInstrument } from "./instruments/http.js";
import postgres from "postgres";
import { postgresCaller, SupabaseRunStore, type UnsafeSql } from "./stores/supabase.js";
import { hostList, parseGoal, REVIEW_POLICIES, walkthrough } from "./agentic.js";
import { PERMISSIONS, type Autonomy, type Permission, type ReviewPolicy, type RunEvent } from "./types.js";

const AUTONOMY: Autonomy[] = ["rehearsal", "accompaniment", "autopilot"];

export interface Env {
  ASSETS: Fetcher;
  CONDUCTOR: DurableObjectNamespace<Conductor>;
  BROWSER: BrowserWorker;
  /** Workers AI: the model when no ANTHROPIC_API_KEY / OMNIROUTE_URL / ARCHITECT_OPENAI_* is set. */
  AI?: AiBinding;
  /** Workers AI model id (default DEFAULT_WORKERS_AI_MODEL). */
  ARCHITECT_WORKERS_AI_MODEL?: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Hyperdrive to the Supabase pooler as the architect_worker login (see supabase/migrations). */
  HYPERDRIVE?: Hyperdrive;
  ARCHITECT_API_TOKEN?: string;
  [key: string]: unknown;
}

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function authorized(req: Request, token: string): Promise<boolean> {
  const url = new URL(req.url);
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(token)),
  ]);
  // Workers extension to SubtleCrypto (not in the DOM typings).
  return (crypto.subtle as unknown as { timingSafeEqual(a: ArrayBuffer, b: ArrayBuffer): boolean }).timingSafeEqual(a, b);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return json(200, { ok: true, at: new Date().toISOString() });
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      // The hosted edition never runs open: no token configured means no API.
      if (!env.ARCHITECT_API_TOKEN) return json(503, { error: "The server has no ARCHITECT_API_TOKEN secret yet." });
      if (!(await authorized(req, env.ARCHITECT_API_TOKEN))) return json(401, { error: "missing or invalid bearer token" });
      return env.CONDUCTOR.get(env.CONDUCTOR.idFromName("main")).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

/** Owns the one Architect instance: runs, approvals and the browser all live here. */
export class Conductor extends DurableObject<Env> {
  private architect?: Architect;
  private running = new Set<Promise<unknown>>();

  private get arch(): Architect {
    if (this.architect) return this.architect;
    const env = this.env as unknown as Record<string, string | undefined>;
    // Model: explicit settings win; otherwise Workers AI through the binding (no key needed).
    const configured = !!env.ANTHROPIC_API_KEY || !!modelsFromEnv(env);
    const brain =
      configured || !this.env.AI
        ? brainFromEnv(env, "/")
        : new OpenAICompatBrain({
            baseUrl: WORKERS_AI_BASE_URL,
            model: this.env.ARCHITECT_WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL,
            fetch: workersAiFetch(this.env.AI),
            maxTokens: 8_000,
          });
    // Storage: Supabase over Hyperdrive as the limited architect_worker login; else with the
    // service-role key if one is set; else the Durable Object's own storage.
    const store = this.env.HYPERDRIVE
      ? new SupabaseRunStore({
          call: postgresCaller(
            postgres(this.env.HYPERDRIVE.connectionString, { max: 5, fetch_types: false, prepare: false }) as unknown as UnsafeSql,
          ),
        })
      : this.env.SUPABASE_SERVICE_ROLE_KEY
        ? new SupabaseRunStore({ url: this.env.SUPABASE_URL, serviceKey: this.env.SUPABASE_SERVICE_ROLE_KEY })
        : new DurableRunStore(this.ctx.storage);
    this.architect = new Architect({
      brain,
      store,
      instruments: [
        new BrowserInstrument({ launch: async () => (await launch(this.env.BROWSER)) as unknown as Browser }),
        new HttpInstrument(),
        new EcosystemInstrument(),
      ],
    });
    return this.architect;
  }

  /** Runs outlive the request that started them; an alarm keeps the object awake until they finish. */
  private background(p: Promise<unknown>) {
    const tracked = p.catch((err) => console.error("[architect]", err)).finally(() => this.running.delete(tracked));
    this.running.add(tracked);
    void this.ctx.storage.setAlarm(Date.now() + 20_000);
  }

  async alarm() {
    if (this.running.size) await this.ctx.storage.setAlarm(Date.now() + 20_000);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const [, resource, id, action, file] = url.pathname.split("/").filter(Boolean);
    try {
      const a = this.arch;
      const body = async (): Promise<Record<string, unknown>> => {
        const text = await req.text();
        if (!text) return {};
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new HttpError(400, "body must be a JSON object");
        return parsed as Record<string, unknown>;
      };

      if (resource === "runs" && !id) {
        if (req.method === "GET") return json(200, await a.store.list(Number(url.searchParams.get("limit") ?? 50)));
        if (req.method === "POST") {
          const b = await body();
          // Slash commands at the start of the goal (/plan, /fast, /rehearse, /autopilot) set options.
          const parsed = parseGoal(String(b.goal ?? ""));
          const goal = parsed.goal;
          if (!goal) throw new HttpError(400, "goal is required");
          const autonomy = (AUTONOMY.includes(b.autonomy as Autonomy) ? b.autonomy : parsed.autonomy ?? "accompaniment") as Autonomy;
          const review = (REVIEW_POLICIES.includes(b.review as ReviewPolicy) ? b.review : parsed.review) as ReviewPolicy | undefined;
          const hostsIn = (b.hosts ?? {}) as Record<string, unknown>;
          const hosts = { allow: hostList(hostsIn.allow), block: hostList(hostsIn.block) };
          const run = await a.start(goal, {
            autonomy,
            inputs: stringMap(b.inputs),
            startUrl: b.startUrl ? String(b.startUrl) : undefined,
            permissions: permissions(b.permissions),
            budgetUsd: budget(b.budgetUsd),
            review,
            hosts: hosts.allow || hosts.block ? hosts : undefined,
            knowledge: b.knowledge !== false,
          });
          if (!b.composeOnly && !a.awaitingPlanReview(run)) this.background(a.perform(run));
          return json(202, run);
        }
      }

      if (resource === "runs" && id) {
        if (req.method === "GET" && !action) return json(200, await a.store.load(id));
        if (req.method === "GET" && action === "walkthrough") {
          const md = walkthrough(await a.store.load(id));
          return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
        }
        if (req.method === "GET" && action === "events") return this.events(a, id);
        if (req.method === "GET" && action === "evidence" && file) {
          if (!/^[\w.-]+\.png$/.test(file)) throw new HttpError(400, "bad evidence name");
          return new Response((await a.store.getFile(id, `evidence/${file}`)) as unknown as BodyInit, { headers: { "content-type": "image/png" } });
        }
        if (req.method === "POST") {
          const b = await body();
          if (action === "perform") {
            let run = await a.store.load(id);
            if (run.status !== "composed") throw new HttpError(409, `run is ${run.status}`);
            if (a.awaitingPlanReview(run)) run = await a.approvePlan(id, b.by ? String(b.by) : undefined);
            this.background(a.perform(run));
            return json(202, { ok: true });
          }
          if (action === "recover") {
            if (a.isActive(id)) throw new HttpError(409, "run is still performing");
            this.background(a.recover(id, { budgetUsd: budget(b.budgetUsd) }));
            return json(202, { ok: true });
          }
          if (action === "encore") {
            const autonomy = AUTONOMY.includes(b.autonomy as Autonomy) ? (b.autonomy as Autonomy) : undefined;
            this.background(a.encore(id, stringMap(b.inputs) ?? {}, autonomy, budget(b.budgetUsd)));
            return json(202, { ok: true });
          }
          if (action === "comments") {
            const text = String(b.text ?? "");
            const target = String(b.target ?? "score");
            try {
              return json(201, await a.comment(id, target, text, b.by ? String(b.by).slice(0, 80) : undefined));
            } catch (err) {
              if (err instanceof Error && /required|unknown comment target/.test(err.message)) throw new HttpError(400, err.message);
              throw err;
            }
          }
          if (action === "cancel") {
            a.cancel(id);
            return json(202, { ok: true });
          }
        }
      }

      if (resource === "knowledge" && req.method === "GET") {
        const q = String(url.searchParams.get("q") ?? "").slice(0, 500);
        return json(200, q ? await a.knowledge(q) : []);
      }

      if (resource === "approvals") {
        if (req.method === "GET" && !id) return json(200, a.pendingApprovals);
        if (req.method === "POST" && id) {
          const b = await body();
          const ok = a.decide(id, { approved: b.approved === true, note: b.note ? String(b.note) : undefined, by: b.by ? String(b.by) : "api" });
          if (!ok) throw new HttpError(404, "no pending approval with that id");
          return json(200, { ok: true });
        }
      }

      if (["scores", "schedules", "signals"].includes(resource ?? "")) {
        throw new HttpError(501, `/v1/${resource} is not in the hosted edition yet; use \`architect serve\``);
      }
      throw new HttpError(404, "not found");
    } catch (err) {
      const status =
        err instanceof HttpError ? err.status
        : err instanceof SyntaxError || (err as Error)?.name === "ZodError" ? 400
        : /not found/i.test((err as Error)?.message ?? "") ? 404
        : 500;
      if (status === 500) console.error("[architect]", err);
      let message = err instanceof Error ? err.message : String(err);
      if (/authentication method|api[_ ]?key|401/i.test(message) && status === 500) {
        message = "No AI model is configured on the server. Set ANTHROPIC_API_KEY (or OMNIROUTE_URL) as a Worker secret.";
      }
      return json(status, { error: message });
    }
  }

  /** Server-sent events: the stored log, then live events until the client goes away. */
  private async events(a: Architect, runId: string): Promise<Response> {
    await a.store.load(runId);
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();
    const send = (ev: RunEvent) => writer.write(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)).catch(() => stop());
    const listener = (ev: RunEvent) => void (ev.runId === runId && send(ev));
    const ping = setInterval(() => writer.write(enc.encode(": ping\n\n")).catch(() => stop()), 20_000);
    const stop = () => {
      clearInterval(ping);
      a.off("event", listener);
    };
    for (const ev of await a.store.events(runId)) void send(ev);
    a.on("event", listener);
    return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object") return undefined;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]));
}

function permissions(v: unknown): Permission[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const bad = v.filter((p) => !PERMISSIONS.includes(p as Permission));
  if (bad.length) throw new HttpError(400, `unknown permissions: ${bad.join(", ")}`);
  return v as Permission[];
}

function budget(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, "budgetUsd must be a positive number");
  return n;
}
