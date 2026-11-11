import { describe, expect, it } from "vitest";
import { proxyLabyrinthRequest } from "../src/labyrinth/proxy.js";

// Cloudflare Workers' fetch throws on redirect: "error" (only "follow" and "manual" are allowed).
const workerd = (reply: () => Response) => (async (_url: string | URL | Request, init?: RequestInit) => {
  if (init?.redirect !== "follow" && init?.redirect !== "manual") throw new TypeError("Invalid redirect value");
  return reply();
}) as typeof fetch;
const make = () => new Request("https://rchtch.app/api/labyrinth", { method: "POST", headers: { authorization: "Bearer real-session", "content-type": "application/json", "x-labyrinth": "1" }, body: JSON.stringify({ action: "list" }) });
const endpoint = "https://lbrnth.example/api/labyrinth";

describe("Labyrinth relay on Cloudflare Workers", () => {
  it("reaches the host and passes its status through", async () => {
    expect((await proxyLabyrinthRequest(make(), endpoint, "architect", workerd(() => Response.json([])))).status).toBe(200);
    expect((await proxyLabyrinthRequest(make(), endpoint, "architect", workerd(() => Response.json({ error: "no" }, { status: 401 })))).status).toBe(401);
  });
  it("never follows a redirect", async () => {
    const r = await proxyLabyrinthRequest(make(), endpoint, "architect", workerd(() => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })));
    expect(r.status).toBe(502);
    expect(r.headers.get("location")).toBeNull();
  });
});
