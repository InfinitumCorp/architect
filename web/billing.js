// @ts-nocheck (plain browser module)
// :\ARCHITECT\ plans and payments through the central Infinitum revenue API (Stripe Checkout and
// the Stripe customer portal). The web app never holds a Stripe key and never sees card details:
// it sends the signed-in person's Cumulus ID access token (window.CumulusID, cumulus-bar.js) as the
// Bearer, and the revenue API answers with a Checkout or portal URL to open.
//
//   <architect-plan revenue-url="https://…"></architect-plan>   (styles live in index.html)
//
// revenue-url is optional: the page sets it from REVENUE_URL on the server (/v1/models), else the
// default below is used.

export const REVENUE_URL = "https://infinitum-revenue.infinitumcorp.workers.dev";
export const PRODUCT = "cndctr"; // :\ARCHITECT\ in the revenue catalog

/** Shown when the catalog can't be reached; the catalog's own plans replace these. */
export const FALLBACK_PLANS = [
  { id: "cndctr_free", product: PRODUCT, name: "Free", channel: "self_serve", priceCents: 0, interval: "month", perSeat: false, features: ["50 execution credits a month"], allowedKinds: ["individual", "business"] },
  { id: "cndctr_pro", product: PRODUCT, name: "Pro", channel: "self_serve", priceCents: 3900, interval: "month", perSeat: false, trialDays: 14, features: ["500 credits, 20 verified outcomes, Autopilot"], allowedKinds: ["individual", "business"] },
  { id: "cndctr_business", product: PRODUCT, name: "Business", channel: "self_serve", priceCents: 9900, interval: "month", perSeat: true, features: ["2,000 credits, standing permissions, SSO"], allowedKinds: ["business"] },
];
const PAID = new Set(["trialing", "active", "past_due", "bundled"]);

export class BillingError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const base = (url) => String(url || REVENUE_URL).replace(/\/+$/, "");

async function call({ fetch: fetchFn = globalThis.fetch, revenueUrl, token }, method, path, body) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetchFn(`${base(revenueUrl)}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new BillingError(0, "network", "Billing is unreachable. Check your connection and try again.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new BillingError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? "Billing request failed.");
  return json;
}

const needToken = (token) => {
  if (!token) throw new BillingError(401, "signed_out", "Sign in with Cumulus ID to subscribe.");
};

/** :\ARCHITECT\ plans from the public catalog, cheapest first. Contract plans are never shown. */
export async function loadPlans(opts = {}) {
  const { plans = [] } = await call(opts, "GET", "/v1/catalog");
  return plans.filter((p) => p.product === PRODUCT && p.channel !== "contract").sort((a, b) => a.priceCents - b.priceCents);
}

/** This person's :\ARCHITECT\ entitlement, or null when they have none. */
export async function loadEntitlement(opts) {
  needToken(opts.token);
  const ent = await call(opts, "GET", "/v1/me/entitlements");
  return ent?.products?.find((p) => p.product === PRODUCT) ?? null;
}

/** The plan id in force: an unpaid or lapsed subscription counts as Free. */
export function currentPlanId(ent) {
  if (!ent || (ent.plan !== "cndctr_free" && !PAID.has(ent.status))) return "cndctr_free";
  return ent.plan;
}

export const businessOnly = (plan) => Array.isArray(plan?.allowedKinds) && plan.allowedKinds.length > 0 && !plan.allowedKinds.includes("individual");

export const formatPrice = (p) =>
  p.priceCents === 0
    ? "Free"
    : `$${(p.priceCents / 100).toLocaleString("en-US", { minimumFractionDigits: p.priceCents % 100 ? 2 : 0 })} / ${p.perSeat ? "seat / " : ""}${p.interval}${p.trialDays ? ` · ${p.trialDays}-day trial` : ""}`;

export const returnUrl = (origin) => `${origin}/`;

/** Stripe Checkout for a paid plan. Business-only plans first make sure there is a business org. */
export async function startCheckout({ plan, seats, origin, orgName, ...opts }) {
  needToken(opts.token);
  if (!plan || plan.priceCents === 0) throw new BillingError(400, "bad_plan", "Choose a paid plan.");
  if (businessOnly(plan)) {
    try {
      await call(opts, "POST", "/v1/me/org", { kind: "business", ...(orgName ? { name: orgName } : {}) });
    } catch (err) {
      if (err.status !== 409) throw err; // 409: the business org already exists
    }
  }
  const quantity = plan.perSeat ? Math.max(1, Math.floor(Number(seats) || 1)) : undefined;
  const session = await call(opts, "POST", "/v1/subscriptions/checkout", {
    planId: plan.id, ...(quantity ? { quantity } : {}), returnUrl: returnUrl(origin),
  });
  return session.url;
}

/** Stripe customer portal: change plan, cancel, payment method, invoices. */
export async function openPortal({ origin, ...opts }) {
  needToken(opts.token);
  return (await call(opts, "POST", "/v1/billing/portal", { returnUrl: returnUrl(origin) })).url;
}

export function readReturn(search) {
  const v = new URLSearchParams(search).get("billing");
  return v === "success" || v === "cancelled" ? v : null;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const METER_NAMES = { credits: "Execution credits", outcomes: "Verified outcomes" };

if (typeof customElements !== "undefined" && !customElements.get("architect-plan")) {
  customElements.define("architect-plan", class extends HTMLElement {
    static get observedAttributes() { return ["revenue-url"]; }

    connectedCallback() {
      this.plans = FALLBACK_PLANS;
      this.ent = null;
      this.seats = 1;
      this.busy = false;
      this.note = "";
      const back = readReturn(location.search);
      if (back) {
        const q = new URLSearchParams(location.search);
        q.delete("billing");
        q.delete("session_id");
        const rest = q.toString();
        history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
        this.note = back === "success" ? "Payment complete. Your plan will update in a moment." : "Checkout cancelled. No charge was made.";
      }
      this.addEventListener("input", (e) => { if (e.target.name === "seats") this.seats = e.target.value; });
      this.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-plan], button[data-portal], button[data-signin], button[data-create]");
        if (!btn) return;
        if (btn.dataset.portal !== undefined) this.portal();
        else if (btn.dataset.signin !== undefined) window.CumulusID?.signIn();
        else if (btn.dataset.create !== undefined) window.CumulusID?.create();
        else this.choose(btn.dataset.plan);
      });
      this.onIdentity = () => { this.ent = null; this.render(); this.refresh(1); };
      window.addEventListener("cumulus-id", this.onIdentity);
      this.render();
      this.loadCatalog();
      this.refresh(back === "success" ? 5 : 1);
    }

    disconnectedCallback() { window.removeEventListener("cumulus-id", this.onIdentity); }

    attributeChangedCallback(name, before, after) {
      if (name === "revenue-url" && before !== after && this.isConnected && this.plans) { this.loadCatalog(); this.refresh(1); }
    }

    get opts() { return { revenueUrl: this.getAttribute("revenue-url") || REVENUE_URL, token: (window.CumulusID && window.CumulusID.token()) || "" }; }
    get current() { return currentPlanId(this.ent); }

    async loadCatalog() {
      try {
        const plans = await loadPlans(this.opts);
        if (plans.length) { this.plans = plans; this.render(); }
      } catch { /* keep the fallback list */ }
    }

    async refresh(attempts) {
      if (!this.opts.token) return;
      for (let i = 0; i < attempts; i++) {
        try {
          this.ent = await loadEntitlement(this.opts);
          this.render();
          if (this.current !== "cndctr_free" || i === attempts - 1) return;
        } catch { return; }
        await new Promise((r) => setTimeout(r, 2000)); // the Stripe webhook may land just after the redirect
      }
    }

    async choose(id) {
      if (this.busy || id === this.current) return;
      if (!this.opts.token) { this.note = "Sign in with Cumulus ID to subscribe."; return this.render(); }
      const plan = this.plans.find((p) => p.id === id);
      // Moving between paid plans, or back to Free, goes through the Stripe customer portal.
      if (!plan || plan.priceCents === 0 || this.current !== "cndctr_free") return this.portal();
      this.busy = true; this.note = ""; this.render();
      try {
        location.assign(await startCheckout({ ...this.opts, plan, seats: this.seats, origin: location.origin }));
        return;
      } catch (err) {
        this.note = err.message;
      }
      this.busy = false; this.render();
    }

    async portal() {
      if (this.busy) return;
      this.busy = true; this.note = ""; this.render();
      try { location.assign(await openPortal({ ...this.opts, origin: location.origin })); return; }
      catch (err) { this.note = err.status === 404 ? "You are on the Free plan." : err.message; }
      this.busy = false; this.render();
    }

    render() {
      const signedIn = Boolean(this.opts.token);
      const current = this.current;
      const meters = Object.entries(this.ent?.meters ?? {});
      const seatPlan = signedIn && current === "cndctr_free" && this.plans.some((p) => p.perSeat && p.priceCents > 0);
      this.innerHTML = `
        <h2 class="runs-title">Plan</h2>
        <div class="plan-list">${this.plans.map((p) => `
          <button type="button" class="plan-option${p.id === current ? " current" : ""}" data-plan="${esc(p.id)}" aria-pressed="${p.id === current}" ${this.busy ? "disabled" : ""}>
            <span class="plan-name">${esc(p.name)}${p.id === current ? " · current" : ""}</span>
            <span class="plan-price">${esc(formatPrice(p))}</span>
            ${p.features?.length ? `<span class="plan-detail">${esc(p.features.join(", "))}</span>` : ""}
            ${businessOnly(p) ? '<span class="plan-detail">For organisations</span>' : ""}
            ${p.channel === "sales_assisted" ? '<span class="plan-detail">Checkout opens after Infinitum approves your organisation.</span>' : ""}
          </button>`).join("")}
        </div>
        ${seatPlan ? `<label class="label" for="plan-seats">Seats (per-seat plans)</label>
          <input id="plan-seats" name="seats" type="number" min="1" step="1" inputmode="numeric" value="${esc(this.seats)}" />` : ""}
        ${meters.length ? `<p class="plan-meta">${meters.map(([id, m]) => `${esc(METER_NAMES[id] ?? id)}: ${esc(m.used)} of ${esc(m.included)}`).join(" · ")}</p>` : ""}
        ${signedIn
          ? (this.ent && current !== "cndctr_free" ? `<p class="plan-meta">${esc(this.ent.status)}${this.ent.seats ? ` · ${esc(this.ent.seats)} seat${this.ent.seats === 1 ? "" : "s"}` : ""} · <button type="button" class="link" data-portal ${this.busy ? "disabled" : ""}>Manage billing</button></p>` : "")
          : `<p class="plan-meta">Sign in with Cumulus ID to subscribe. <button type="button" class="link" data-signin>Sign in</button> · <button type="button" class="link" data-create>Create a Cumulus ID</button></p>`}
        <p class="plan-meta" role="status">${esc(this.note) || "Paid plans check out securely with Stripe."}</p>`;
    }
  });
}
