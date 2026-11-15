/**
 * Privacy-first Mixpanel bootstrap for Infinitum commercial web apps.
 * Vendored first-party (mixpanel-browser core build, Apache-2.0): no CDN loads, no session replay code.
 * One page view per load (domain + path, no query string or referrer) and sessions only. No autocapture, no form or text capture,
 * no IP geolocation, no marketing/UTM/referrer capture, no feature flags, no remote settings.
 */
import mixpanel from "mixpanel-browser/dist/mixpanel-core.cjs.js";

export const MIXPANEL_HOSTS = { US: "https://api-js.mixpanel.com", EU: "https://api-eu.mixpanel.com", IN: "https://api-in.mixpanel.com" };

export function mixpanelPrivacyOptions(region = "US") {
  return {
    api_host: MIXPANEL_HOSTS[region] || MIXPANEL_HOSTS.US,
    autocapture: false,
    track_pageview: false,
    ip: false,
    persistence: "localStorage",
    track_marketing: false,
    save_referrer: false,
    store_google: false,
    stop_utm_persistence: true,
    record_sessions_percent: 0,
    record_heatmap_data: false,
    flags: false,
    remote_settings_mode: "disabled",
    batch_requests: true,
    // Full URLs and referrers can carry query-string tokens; keep only domain + path.
    property_blacklist: ["$current_url", "current_url_search", "$referrer", "$referring_domain", "$initial_referrer", "$initial_referring_domain"],
  };
}

function deferToNative() {
  if (typeof window === "undefined") return true;
  if (window.__INFINITUM_ANALYTICS_NATIVE__ || window.__INFINITUM_AMPLITUDE_NATIVE__) return true;
  try {
    const p = window.Capacitor && typeof window.Capacitor.getPlatform === "function" && window.Capacitor.getPlatform();
    if (p && p !== "web") return true;
  } catch { /* ignore */ }
  try { if (location.hostname === "appassets.androidplatform.net") return true; } catch { /* ignore */ }
  return false;
}

/** Starts Mixpanel once. A missing/short token, Global Privacy Control, or window.__INFINITUM_MIXPANEL_OFF__ makes it a no-op. */
export function initInfinitumMixpanel(token, { region = "US", product } = {}) {
  if (typeof window === "undefined" || window.__infinitumMixpanelStarted) return false;
  if (typeof token !== "string" || !/^[0-9a-f]{32}$/i.test(token)) return false;
  if (window.__INFINITUM_MIXPANEL_OFF__ || (typeof navigator !== "undefined" && navigator.globalPrivacyControl === true)) return false;
  if (deferToNative()) return false;
  window.__infinitumMixpanelStarted = true;
  // Register the product before the first page view, then send that page view.
  mixpanel.init(token, { ...mixpanelPrivacyOptions(region), track_pageview: false });
  if (product) mixpanel.register({ product });
  mixpanel.track_pageview();
  return true;
}
