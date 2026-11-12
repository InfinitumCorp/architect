import { describe, expect, it } from "vitest";
// @ts-ignore plain browser module served from web/
import { REVENUE_URL, businessOnly, currentPlanId, formatPrice, loadEntitlement, loadPlans, openPortal, readReturn, startCheckout } from "../web/billing.js";

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

const PRO = { id: "cndctr_pro", product: "cndctr", name: "Pro", channel: "self_serve", priceCents: 3900, interval: "month", perSeat: false, trialDays: 14, allowedKinds: ["individual", "business"] };
const BIZ = { id: "cndctr_business", product: "cndctr", name: "Business", channel: "self_serve", priceCents: 9900, interval: "month", perSeat: true, allowedKinds: ["business"] };

describe("web app billing (Cumulus ID)", () => {
  it("lists only :\ARCHITECT\ plans from the catalog, cheapest first, never contract plans", async () => {
    const api = fakeRevenue({ "/v1/catalog": [200, { plans: [BIZ, { ...PRO, id: "x", product: "scalvs" }, PRO, { ...PRO, id: "c", channel: "contract" }] }] });
    expect((await loadPlans({ fetch: api.fetch })).map((p: any) => p.id)).toEqual(["cndctr_pro", "cndctr_business"]);
  });

  it("opens Checkout with the Cumulus ID token and returns to rchtch.app", async () => {
    const api = fakeRevenue({ "/v1/subscriptions/checkout": [200, { url: "https://checkout.stripe.com/c/cs_1" }] });
    const url = await startCheckout({ plan: PRO, origin: "https://rchtch.app", token: "cid-token", fetch: api.fetch });
    expect(url).toBe("https://checkout.stripe.com/c/cs_1");
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ auth: "Bearer cid-token", body: { planId: "cndctr_pro", returnUrl: "https://rchtch.app/" } });
  });

  it("switches to a business org and sends seats for Business", async () => {
    const api = fakeRevenue({ "/v1/me/org": [200, { kind: "business" }], "/v1/subscriptions/checkout": [200, { url: "https://checkout.stripe.com/c/cs_2" }] });
    await startCheckout({ plan: BIZ, seats: "3", orgName: "Acme", origin: "https://rchtch.app", token: "t", fetch: api.fetch });
    expect(api.calls[0]).toMatchObject({ path: "/v1/me/org", body: { kind: "business", name: "Acme" } });
    expect(api.calls[1].body).toMatchObject({ planId: "cndctr_business", quantity: 3 });
    expect(businessOnly(BIZ)).toBe(true);
    expect(businessOnly(PRO)).toBe(false);
  });

  it("needs a signed-in Cumulus ID and a paid plan", async () => {
    const api = fakeRevenue({});
    await expect(startCheckout({ plan: PRO, origin: "https://rchtch.app", token: "", fetch: api.fetch })).rejects.toMatchObject({ code: "signed_out" });
    await expect(startCheckout({ plan: { ...PRO, priceCents: 0 }, origin: "https://rchtch.app", token: "t", fetch: api.fetch })).rejects.toMatchObject({ code: "bad_plan" });
    await expect(openPortal({ origin: "https://rchtch.app", token: "", fetch: api.fetch })).rejects.toMatchObject({ code: "signed_out" });
    expect(api.calls).toHaveLength(0);
  });

  it("reads the current plan, the portal and the Stripe return flag", async () => {
    const api = fakeRevenue({
      "/v1/me/entitlements": [200, { products: [{ product: "cndctr", plan: "cndctr_pro", status: "trialing" }] }],
      "/v1/billing/portal": [200, { url: "https://billing.stripe.com/p/1" }],
    });
    const ent = await loadEntitlement({ token: "t", fetch: api.fetch });
    expect(currentPlanId(ent)).toBe("cndctr_pro");
    expect(currentPlanId({ plan: "cndctr_pro", status: "canceled" })).toBe("cndctr_free");
    expect(currentPlanId(null)).toBe("cndctr_free");
    expect(await openPortal({ origin: "https://rchtch.app", token: "t", fetch: api.fetch })).toBe("https://billing.stripe.com/p/1");
    expect(readReturn("?billing=success&session_id=cs_1")).toBe("success");
    expect(readReturn("?billing=cancelled")).toBe("cancelled");
    expect(readReturn("?x=1")).toBeNull();
    expect(formatPrice(BIZ)).toBe("$99 / seat / month");
    expect(formatPrice(PRO)).toBe("$39 / month · 14-day trial");
  });
});
