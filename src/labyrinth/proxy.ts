import { labyrinthEndpointFor, secureLabyrinthEndpoint } from "./client.js";
/** A Workers service binding (env.X with a fetch method). */
export interface LabyrinthServiceBinding { fetch(input: string | Request, init?: RequestInit): Promise<Response> }
const serviceBindings = new Map<string, LabyrinthServiceBinding>();

/**
 * Sends relay calls for `host` through a Workers service binding instead of the public internet,
 * e.g. lbrnth-us.cumuluscloud.app -> env.LBRNTH_US (Worker lbrnth-host-us). The call stays inside
 * Cloudflare, so Cloudflare Access on the public hostname never applies. Call it on every request
 * (bindings come from that request's env); an undefined binding removes the route.
 */
export function useLabyrinthServiceBinding(host: string, binding: LabyrinthServiceBinding | undefined): void {
  const key = host.toLowerCase();
  if (binding) serviceBindings.set(key, binding); else serviceBindings.delete(key);
}

/** Thin Worker/browser-compatible relay. Access JWTs/product tokens are NOT CID identities. */
export async function proxyLabyrinthRequest(request: Request, endpoint: string | undefined, product: string, fetcher?: typeof fetch): Promise<Response> {
  const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
  if (!endpoint) return fail(503, "Labyrinth is not configured");
  if (request.method !== "POST") return fail(405, "POST required");
  const token = request.headers.get("authorization");
  if (!token || !/^Bearer [^\s]{1,512}$/.test(token)) return fail(401, "A Cumulus ID session bearer token is required");
  if (!request.headers.get("content-type")?.startsWith("application/json") || request.headers.get("x-labyrinth") !== "1") return fail(403, "Labyrinth JSON request header required");
  let url: string;
  try {
    const chosen = labyrinthEndpointFor(endpoint, request.headers.get("cf-ipcountry"));
    if (!chosen) return fail(503, "Labyrinth is not configured");
    url = secureLabyrinthEndpoint(chosen);
  } catch { return fail(503, "Invalid Labyrinth service configuration"); }
  try {
    const reader = request.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); return fail(413, "Request too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "Invalid command");
    const binding = serviceBindings.get(new URL(url).host.toLowerCase());
    const send: typeof fetch = fetcher ?? (binding ? ((input, init) => binding.fetch(input as string, init)) as typeof fetch : fetch);
    const upstream = await send(url, { method: "POST", headers: { authorization: token, "content-type": "application/json", "x-labyrinth": "1" }, body: JSON.stringify({ ...body, product }), redirect: "manual", signal: AbortSignal.timeout(10000) });
    // Workers reject redirect: "error", so redirects are refused here instead of followed.
    if (upstream.type === "opaqueredirect" || (upstream.status >= 300 && upstream.status < 400)) { await upstream.body?.cancel(); return fail(502, "Labyrinth service unavailable"); }
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch { return fail(502, "Labyrinth service unavailable"); }
}
