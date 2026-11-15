import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mixpanelBoot, mixpanelBootResponse } from "../src/mixpanel-boot.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36";

function run(src: string, userAgent = BROWSER): unknown[][] {
  const init = vi.fn();
  new Function("initInfinitumMixpanel", "navigator", src)(init, { userAgent });
  return init.mock.calls;
}

describe("Mixpanel boot", () => {
  it("is inert without a valid token", () => {
    expect(run(mixpanelBoot({}))).toEqual([]);
    expect(run(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: "nope" }))).toEqual([]);
  });

  it("starts with the token, US by default, EU when set, tagged product=architect", () => {
    expect(run(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN }))).toEqual([[TOKEN, { region: "US", product: "architect" }]]);
    expect(run(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN, MIXPANEL_REGION: "eu" }))).toEqual([[TOKEN, { region: "EU", product: "architect" }]]);
    expect(run(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN, MIXPANEL_REGION: "</script>" }))[0]![1]).toEqual({ region: "US", product: "architect" });
  });

  it("MIXPANEL=off wins, and the Android app (native Amplitude) is skipped", () => {
    expect(run(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN, MIXPANEL: "off" }))).toEqual([]);
    expect(run(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN }), "Mozilla/5.0 (Linux; Android 15; wv) ArchitectShell/android")).toEqual([]);
    expect(run(mixpanelBoot({ MIXPANEL_PROJECT_TOKEN: TOKEN }), "Mozilla/5.0 Electron/38.0 ArchitectShell/desktop")).toHaveLength(1);
  });

  it("serves JavaScript", async () => {
    const res = mixpanelBootResponse({});
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toMatch(/Mixpanel is off/);
  });

  it("the vendored SDK keeps autocapture, replay, IP geolocation and full URLs off", () => {
    const init = readFileSync(path.join(__dirname, "..", "scripts", "mixpanel-vendor", "init.mjs"), "utf8");
    for (const opt of ["autocapture: false", "ip: false", "record_sessions_percent: 0", "track_marketing: false", "flags: false", 'remote_settings_mode: "disabled"', '"$current_url"', "globalPrivacyControl"]) expect(init).toContain(opt);
    expect(readFileSync(path.join(__dirname, "..", "web", "mixpanel.vendor.js"), "utf8")).toContain("initInfinitumMixpanel");
  });
});
