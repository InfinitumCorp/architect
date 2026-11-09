import { ApiError, DEFAULT_BASE, createClient } from "./api.js";

const $ = (id) => document.getElementById(id);
const say = (id, text) => ($(id).textContent = text);

const { token = "" } = await chrome.storage.local.get("token");
$("token").value = token;

$("token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ token: $("token").value.trim() });
  say("token-result", "Saved.");
});

$("clear").addEventListener("click", async () => {
  $("token").value = "";
  await chrome.storage.local.remove("token");
  say("token-result", "Cleared.");
});

// The Podium keeps its token in localStorage["architect.token"] on rchtch.app.
$("from-podium").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ url: DEFAULT_BASE + "/*" });
  if (!tab?.id) return say("token-result", "Open rchtch.app in a tab (signed in, token entered) and try again.");
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { try { return localStorage.getItem("architect.token") || ""; } catch { return ""; } },
    });
    if (!result) return say("token-result", "That Podium tab has no saved token yet.");
    $("token").value = result;
    await chrome.storage.local.set({ token: result });
    say("token-result", "Copied from the Podium and saved.");
  } catch (err) {
    say("token-result", `Could not read the Podium tab: ${err.message}`);
  }
});

const { geoRouting = false } = await chrome.storage.local.get("geoRouting");
$("geo-routing").checked = geoRouting === true;

async function pullGeo() {
  const stored = await chrome.storage.local.get("token");
  if (!stored.token) return;
  try {
    const data = await createClient({ base: DEFAULT_BASE, token: stored.token }).settings();
    if (typeof data.geoRouting === "boolean") {
      $("geo-routing").checked = data.geoRouting;
      await chrome.storage.local.set({ geoRouting: data.geoRouting });
    }
  } catch {
    /* the saved browser value stands when the server cannot be reached */
  }
}
await pullGeo();

$("geo-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const on = $("geo-routing").checked === true;
  await chrome.storage.local.set({ geoRouting: on });
  const stored = await chrome.storage.local.get("token");
  if (!stored.token) {
    say("geo-result", "Saved in this browser. Add an API token to update the server.");
    return;
  }
  try {
    const data = await createClient({ base: DEFAULT_BASE, token: stored.token }).saveSettings({ geoRouting: on });
    if (data.effective === on) say("geo-result", on ? "Saved. Geo routing is on." : "Saved. Geo routing is off.");
    else say("geo-result", "Saved. INFINITUM_GEO_ENABLED on the server overrides this switch.");
  } catch (err) {
    say("geo-result", `Saved in this browser. The server was not updated: ${err.message}`);
  }
});

$("check").addEventListener("click", async () => {
  say("check-result", "Checking…");
  const { token = "" } = await chrome.storage.local.get("token");
  try {
    await createClient({ base: DEFAULT_BASE, token }).runs(1);
    say("check-result", "Connected: signed in and the token works.");
  } catch (err) {
    say("check-result", err instanceof ApiError ? err.message : String(err));
  }
});
