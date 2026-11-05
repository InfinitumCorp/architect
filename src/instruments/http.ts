import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { truncate } from "../policy.js";
import type { Instrument, ToolOutput, ToolSpec } from "./types.js";

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    n = n * 256 + value;
  }
  return n >>> 0;
}

function inV4Range(ip: number, base: string, bits: number): boolean {
  const start = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (start & mask);
}

/** True for loopback, link-local, private, and IPv4-mapped forms of those. */
export function isBlockedAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice("::ffff:".length);
    if (isIP(mapped) === 4) ip = mapped;
  }
  if (isIP(ip) === 6) {
    if (ip === "::" || ip === "::1") return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
    if (/^fe[89ab]/.test(ip)) return true;
    return false;
  }
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return BLOCKED_V4.some(([base, bits]) => inV4Range(n, base, bits));
}

function isBlockedName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name.endsWith(".local") ||
    name === "metadata.google.internal"
  );
}

/** Refuse non-http(s), credentialed, and private or link-local targets. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs are allowed");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || isBlockedName(host)) throw new Error(`host ${url.hostname} is not allowed`);
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw new Error(`host ${url.hostname} is not allowed`);
  return url;
}

async function fetchPublic(start: URL, init: RequestInit): Promise<Response> {
  let url = start;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    if (!location) throw new Error("redirect without a location");
    url = await assertPublicUrl(new URL(location, url).toString());
  }
  throw new Error("too many redirects");
}

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
    const url = await assertPublicUrl(String(input.url));
    const headers = { ...((input.headers ?? {}) as Record<string, string>) };
    delete headers.host;
    delete headers.Host;
    const res = await fetchPublic(url, {
      method: tool === "http_get" ? "GET" : String(input.method),
      headers: tool === "http_send" && input.body ? { "content-type": "application/json", ...headers } : headers,
      body: tool === "http_send" ? (input.body as string | undefined) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await res.text();
    return { text: `HTTP ${res.status} ${res.statusText}\n${truncate(body, 20_000)}`, isError: !res.ok };
  }
}
