// @ts-nocheck (plain browser module, shared by repos with and without checkJs)
// FIRM Suite embed: FIRM™, FIRM Wallet™ and Firmament Network™ in every Infinitum product.
// Canonical source: infinitum-nexus/packages/firm/suite/firm-suite.js. Copies are re-synced by
// `node packages/firm/suite/sync.mjs` (nexus) or copied by hand (standalone repos). Do not edit a copy.
//
// Usage (needs firm-suite.css on the page; no inline styles or scripts, so it works under
// `default-src 'self'` CSPs):
//   <firm-suite product="scalvs"></firm-suite>
//   <firm-suite product="cumulus-mail" wallet-endpoint="/api/wallet" signin-href="/"></firm-suite>
//   el.wallet = { address, balances: { USDC: "0", FIRM: "0" } }   // host already has the wallet
//
// Wallet states: "wallet" (balances from the signed-in Cumulus://ID), "signin" (endpoint said 401/403),
// "early" (no wallet wired: early access on firmwallet.app). Nothing here invents addresses or balances.

export const FIRM_WALLET_URL = "https://firmwallet.app";
export const FIRMAMENT_URL = "https://firmnetwork.app";

const TM = '<sup class="tm">™</sup>';

/** Infinitum products and their tokens, from the firmwallet.app token registry and RULES/brand/wordmarks.md. */
export const PRODUCTS = {
  firm: { wordmark: `FIRM${TM}`, token: "FIRM", network: "Solana (CPO) → Ethereum" },
  firmament: { wordmark: `Firmament Network${TM}`, token: "FIRM", network: "Solana (CPO) → Ethereum" },
  scalvs: { wordmark: `SCALVS.ai${TM}`, token: "SCLV", network: "Base" },
  architect: { wordmark: `:\\ARCHITECT\\${TM}`, token: "ARCT", network: "Base" },
  spectre: { wordmark: `+SPCTR${TM}`, token: "SPCTR", network: "Base" },
  metatron: { wordmark: `METATRON¹⁰⁰${TM}`, token: "MTRN", network: "Base" },
  fabric: { wordmark: `FABRIC${TM}`, token: "FAB", network: "Solana" },
  "cumulus-cloud": { wordmark: `Cumulus://Cloud${TM}`, token: "CMLS", network: "Base" },
  "cumulus-mail": { wordmark: `Cumulus://Mail${TM}`, token: "CMLS", network: "Base" },
  "cumulus-exchange": { wordmark: `Cumulus://Cloud${TM} Exchange`, token: "CMLS", network: "Base" },
  veil: { wordmark: `VEIL&lt;/&gt;${TM}`, token: "VEIL", network: "Solana" },
  eidetic: { wordmark: `ei·det·ic${TM}`, token: "EIDT", network: "Base" },
  hrvst: { wordmark: `[HRVST]${TM}`, token: "HRVST", network: "Solana" },
  eon: { wordmark: `E(O)N${TM}`, token: null, network: null },
  aether: { wordmark: `ÆTHER${TM}`, token: null, network: null },
  nexus: { wordmark: `Infinitum Nexus${TM}`, token: "NEXUS", network: "Ethereum" },
};

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** Early-access and CPO links, tagged with the product so signups are attributed. */
export function links(product) {
  const ref = encodeURIComponent(product || "app");
  return { wallet: `${FIRM_WALLET_URL}/?ref=${ref}`, network: `${FIRMAMENT_URL}/?ref=${ref}` };
}

/** Normalise a wallet payload ({ address, balances }) or return null if it is not a real wallet. */
export function normaliseWallet(data) {
  if (!data || typeof data !== "object" || typeof data.address !== "string" || !data.address) return null;
  const balances = {};
  for (const [asset, amount] of Object.entries(data.balances ?? {})) {
    if (/^[A-Z0-9]{2,10}$/.test(asset)) balances[asset] = String(amount);
  }
  return { address: data.address, balances };
}

/** Fetch the signed-in wallet. Resolves to { state: "wallet" | "signin" | "early", wallet? }. */
export async function loadWallet(endpoint, fetchImpl = globalThis.fetch) {
  if (!endpoint || typeof fetchImpl !== "function") return { state: "early" };
  try {
    const res = await fetchImpl(endpoint, { credentials: "same-origin", headers: { accept: "application/json" } });
    if (res.status === 401 || res.status === 403) return { state: "signin" };
    if (!res.ok) return { state: "early" };
    const wallet = normaliseWallet(await res.json());
    return wallet ? { state: "wallet", wallet } : { state: "early" };
  } catch {
    return { state: "early" };
  }
}

const short = (address) => (address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address);

/** Render the suite as an HTML string. Every dynamic value is escaped. */
export function render({ product, state = "early", wallet = null, signinHref = "/", compact = false }) {
  // `product` may list several products ("spectre metatron"); the first one tags the links.
  const ids = String(product || "firm").split(/[\s,]+/).filter(Boolean);
  const l = links(ids[0]);
  let body;
  if (state === "wallet" && wallet) {
    const rows = Object.entries(wallet.balances)
      .map(([asset, amount]) => `<li><b>${esc(amount)}</b> <span>$${esc(asset)}</span></li>`)
      .join("");
    body =
      `<p class="fs-sub">Included with your Cumulus://ID · <span class="fs-addr" title="${esc(wallet.address)}">${esc(short(wallet.address))}</span></p>` +
      `<ul class="fs-balances">${rows || "<li><b>0</b> <span>$FIRM</span></li>"}</ul>`;
  } else if (state === "signin") {
    body = `<p class="fs-sub">Sign in with Cumulus://ID to open the FIRM Wallet${TM} that comes with it.</p>`;
  } else {
    body = `<p class="fs-sub">Self-custody for Solana, Ethereum and Base. Early access is open.</p>`;
  }
  const tokens = [];
  const seen = new Set(["FIRM"]);
  for (const id of ids) {
    const p = PRODUCTS[id];
    if (!p?.token || seen.has(p.token)) continue;
    seen.add(p.token);
    tokens.push(`<li><span class="fs-ticker">$${esc(p.token)}</span><span>${p.wordmark}</span><span class="fs-muted">${esc(p.network)}</span></li>`);
  }
  tokens.push(`<li><span class="fs-ticker">$FIRM</span><span>Settles every Infinitum product</span><span class="fs-muted">Solana (CPO) → Ethereum</span></li>`);
  const primary =
    state === "signin"
      ? `<a class="fs-btn fs-solid" href="${esc(signinHref)}">Sign in</a>`
      : state === "wallet"
        ? `<a class="fs-btn fs-solid" href="${esc(l.wallet)}" target="_blank" rel="noopener">Open FIRM Wallet${TM}</a>`
        : `<a class="fs-btn fs-solid" href="${esc(l.wallet)}" target="_blank" rel="noopener">Get early access</a>`;
  return (
    `<div class="firm-suite${compact ? " fs-compact" : ""}" role="region" aria-label="FIRM Suite" data-state="${esc(state)}">` +
    `<div class="fs-head"><span class="fs-wordmark">FIRM Wallet${TM}</span>` +
    `<span class="fs-tag">${state === "wallet" ? "Preview" : "Coming soon"}</span></div>` +
    body +
    (compact ? "" : `<ul class="fs-tokens">${tokens.join("")}</ul>`) +
    `<div class="fs-actions">${primary}` +
    `<a class="fs-btn" href="${esc(l.network)}" target="_blank" rel="noopener">Firmament Network${TM} CPO ↗</a></div>` +
    `</div>`
  );
}

if (typeof HTMLElement !== "undefined" && typeof customElements !== "undefined" && !customElements.get("firm-suite")) {
  class FirmSuite extends HTMLElement {
    #wallet = null;
    set wallet(data) {
      this.#wallet = normaliseWallet(data);
      this.#paint(this.#wallet ? "wallet" : "early");
    }
    get wallet() {
      return this.#wallet;
    }
    connectedCallback() {
      const attr = this.getAttribute("wallet");
      if (attr) {
        try {
          this.#wallet = normaliseWallet(JSON.parse(attr));
        } catch {
          this.#wallet = null;
        }
      }
      if (this.#wallet) return this.#paint("wallet");
      this.#paint("early");
      const endpoint = this.getAttribute("wallet-endpoint");
      if (endpoint) {
        loadWallet(endpoint).then(({ state, wallet }) => {
          this.#wallet = wallet ?? null;
          this.#paint(state);
        });
      }
    }
    #paint(state) {
      this.innerHTML = render({
        product: this.getAttribute("product") || "firm",
        state,
        wallet: this.#wallet,
        signinHref: this.getAttribute("signin-href") || "/",
        compact: this.hasAttribute("compact"),
      });
    }
  }
  customElements.define("firm-suite", FirmSuite);
}
