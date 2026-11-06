import { truncate } from "../policy.js";
import type { Instrument, ToolOutput, ToolSpec } from "./types.js";

/**
 * The Infinitum product catalog Architect can act through.
 * Each product exposes the Architect action contract:
 *
 *   GET  {baseUrl}/rchtct/v1/actions              -> [{ name, description, risk }]
 *   POST {baseUrl}/rchtct/v1/actions/{action}     -> body { runId, payload } ; returns JSON
 *
 * Products are configured with RCHTCT_PRODUCT_<KEY>_URL and RCHTCT_PRODUCT_<KEY>_TOKEN.
 */
export const INFINITUM_PRODUCTS: Record<string, { name: string; role: string }> = {
  scalvs: { name: "SCALVS.ai", role: "AI workforce: the intelligence behind every step" },
  spectre: { name: "+SPCTR (Spectre)", role: "Intelligent CRM: follow-ups, routing, renewal risk" },
  hrvst: { name: "[HRVST]", role: "Camera-glasses data exchange: field observations and faults" },
  metatron: { name: "METATRON¹⁰⁰", role: "Consumer command suite and prediction engine" },
  cumulus: { name: "Cumulus://Cloud", role: "AI cloud, storage and secure execution environments" },
  firmament: { name: "Firmament Network", role: "Blockchain trust layer: verified-outcome records" },
  veil: { name: "VEIL</>", role: "Tor-first secure browser with the Architect sidebar" },
  throne: { name: "#THRONE", role: "Infinitum hardware for local, on-premises runs" },
  fabric: { name: "FABRIC", role: "Secure communications and data economy" },
  eidetic: { name: "ei·det·ic", role: "Identity intelligence" },
  eon: { name: "E(O)N", role: "AI wearable for secure communications" },
  conjure: { name: "CONJURE", role: "Predictive simulation: rehearse a Score's stakeholder reactions" },
};

export interface ProductEndpoint {
  key: string;
  baseUrl: string;
  token?: string;
}

export function productsFromEnv(env: NodeJS.ProcessEnv = process.env): ProductEndpoint[] {
  return Object.keys(INFINITUM_PRODUCTS).flatMap((key) => {
    const baseUrl = env[`RCHTCT_PRODUCT_${key.toUpperCase()}_URL`];
    return baseUrl ? [{ key, baseUrl: baseUrl.replace(/\/$/, ""), token: env[`RCHTCT_PRODUCT_${key.toUpperCase()}_TOKEN`] }] : [];
  });
}

export class EcosystemInstrument implements Instrument {
  name = "ecosystem";
  description: string;
  private endpoints: Map<string, ProductEndpoint>;

  constructor(endpoints: ProductEndpoint[] = productsFromEnv()) {
    this.endpoints = new Map(endpoints.map((e) => [e.key, e]));
    const listed = endpoints.map((e) => `${e.key} (${INFINITUM_PRODUCTS[e.key]?.name})`).join(", ");
    this.description = `Other Infinitum products, through the Architect action contract. Connected: ${listed || "none yet"}.`;
  }

  get connected(): string[] {
    return [...this.endpoints.keys()];
  }

  tools: ToolSpec[] = [
    {
      name: "ecosystem_actions",
      description: "List the actions a connected Infinitum product offers.",
      input_schema: { type: "object", properties: { product: { type: "string" } }, required: ["product"] },
      permission: "ecosystem",
      risk: "read",
    },
    {
      name: "ecosystem_call",
      description: "Call an action on a connected Infinitum product with a JSON payload.",
      input_schema: {
        type: "object",
        properties: {
          product: { type: "string" },
          action: { type: "string" },
          payload: { type: "object" },
          irreversible: { type: "boolean", description: "True if the action sends, pays, deletes or publishes" },
        },
        required: ["product", "action"],
      },
      permission: "ecosystem",
      risk: (input) => (input.irreversible ? "irreversible" : "write"),
    },
  ];

  private endpoint(product: string): ProductEndpoint {
    const ep = this.endpoints.get(product);
    if (!ep) throw new Error(`product "${product}" is not connected; connected: ${this.connected.join(", ") || "none"}`);
    return ep;
  }

  async call(product: string, action: string, payload: unknown, runId: string): Promise<{ status: number; body: string }> {
    const ep = this.endpoint(product);
    const res = await fetch(`${ep.baseUrl}/rchtct/v1/actions/${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(ep.token ? { authorization: `Bearer ${ep.token}` } : {}) },
      body: JSON.stringify({ runId, payload: payload ?? {} }),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, body: await res.text() };
  }

  async execute(tool: string, input: Record<string, unknown>, ctx: { runId: string }): Promise<ToolOutput> {
    const product = String(input.product);
    if (tool === "ecosystem_actions") {
      const ep = this.endpoint(product);
      const res = await fetch(`${ep.baseUrl}/rchtct/v1/actions`, {
        headers: ep.token ? { authorization: `Bearer ${ep.token}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
      return { text: truncate(await res.text(), 10_000), isError: !res.ok };
    }
    const { status, body } = await this.call(product, String(input.action), input.payload, ctx.runId);
    return { text: `HTTP ${status}\n${truncate(body, 15_000)}`, isError: status >= 400 };
  }
}
