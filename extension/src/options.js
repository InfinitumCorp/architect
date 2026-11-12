import { ApiError, DEFAULT_BASE, createClient } from "./api.js";
import { session, signIn, signOut, who } from "./cid.js";

const $ = (id) => document.getElementById(id);
const say = (text) => ($("result").textContent = text);

async function draw() {
  const s = await session();
  $("signed-in").hidden = !s;
  $("signed-out").hidden = Boolean(s);
  $("who").textContent = s
    ? `Signed in with Cumulus ID${who(s) ? ` as ${who(s)}` : ""}.`
    : "Sign in with your Cumulus ID. No Cumulus ID yet? Create one here; you come straight back signed in.";
}

const start = (create) => async () => {
  say(create ? "Opening Cumulus ID to create your account…" : "Opening Cumulus ID…");
  try {
    await signIn({ create });
    say("Signed in.");
  } catch (err) {
    say(err.message || String(err));
  }
  draw();
};
$("signin").addEventListener("click", start(false));
$("create").addEventListener("click", start(true));
$("signout").addEventListener("click", async () => {
  await signOut();
  say("Signed out.");
  draw();
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
  say("Checking…");
  const s = await session();
  try {
    await createClient({ base: DEFAULT_BASE, token: s?.token || "" }).runs(1);
    say("Connected.");
  } catch (err) {
    say(err instanceof ApiError ? err.message : String(err));
  }
});

draw();
