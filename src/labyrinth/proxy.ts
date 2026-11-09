import { secureLabyrinthEndpoint } from "./client.js";
/** Thin Worker/browser-compatible relay. Access JWTs/product tokens are NOT CID identities. */
export async function proxyLabyrinthRequest(request: Request, endpoint: string | undefined, product: string, fetcher: typeof fetch = fetch): Promise<Response> {
  const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
  if (!endpoint) return fail(503, "Labyrinth is not configured");
  if (request.method !== "POST") return fail(405, "POST required");
  const token = request.headers.get("authorization");
  if (!token || !/^Bearer [^\s]{1,512}$/.test(token)) return fail(401, "A Cumulus ID session bearer token is required");
  if (!request.headers.get("content-type")?.startsWith("application/json") || request.headers.get("x-labyrinth") !== "1") return fail(403, "Labyrinth JSON request header required");
  let url: string;
  try { url = secureLabyrinthEndpoint(endpoint); } catch { return fail(503, "Invalid Labyrinth service configuration"); }
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
    const upstream = await fetcher(url, { method: "POST", headers: { authorization: token, "content-type": "application/json", "x-labyrinth": "1" }, body: JSON.stringify({ ...body, product }), redirect: "error", signal: AbortSignal.timeout(10000) });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch { return fail(502, "Labyrinth service unavailable"); }
}
