import type { IncomingMessage, ServerResponse } from "node:http";
import { proxyLabyrinthRequest } from "./proxy.js";
/** Explicit user-selected artifact transport only; never auto-exports product records. */
export async function serveNodeLabyrinthProxy(req: IncomingMessage, res: ServerResponse, endpoint: string | undefined, product: string): Promise<void> {
  const fail = (status: number) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: "Labyrinth request denied or not configured" })); };
  if (!endpoint) return fail(503);
  if (req.method !== "POST") return fail(405);
  if (!/^Bearer [^\s]{1,512}$/.test(req.headers.authorization ?? "")) return fail(401);
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { length += Buffer.byteLength(chunk); if (length > 2 * 1024 * 1024) return fail(413); chunks.push(Buffer.from(chunk)); }
  const headers = new Headers();
  for (const key of ["authorization", "content-type", "x-labyrinth"]) { const value = req.headers[key]; if (typeof value === "string") headers.set(key, value); }
  const response = await proxyLabyrinthRequest(new Request("https://product.invalid/api/labyrinth", { method: "POST", headers, body: Buffer.concat(chunks).toString("utf8") }), endpoint, product);
  res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
}
