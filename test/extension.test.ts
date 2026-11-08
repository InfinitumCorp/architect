import path from "node:path";
import { describe, expect, it } from "vitest";
// Plain browser JS from the extension; imported as-is.
import { ApiError, createClient, draftFrom, readResponse, runRequest } from "../extension/src/api.js";
import { checkManifest } from "../scripts/extension-check.mjs";

const jsonRes = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

describe("extension manifest", () => {
  it("is a valid MV3 package with every referenced file and no secrets", async () => {
    expect(await checkManifest(path.resolve("extension"))).toEqual([]);
  });
});

describe("extension API client", () => {
  it("treats a Cloudflare Access redirect as 'sign in'", async () => {
    const opaque = { type: "opaqueredirect", status: 0, headers: new Headers() } as unknown as Response;
    await expect(readResponse(opaque)).rejects.toMatchObject({ kind: "signin" });
    const loginPage = new Response("<html>Sign in</html>", { status: 200, headers: { "content-type": "text/html" } });
    await expect(readResponse(loginPage)).rejects.toMatchObject({ kind: "signin" });
  });

  it("maps 401 to 'token' and the unconfigured server to 'server'", async () => {
    await expect(readResponse(jsonRes(401, { error: "missing or invalid bearer token" }))).rejects.toMatchObject({ kind: "token" });
    await expect(readResponse(jsonRes(503, { error: "The server has no ARCHITECT_API_TOKEN secret yet." }))).rejects.toMatchObject({ kind: "server" });
    await expect(readResponse(jsonRes(409, { error: "run is performing" }))).rejects.toThrow("run is performing");
  });

  it("sends the bearer token, the Access cookie and no redirects", async () => {
    const calls: [string, RequestInit][] = [];
    const client = createClient({
      token: "t0k",
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push([url, init]);
        return jsonRes(202, { id: "run_1", status: "composing" });
      },
    });
    const run = await client.start({ goal: "  Book a table  ", autonomy: "bogus", startUrl: "https://example.com/" });
    expect(run.id).toBe("run_1");
    const [url, init] = calls[0];
    expect(url).toBe("https://rchtch.app/v1/runs");
    expect(init.credentials).toBe("include");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer t0k");
    expect(JSON.parse(String(init.body))).toEqual({ goal: "Book a table", autonomy: "accompaniment", startUrl: "https://example.com/" });
  });

  it("reports network failures as such", async () => {
    const client = createClient({ fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    await expect(client.runs()).rejects.toMatchObject({ kind: "network" });
  });

  it("validates run requests", () => {
    expect(() => runRequest({ goal: " " })).toThrow(ApiError);
    expect(() => runRequest({ goal: "x", startUrl: "javascript:alert(1)" })).toThrow(/http/);
    expect(runRequest({ goal: "x", autonomy: "autopilot" })).toEqual({ goal: "x", autonomy: "autopilot" });
  });

  it("drafts goals from the context menu", () => {
    expect(draftFrom({ selection: "Summarise this", pageUrl: "https://a.test/p", pageTitle: "P" })).toEqual({
      goal: 'Summarise this\n\n(Selected on "P" https://a.test/p)',
      startUrl: "https://a.test/p",
    });
    expect(draftFrom({ pageUrl: "https://a.test/p", pageTitle: "P" })).toEqual({ goal: 'Work on this page: "P".', startUrl: "https://a.test/p" });
  });
});
