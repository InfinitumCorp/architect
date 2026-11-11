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
