/**
 * architct/adapter — let an Infinitum product be played by Architect.
 *
 *   import { createActionHandler } from "architct/adapter";
 *
 *   const architct = createActionHandler({
 *     token: process.env.ARCHITCT_PRODUCT_TOKEN,
 *     actions: {
 *       find_account: { description: "Look up an account by name", risk: "read",
 *                       run: async ({ name }) => crm.find(String(name)) },
 *       draft_followup: { description: "Draft a follow-up email (not sent)", risk: "write",
 *                         run: async (p) => crm.draft(p) },
 *     },
 *   });
 *
 *   http.createServer(async (req, res) => { if (await architct(req, res)) return; ...your app... });
 *
 * Implements the Architect action contract:
 *   GET  /architct/v1/actions            -> [{ name, description, risk }]
 *   POST /architct/v1/actions/{action}   <- { runId, payload } -> JSON result
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Risk } from "./types.js";

export interface ProductAction {
  description: string;
  risk: Risk;
  run(payload: Record<string, unknown>, ctx: { runId: string }): Promise<unknown> | unknown;
}

export interface ActionHandlerOptions {
  actions: Record<string, ProductAction>;
  /** Bearer token Architect must present. Strongly recommended. */
  token?: string;
  /** Path prefix (default "/architct/v1"). */
  basePath?: string;
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("body too large");
  }
  const parsed = raw ? JSON.parse(raw) : {};
  return typeof parsed === "object" && parsed && !Array.isArray(parsed) ? parsed : {};
}

/** Returns true when it handled the request, false when the path is not part of the contract. */
export function createActionHandler(opts: ActionHandlerOptions) {
  const base = (opts.basePath ?? "/architct/v1").replace(/\/$/, "");
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(`${base}/actions`)) return false;

    if (opts.token) {
      const got = Buffer.from(req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "");
      const want = Buffer.from(opts.token);
      if (got.length !== want.length || !timingSafeEqual(got, want)) {
        send(res, 401, { error: "invalid token" });
        return true;
      }
    }

    const name = decodeURIComponent(url.pathname.slice(`${base}/actions`.length).replace(/^\//, ""));
    if (req.method === "GET" && !name) {
      send(res, 200, Object.entries(opts.actions).map(([n, a]) => ({ name: n, description: a.description, risk: a.risk })));
      return true;
    }
    if (req.method === "POST" && name) {
      const action = Object.hasOwn(opts.actions, name) ? opts.actions[name] : undefined;
      if (!action) {
        send(res, 404, { error: `no action "${name}"` });
        return true;
      }
      try {
        const body = await readJson(req);
        const payload = (typeof body.payload === "object" && body.payload ? body.payload : {}) as Record<string, unknown>;
        const result = await action.run(payload, { runId: String(body.runId ?? "") });
        send(res, 200, { ok: true, result });
      } catch (err) {
        send(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }
    send(res, 405, { error: "method not allowed" });
    return true;
  };
}
