/**
 * Public downloads (Architect Desktop builds) from the R2 bucket bound as DOWNLOADS.
 *
 *   GET  /download                                     JSON list of files, newest first
 *   GET  /download/<file>                              the file (attachment)
 *   POST /v1/downloads/<file>/uploads                  start a multipart upload  -> { uploadId }
 *   PUT  /v1/downloads/<file>/uploads/<id>/<part>      upload one part (body)    -> { partNumber, etag }
 *   POST /v1/downloads/<file>/uploads/<id>/complete    { parts: [{ partNumber, etag }] }
 *
 * Uploads go in parts so a large build survives a slow or flaky connection; the /v1 routes
 * sit behind the API token like the rest of the API.
 */

/** The part of the R2 bucket API this module uses. */
export interface DownloadBucket {
  get(key: string): Promise<{ body: ReadableStream; size: number; httpEtag: string; uploaded: Date } | null>;
  list(opts?: { limit?: number }): Promise<{ objects: Array<{ key: string; size: number; uploaded: Date }> }>;
  createMultipartUpload(key: string, opts?: { httpMetadata?: { contentType?: string } }): Promise<{ uploadId: string }>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): {
    uploadPart(partNumber: number, body: ReadableStream | ArrayBuffer): Promise<{ partNumber: number; etag: string }>;
    complete(parts: Array<{ partNumber: number; etag: string }>): Promise<unknown>;
  };
}

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const TYPES: Record<string, string> = { zip: "application/zip", dmg: "application/x-apple-diskimage", gz: "application/gzip", exe: "application/vnd.microsoft.portable-executable" };
const typeOf = (name: string) => TYPES[name.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

/** GET /download and /download/<file>; returns undefined for other paths. */
export async function publicDownload(req: Request, bucket: DownloadBucket | undefined): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (url.pathname !== "/download" && !url.pathname.startsWith("/download/")) return undefined;
  if (req.method !== "GET" && req.method !== "HEAD") return json(405, { error: "GET only" });
  if (!bucket) return json(503, { error: "Downloads are not configured." });
  const name = decodeURIComponent(url.pathname.slice("/download/".length));
  if (url.pathname === "/download" || !name) {
    const { objects } = await bucket.list({ limit: 100 });
    const files = objects
      .filter((o) => FILE.test(o.key))
      .sort((a, b) => +new Date(b.uploaded) - +new Date(a.uploaded))
      .map((o) => ({ name: o.key, size: o.size, uploaded: new Date(o.uploaded).toISOString(), url: `/download/${encodeURIComponent(o.key)}` }));
    return json(200, { files });
  }
  if (!FILE.test(name)) return json(400, { error: "bad file name" });
  const obj = await bucket.get(name);
  if (!obj) return json(404, { error: "no such download" });
  return new Response(req.method === "HEAD" ? null : obj.body, {
    headers: {
      "content-type": typeOf(name),
      "content-length": String(obj.size),
      "content-disposition": `attachment; filename="${name}"`,
      etag: obj.httpEtag,
      "cache-control": "public, max-age=300",
    },
  });
}

/** The token-protected multipart upload routes under /v1/downloads; undefined for other paths. */
export async function uploadDownload(req: Request, bucket: DownloadBucket | undefined): Promise<Response | undefined> {
  const m = new URL(req.url).pathname.match(/^\/v1\/downloads\/([^/]+)\/uploads(?:\/([^/]+)(?:\/(\d+|complete))?)?$/);
  if (!m) return undefined;
  if (!bucket) return json(503, { error: "Downloads are not configured." });
  const name = decodeURIComponent(m[1]!);
  if (!FILE.test(name)) return json(400, { error: "bad file name" });
  const [, , id, step] = m;
  if (!id && req.method === "POST") {
    const up = await bucket.createMultipartUpload(name, { httpMetadata: { contentType: typeOf(name) } });
    return json(201, { uploadId: up.uploadId });
  }
  if (id && step && /^\d+$/.test(step) && req.method === "PUT") {
    const part = Number(step);
    if (part < 1 || part > 10_000) return json(400, { error: "part must be 1-10000" });
    const done = await bucket.resumeMultipartUpload(name, decodeURIComponent(id)).uploadPart(part, await req.arrayBuffer());
    return json(200, { partNumber: done.partNumber, etag: done.etag });
  }
  if (id && step === "complete" && req.method === "POST") {
    const { parts } = (await req.json()) as { parts?: Array<{ partNumber: number; etag: string }> };
    if (!Array.isArray(parts) || !parts.length) return json(400, { error: "parts required" });
    await bucket.resumeMultipartUpload(name, decodeURIComponent(id)).complete(parts.sort((a, b) => a.partNumber - b.partNumber));
    return json(200, { ok: true, url: `/download/${encodeURIComponent(name)}` });
  }
  return json(405, { error: "method not allowed" });
}
