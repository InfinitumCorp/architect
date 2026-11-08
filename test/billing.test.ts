import { describe, expect, it } from "vitest";
// @ts-ignore plain browser module served from podium/
import { REVENUE_URL, openPortal, planFromEntitlements, readReturn, startUpgrade, syncPlan } from "../podium/billing.js";

function fakeRevenue(routes: Record<string, [number, unknown]>) {
  const calls: { path: string; auth?: string; body?: any }[] = [];
  const fetch = async (url: string, init: any = {}) => {
    const path = url.slice(REVENUE_URL.length);
    calls.push({ path, auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    const [status, body] = routes[path] ?? [404, { error: { code: "not_found", message: "nope" } }];
    return Response.json(body, { status });
  };
  return { calls, fetch };
}

describe("Podium billing", () => {
  it("creates a billing org once and opens Checkout back to rchtch.app", async () => {
    const api = fakeRevenue({
      "/v1/signup": [201, { orgId: "org_1", apiKey: "ik_1" }],
      "/v1/subscriptions/checkout": [200, { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" }],
    });
    const r = await startUpgrade({ billing: null, planId: "pro", email: "ada@x.test", origin: "https://rchtch.app", fetch: api.fetch });
    expect(r).toEqual({ billing: { orgId: "org_1", apiKey: "ik_1", email: "ada@x.test" }, url: "https://checkout.stripe.com/c/cs_1" });
    expect(api.calls[0].body).toEqual({ name: "ada@x.test", email: "ada@x.test", kind: "individual" });
    expect(api.calls[1]).toMatchObject({ auth: "Bearer ik_1", body: { planId: "cndctr_pro", returnUrl: "https://rchtch.app/" } });

    await startUpgrade({ billing: r.billing, planId: "business", origin: "https://rchtch.app", fetch: api.fetch });
    expect(api.calls.filter((c) => c.path === "/v1/signup")).toHaveLength(1);
    expect(api.calls.at(-1)!.body.planId).toBe("cndctr_business");
  });

  it("requires an email, rejects Free checkout and surfaces API errors", async () => {
    const api = fakeRevenue({ "/v1/subscriptions/checkout": [409, { error: { code: "already_subscribed", message: "Already subscribed." } }] });
    await expect(startUpgrade({ billing: null, planId: "pro", email: "x", origin: "https://rchtch.app", fetch: api.fetch })).rejects.toMatchObject({ code: "email_required" });
    await expect(startUpgrade({ billing: { apiKey: "ik" }, planId: "free", origin: "https://rchtch.app", fetch: api.fetch })).rejects.toMatchObject({ code: "bad_plan" });
    await expect(startUpgrade({ billing: { apiKey: "ik" }, planId: "pro", origin: "https://rchtch.app", fetch: api.fetch })).rejects.toMatchObject({ code: "already_subscribed" });
    await expect(syncPlan({ billing: { apiKey: "ik" }, fetch: async () => { throw new TypeError("offline"); } })).rejects.toMatchObject({ code: "network" });
    await expect(openPortal({ billing: null, origin: "https://rchtch.app", fetch: api.fetch })).rejects.toMatchObject({ code: "no_account" });
  });

  it("maps entitlements and reads the Stripe return flag", async () => {
    const ent = (plan: string, status: string) => ({ products: [{ product: "cndctr", plan, status }] });
    expect(planFromEntitlements(ent("cndctr_pro", "trialing"))).toBe("pro");
    expect(planFromEntitlements(ent("cndctr_business", "active"))).toBe("business");
    expect(planFromEntitlements(ent("cndctr_pro", "canceled"))).toBe("free");
    expect(planFromEntitlements({ products: [{ product: "scalvs", plan: "scalvs_pro", status: "active" }] })).toBe("free");

    const api = fakeRevenue({
      "/v1/me/entitlements": [200, ent("cndctr_pro", "active")],
      "/v1/billing/portal": [200, { url: "https://billing.stripe.com/p/1" }],
    });
    expect(await syncPlan({ billing: { apiKey: "ik" }, fetch: api.fetch })).toBe("pro");
    expect(await openPortal({ billing: { apiKey: "ik" }, origin: "https://rchtch.app", fetch: api.fetch })).toBe("https://billing.stripe.com/p/1");
    expect(readReturn("?billing=success&session_id=cs_1")).toBe("success");
    expect(readReturn("?billing=nope")).toBeNull();
  });
});
