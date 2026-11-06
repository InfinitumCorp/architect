import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Architech } from "./architech.js";
import { TriggerRouter } from "./triggers.js";
import { ScoreLibrary } from "./library.js";
import { ScheduleStore, validateSchedule } from "./schedules.js";
import { PERMISSIONS, type Autonomy, type Permission, type RunEvent, type Signal } from "./types.js";
import { InputError, NotFoundError, now } from "./policy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTONOMY: Autonomy[] = ["rehearsal", "accompaniment", "autopilot"];

export interface ServerOptions {
  architech: Architech;
  triggers?: TriggerRouter;
  /** Bearer token required on /v1/*. Strongly recommended whenever the server is reachable by others. */
  token?: string;
  library?: ScoreLibrary;
  schedules?: ScheduleStore;
}

function budget(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, "budgetUsd must be a positive number");
  return n;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function stringMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {};
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]));
}

function permissions(v: unknown): Permission[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((p): p is Permission => (PERMISSIONS as readonly string[]).includes(p));
}

/**
 * The Architech HTTP API and the Podium (the one-screen view of goal, plan, live actions,
 * decisions waiting for you and the evidence behind every result).
 *
 *   POST /v1/runs                       start a run            { goal, autonomy?, inputs?, startUrl?, permissions?, composeOnly? }
 *   GET  /v1/runs                       list runs
 *   GET  /v1/runs/:id                   one run
 *   GET  /v1/runs/:id/events            server-sent events (replay + live)
 *   GET  /v1/runs/:id/evidence/:file    evidence file (screenshots)
 *   POST /v1/runs/:id/perform           perform a composed run
 *   POST /v1/runs/:id/recover           resume after a failure or handoff
 *   POST /v1/runs/:id/encore            rerun with new inputs  { inputs, autonomy? }
 *   POST /v1/runs/:id/cancel            cancel
 *   GET  /v1/approvals                  decisions waiting for a person
 *   POST /v1/approvals/:id              decide                 { approved, note?, by? }
 *   POST /v1/signals/:product           ecosystem trigger      { type, payload }
 */
export function createArchitechServer(opts: ServerOptions): Server {
  const { architech } = opts;
  const triggers = opts.triggers ?? new TriggerRouter();
  const library = opts.library ?? new ScoreLibrary(path.join(architech.store.root, "scores"));
  const schedules = opts.schedules ?? new ScheduleStore(architech.store.root);
  const background = (p: Promise<unknown>) => p.catch((err) => console.error("[architech]", err));

  const authorized = (req: IncomingMessage, url: URL) => {
    if (!opts.token) return true;
    const header = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token") ?? "";
    const a = Buffer.from(header);
    const b = Buffer.from(opts.token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/podium")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(await readFile(path.join(here, "..", "podium", "index.html"), "utf8"));
        return;
      }
      if (url.pathname === "/healthz") return json(res, 200, { ok: true, at: now() });
      if (parts[0] !== "v1") throw new HttpError(404, "not found");
      if (!authorized(req, url)) throw new HttpError(401, "missing or invalid bearer token");

      const [, resource, id, action, file] = parts;

      if (resource === "runs" && !id) {
        if (req.method === "GET") return json(res, 200, await architech.store.list(Number(url.searchParams.get("limit") ?? 50)));
        if (req.method === "POST") {
          const b = await body(req);
          const goal = String(b.goal ?? "").trim();
          if (!goal) throw new HttpError(400, "goal is required");
          const autonomy = (AUTONOMY.includes(b.autonomy as Autonomy) ? b.autonomy : "accompaniment") as Autonomy;
          const run = await architech.start(goal, {
            autonomy,
            inputs: stringMap(b.inputs),
            startUrl: b.startUrl ? String(b.startUrl) : undefined,
            permissions: permissions(b.permissions),
            budgetUsd: budget(b.budgetUsd),
          });
          if (!b.composeOnly) background(architech.perform(run));
          return json(res, 202, run);
        }
      }

      if (resource === "runs" && id) {
        if (req.method === "GET" && !action) return json(res, 200, await architech.store.load(id));
        if (req.method === "GET" && action === "events") return streamEvents(req, res, architech, id);
        if (req.method === "GET" && action === "evidence" && file) {
          if (!/^[\w.-]+\.png$/.test(file)) throw new HttpError(400, "bad evidence name");
          res.writeHead(200, { "content-type": "image/png" });
          res.end(await readFile(path.join(architech.store.runDir(id), "evidence", file)));
          return;
        }
        if (req.method === "POST") {
          const b = await body(req);
          if (action === "perform") {
            const run = await architech.store.load(id);
            if (run.status !== "composed") throw new HttpError(409, `run is ${run.status}`);
            background(architech.perform(run));
            return json(res, 202, { ok: true });
          }
          if (action === "recover") {
            if (architech.isActive(id)) throw new HttpError(409, "run is still performing");
            background(architech.recover(id, { budgetUsd: budget(b.budgetUsd) }));
            return json(res, 202, { ok: true });
          }
          if (action === "encore") {
            const autonomy = AUTONOMY.includes(b.autonomy as Autonomy) ? (b.autonomy as Autonomy) : undefined;
            background(architech.encore(id, stringMap(b.inputs), autonomy, budget(b.budgetUsd)));
            return json(res, 202, { ok: true });
          }
          if (action === "cancel") {
            architech.cancel(id);
            return json(res, 202, { ok: true });
          }
        }
      }

      if (resource === "scores") {
        if (req.method === "GET" && !id) return json(res, 200, await library.list());
        if (req.method === "GET" && id && !action) return json(res, 200, await library.get(id));
        if (req.method === "POST" && id === "import") return json(res, 201, await library.import(await body(req)));
        if (req.method === "POST" && !id) {
          const b = await body(req);
          const run = await architech.store.load(String(b.runId ?? ""));
          const saved = await library.save(String(b.name ?? ""), run.score, {
            description: b.description ? String(b.description) : undefined,
            author: b.author ? String(b.author) : undefined,
          });
          return json(res, 201, saved);
        }
        if (req.method === "POST" && id && action === "play") {
          const b = await body(req);
          const saved = await library.get(id);
          const run = await architech.prepare(saved.score, {
            inputs: stringMap(b.inputs),
            autonomy: AUTONOMY.includes(b.autonomy as Autonomy) ? (b.autonomy as Autonomy) : "accompaniment",
            budgetUsd: budget(b.budgetUsd),
            source: `score:${id}`,
          });
          background(architech.perform(run));
          return json(res, 202, run);
        }
        if (req.method === "DELETE" && id) {
          await library.remove(id);
          return json(res, 200, { ok: true });
        }
      }

      if (resource === "schedules") {
        if (req.method === "GET") return json(res, 200, await schedules.list());
        if (req.method === "POST" && !id) {
          const b = await body(req);
          const s = validateSchedule({
            name: String(b.name ?? ""),
            score: String(b.score ?? ""),
            everyMinutes: b.everyMinutes !== undefined ? Number(b.everyMinutes) : undefined,
            dailyAt: b.dailyAt ? String(b.dailyAt) : undefined,
            inputs: stringMap(b.inputs),
            autonomy: AUTONOMY.includes(b.autonomy as Autonomy) ? (b.autonomy as Autonomy) : undefined,
            budgetUsd: budget(b.budgetUsd),
            enabled: b.enabled === undefined ? true : b.enabled === true,
          });
          await library.get(s.score); // must exist
          await schedules.upsert(s);
          return json(res, 201, s);
        }
        if (req.method === "DELETE" && id) {
          await schedules.remove(id);
          return json(res, 200, { ok: true });
        }
      }

      if (resource === "approvals") {
        if (req.method === "GET" && !id) return json(res, 200, architech.pendingApprovals);
        if (req.method === "POST" && id) {
          const b = await body(req);
          const ok = architech.decide(id, {
            approved: b.approved === true,
            note: b.note ? String(b.note) : undefined,
            by: b.by ? String(b.by) : "api",
          });
          if (!ok) throw new HttpError(404, "no pending approval with that id");
          return json(res, 200, { ok: true });
        }
      }

      if (resource === "signals" && id && req.method === "POST") {
        const b = await body(req);
        const signal: Signal = {
          product: id,
          type: String(b.type ?? "event"),
          payload: (typeof b.payload === "object" && b.payload ? b.payload : {}) as Record<string, unknown>,
          receivedAt: now(),
        };
        const match = triggers.match(signal);
        if (!match) return json(res, 202, { accepted: true, started: false, reason: "no trigger rule matches" });
        const run = await architech.start(match.goal, {
          autonomy: match.autonomy ?? "accompaniment",
          permissions: match.permissions,
          startUrl: match.startUrl,
          trigger: signal,
        });
        background(architech.perform(run));
        return json(res, 202, { accepted: true, started: true, runId: run.id });
      }

      throw new HttpError(404, "not found");
    } catch (err) {
      const status =
        err instanceof HttpError ? err.status
        : err instanceof InputError || (err as Error)?.name === "ZodError" ? 400
        : err instanceof NotFoundError || (err as NodeJS.ErrnoException).code === "ENOENT" ? 404
        : 500;
      if (status === 500) console.error("[architech]", err);
      if (!res.headersSent) json(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  });
}

async function streamEvents(req: IncomingMessage, res: ServerResponse, architech: Architech, runId: string) {
  await architech.store.load(runId); // 404s if unknown
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (ev: RunEvent) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  for (const ev of await architech.store.events(runId)) send(ev);
  const listener = (ev: RunEvent) => ev.runId === runId && send(ev);
  architech.on("event", listener);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    architech.off("event", listener);
  });
}
