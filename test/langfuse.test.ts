import { afterEach, describe, expect, it, vi } from "vitest";
import { freeModel } from "../src/free.js";
import { langfuseFromEnv, tracedAI } from "../src/brains/ai-langfuse.mjs";

const KEYS = { LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test" };
const fakeAi = () => ({ run: async () => ({ response: "private reply", usage: { prompt_tokens: 3, completion_tokens: 2 } }) });

afterEach(() => vi.unstubAllGlobals());

describe("Langfuse tracing", () => {
  it("is off without keys, so the binding is returned unchanged", () => {
    const ai = fakeAi();
    expect(langfuseFromEnv({})).toBeNull();
    expect(tracedAI(ai, langfuseFromEnv({ ...KEYS, LANGFUSE: "off" }))).toBe(ai);
  });

  it("traces the free model endpoint: one v4 OTLP span, metadata only", async () => {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), init });
      return new Response("{}");
    });
    const waits: Promise<unknown>[] = [];
    const req = new Request("https://rchtch.app/free/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "private prompt" }] }) });
    const res = (await freeModel(req, { AI: fakeAi(), ...KEYS } as never, { waitUntil: (p) => waits.push(p) }))!;
    expect(res.status).toBe(200);
    await Promise.all(waits);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://cloud.langfuse.com/api/public/otel/v1/traces");
    expect((sent[0]!.init.headers as Record<string, string>)["x-langfuse-ingestion-version"]).toBe("4");
    const body = String(sent[0]!.init.body);
    expect(body).not.toMatch(/private prompt|private reply/);
    expect(body).toContain("architect-free");
    expect(body).toContain('{\\"input\\":3,\\"output\\":2,\\"total\\":5}');
  });

  it("never breaks the call when Langfuse is down", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("down"); });
    const waits: Promise<unknown>[] = [];
    const ai = tracedAI(fakeAi(), langfuseFromEnv(KEYS, { product: "architect" }), { waitUntil: (p) => waits.push(p) });
    expect((await ai.run("m", {})) as { response: string }).toMatchObject({ response: "private reply" });
    await expect(Promise.all(waits)).resolves.toBeDefined();
  });
});
