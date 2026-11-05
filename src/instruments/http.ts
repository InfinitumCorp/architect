import { truncate } from "../policy.js";
import type { Instrument, ToolOutput, ToolSpec } from "./types.js";

/** Direct API access, for services that have one. Cheaper and more reliable than driving their UI. */
export class HttpInstrument implements Instrument {
  name = "http";
  description = "Direct HTTP requests to public or configured APIs. Prefer this over the browser when an API exists.";

  tools: ToolSpec[] = [
    {
      name: "http_get",
      description: "HTTP GET a URL. Returns status and body (JSON or text).",
      input_schema: {
        type: "object",
        properties: { url: { type: "string" }, headers: { type: "object" } },
        required: ["url"],
      },
      permission: "http.read",
      risk: "read",
    },
    {
      name: "http_send",
      description: "Send an HTTP request with a body (POST, PUT, PATCH or DELETE).",
      input_schema: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["POST", "PUT", "PATCH", "DELETE"] },
          url: { type: "string" },
          headers: { type: "object" },
          body: { type: "string", description: "Request body; JSON as a string" },
        },
        required: ["method", "url"],
      },
      permission: "http.write",
      risk: (input) => (input.method === "DELETE" || input.method === "POST" ? "irreversible" : "write"),
    },
  ];

  async execute(tool: string, input: Record<string, unknown>): Promise<ToolOutput> {
    const url = new URL(String(input.url));
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only http(s) URLs are allowed");
    const headers = (input.headers ?? {}) as Record<string, string>;
    const res = await fetch(url, {
      method: tool === "http_get" ? "GET" : String(input.method),
      headers: tool === "http_send" && input.body ? { "content-type": "application/json", ...headers } : headers,
      body: tool === "http_send" ? (input.body as string | undefined) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    return { text: `HTTP ${res.status} ${res.statusText}\n${truncate(body, 20_000)}`, isError: !res.ok };
  }
}
