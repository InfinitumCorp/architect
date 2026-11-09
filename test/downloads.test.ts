import { describe, expect, it } from "vitest";
import { publicDownload, uploadDownload, type DownloadBucket } from "../src/downloads.js";

function fakeBucket() {
  const objects = new Map<string, { data: Uint8Array; uploaded: Date }>();
  const uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  const bucket: DownloadBucket = {
    async get(key) {
      const o = objects.get(key);
      return o ? { body: new Response(o.data).body!, size: o.data.length, httpEtag: '"e"', uploaded: o.uploaded } : null;
    },
    async list() {
      return { objects: [...objects].map(([key, o]) => ({ key, size: o.data.length, uploaded: o.uploaded })) };
    },
    async createMultipartUpload(key) {
      const uploadId = `u${uploads.size + 1}`;
      uploads.set(uploadId, { key, parts: new Map() });
      return { uploadId };
    },
    resumeMultipartUpload(key, uploadId) {
      const up = uploads.get(uploadId)!;
      return {
        async uploadPart(partNumber, body) {
          up.parts.set(partNumber, new Uint8Array(body as ArrayBuffer));
          return { partNumber, etag: `p${partNumber}` };
        },
        async complete(parts) {
          const chunks = parts.map((p) => up.parts.get(p.partNumber)!);
          const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
          let at = 0;
          for (const c of chunks) all.set(c, (at += c.length) - c.length);
          objects.set(key, { data: all, uploaded: new Date() });
        },
      };
    },
  };
  return bucket;
}

const at = (path: string, init?: RequestInit) => new Request(`https://rchtch.app${path}`, init);

describe("desktop downloads", () => {
  it("uploads in parts and serves the joined file publicly", async () => {
    const bucket = fakeBucket();
    const start = await uploadDownload(at("/v1/downloads/App-1.zip/uploads", { method: "POST" }), bucket);
    const { uploadId } = (await start!.json()) as { uploadId: string };
    const parts = [];
    for (const [i, text] of ["hello ", "world"].entries()) {
      const r = await uploadDownload(at(`/v1/downloads/App-1.zip/uploads/${uploadId}/${i + 1}`, { method: "PUT", body: text }), bucket);
      parts.push(await r!.json());
    }
    const done = await uploadDownload(at(`/v1/downloads/App-1.zip/uploads/${uploadId}/complete`, { method: "POST", body: JSON.stringify({ parts }) }), bucket);
    expect(await done!.json()).toEqual({ ok: true, url: "/download/App-1.zip" });

    const file = (await publicDownload(at("/download/App-1.zip"), bucket))!;
    expect(file.headers.get("content-disposition")).toContain('filename="App-1.zip"');
    expect(file.headers.get("content-type")).toBe("application/zip");
    expect(await file.text()).toBe("hello world");
    const list = (await (await publicDownload(at("/download"), bucket))!.json()) as { files: Array<{ name: string }> };
    expect(list.files.map((f) => f.name)).toEqual(["App-1.zip"]);
  });

  it("ignores other paths and rejects bad names", async () => {
    const bucket = fakeBucket();
    expect(await publicDownload(at("/v1/runs"), bucket)).toBeUndefined();
    expect(await uploadDownload(at("/v1/runs"), bucket)).toBeUndefined();
    expect((await publicDownload(at("/download/..%2Fsecret"), bucket))!.status).toBe(400);
    expect((await publicDownload(at("/download/missing.zip"), bucket))!.status).toBe(404);
    expect((await publicDownload(at("/download/x.zip", { method: "POST" }), bucket))!.status).toBe(405);
    expect((await publicDownload(at("/download"), undefined))!.status).toBe(503);
  });
});
