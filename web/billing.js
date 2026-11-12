// @ts-nocheck (plain browser module)
// :\ARCHITECT\ plans and payments through the Infinitum revenue API (Stripe Checkout and the
// Stripe customer portal). The web app never sees card details or Stripe keys: it keeps this
// browser's billing-org API key, which only manages that org's own subscription.
//
//   <architect-plan></architect-plan>   (styles live in index.html, no inline styles here)

export const REVENUE_URL = "https://infinitum-revenue.infinitumcorp.workers.dev";
const STORE_KEY = "architect.billing.v1";

/** :\ARCHITECT\ plans. Prices are the revenue catalog's (ARCHITECT is "cndctr" there). */
export const PLANS = {
  free: { label: "Free", revenue: "cndctr_free", price: "$0", detail: "50 execution credits a month" },
  pro: { label: "Pro", revenue: "cndctr_pro", price: "$39 / month · 14-day trial", detail: "500 credits, 20 verified outcomes, Autopilot" },
  business: { label: "Business", revenue: "cndctr_business", price: "$99 / seat / month", detail: "2,000 credits, standing permissions, SSO" },
};
const FROM_REVENUE = Object.fromEntries(Object.entries(PLANS).map(([id, p]) => [p.revenue, id]));
const PAID = new Set(["trialing", "active", "past_due", "bundled"]);

export class BillingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call(fetchFn, method, path, { key, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key) headers.authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetchFn(`${REVENUE_URL}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new BillingError(0, "network", "Billing is unreachable. Check your connection and try again.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new BillingError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? "Billing request failed.");
  return json;
}

export const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email ?? "").trim());

/** Plan from revenue entitlements. An unpaid subscription falls back to Free. */
export function planFromEntitlements(ent) {
  const p = ent?.products?.find((x) => x.product === "cndctr");
  if (!p || (p.plan !== "cndctr_free" && !PAID.has(p.status))) return "free";
  return FROM_REVENUE[p.plan] ?? "free";
}

export const returnUrl = (origin) => `${origin}/`;

/** Stripe Checkout for Pro or Business; creates the billing org on first use. */
export async function startUpgrade({ billing, planId, email, origin, fetch: fetchFn = globalThis.fetch }) {
  if (planId === "free" || !PLANS[planId]) throw new BillingError(400, "bad_plan", "Choose Pro or Business.");
  let b = billing;
  if (!b?.apiKey) {
    if (!validEmail(email)) throw new BillingError(400, "email_required", "Enter a billing email to continue.");
    const clean = email.trim();
    const org = await call(fetchFn, "POST", "/v1/signup", {
      body: { name: clean, email: clean, kind: planId === "business" ? "business" : "individual" },
    });
    b = { orgId: org.orgId, apiKey: org.apiKey, email: clean };
  }
  const session = await call(fetchFn, "POST", "/v1/subscriptions/checkout", {
    key: b.apiKey, body: { planId: PLANS[planId].revenue, returnUrl: returnUrl(origin) },
  });
  return { billing: b, url: session.url };
}

export async function openPortal({ billing, origin, fetch: fetchFn = globalThis.fetch }) {
  if (!billing?.apiKey) throw new BillingError(400, "no_account", "No billing account yet.");
  return (await call(fetchFn, "POST", "/v1/billing/portal", { key: billing.apiKey, body: { returnUrl: returnUrl(origin) } })).url;
}

export async function syncPlan({ billing, fetch: fetchFn = globalThis.fetch }) {
  if (!billing?.apiKey) return "free";
  return planFromEntitlements(await call(fetchFn, "GET", "/v1/me/entitlements", { key: billing.apiKey }));
}

export function readReturn(search) {
  const v = new URLSearchParams(search).get("billing");
  return v === "success" || v === "cancelled" ? v : null;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null") ?? {}; } catch { return {}; }
}
function save(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* storage blocked: session only */ }
}

if (typeof customElements !== "undefined" && !customElements.get("architect-plan")) {
  customElements.define("architect-plan", class extends HTMLElement {
    connectedCallback() {
      this.data = load(); // { billing, plan }
      this.email = "";
      this.busy = false;
      this.note = "";
      const back = readReturn(location.search);
      if (back || location.search.includes("session_id=")) {
        history.replaceState(null, "", location.pathname + location.hash);
        this.note = back === "success" ? "Payment complete. Your plan will update in a moment."
          : back === "cancelled" ? "Checkout cancelled. No charge was made." : "";
      }
      this.addEventListener("input", (e) => { if (e.target.name === "billing-email") this.email = e.target.value; });
      this.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-plan], button[data-portal]");
        if (btn) btn.dataset.portal !== undefined ? this.portal() : this.choose(btn.dataset.plan);
      });
      this.render();
      this.refresh(back === "success" ? 5 : 1);
    }

    get plan() { return this.data.plan ?? "free"; }

    async refresh(attempts) {
      if (!this.data.billing?.apiKey) return;
      for (let i = 0; i < attempts; i++) {
        try {
          const next = await syncPlan({ billing: this.data.billing });
          if (next !== this.plan) { this.data.plan = next; save(this.data); this.render(); }
          if (next !== "free" || i === attempts - 1) return;
        } catch { return; }
        await new Promise((r) => setTimeout(r, 2000)); // the Stripe webhook may land just after the redirect
      }
    }

    async choose(id) {
      if (this.busy || id === this.plan) return;
      if (id === "free" || (this.data.billing?.apiKey && this.plan !== "free")) return this.portal();
      this.busy = true; this.note = ""; this.render();
      try {
        const { billing, url } = await startUpgrade({ billing: this.data.billing, planId: id, email: this.email, origin: location.origin });
        this.data.billing = billing; save(this.data);
        location.assign(url);
      } catch (err) {
        this.note = err.message;
      }
      this.busy = false; this.render();
      if (this.note && !this.data.billing?.apiKey) this.querySelector('[name="billing-email"]')?.focus();
    }

    async portal() {
      try { location.assign(await openPortal({ billing: this.data.billing, origin: location.origin })); }
      catch (err) { this.note = err.code === "no_account" ? "You are on the Free plan." : err.message; this.render(); }
    }

    render() {
      const b = this.data.billing;
      this.innerHTML = `
        <h2 class="runs-title">Plan</h2>
        <div class="plan-list">${Object.entries(PLANS).map(([id, p]) => `
          <button type="button" class="plan-option${id === this.plan ? " current" : ""}" data-plan="${id}" aria-pressed="${id === this.plan}" ${this.busy ? "disabled" : ""}>
            <span class="plan-name">${p.label}${id === this.plan ? " · current" : ""}</span>
            <span class="plan-price">${p.price}</span>
            <span class="plan-detail">${p.detail}</span>
          </button>`).join("")}
        </div>
        ${b?.apiKey
          ? `<p class="plan-meta">Billing email: ${esc(b.email)}${this.plan !== "free" ? ' · <button type="button" class="link" data-portal>Manage billing</button>' : ""}</p>`
          : `<label class="label" for="billing-email">Billing email</label>
             <input id="billing-email" name="billing-email" type="email" autocomplete="email" placeholder="you@company.com" value="${esc(this.email)}" />`}
        <p class="plan-meta" role="status">${esc(this.note) || "Paid plans check out securely with Stripe."}</p>`;
    }
  });
}
