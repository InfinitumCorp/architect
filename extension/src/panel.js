import { ApiError, DEFAULT_BASE, FINAL, createClient, planWaiting, runLabel } from "./api.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

let client = createClient();
let timer = 0;

async function loadClient() {
  const { token = "" } = await chrome.storage.local.get("token");
  client = createClient({ base: DEFAULT_BASE, token });
  return token;
}

function showNotice(err) {
  const box = $("notice");
  box.replaceChildren();
  box.hidden = !err;
  if (!err) return;
  const runs = $("runs");
  if (runs.querySelector(".empty")) runs.replaceChildren(el("li", { className: "empty", textContent: "Not connected." }));
  box.className = "notice" + (err.kind === "http" || err.kind === "network" ? " bad" : "");
  box.append(el("p", { textContent: err.message }));
  if (err.kind === "signin") {
    box.append(el("p", {}, el("button", { className: "btn primary", type: "button", textContent: "Sign in at rchtch.app", onclick: signIn })));
    box.append(el("p", { className: "small muted", textContent: "After signing in, come back and press Refresh." }));
  } else if (err.kind === "token") {
    box.append(el("p", {}, el("button", { className: "btn primary", type: "button", textContent: "Open Options", onclick: () => chrome.runtime.openOptionsPage() })));
  }
}

function signIn() {
  chrome.tabs.create({ url: DEFAULT_BASE + "/" });
}

function guard(fn) {
  return async (...args) => {
    try {
      showNotice(null);
      return await fn(...args);
    } catch (err) {
      showNotice(err instanceof ApiError ? err : new ApiError("http", String(err?.message || err)));
    }
  };
}

const refresh = guard(async () => {
  const [runs, approvals] = await Promise.all([client.runs(15), client.approvals()]);
  // Keep a half-written comment: skip redrawing the list while one of its inputs has focus.
  const typing = document.activeElement?.tagName === "INPUT" && $("runs").contains(document.activeElement);
  if (!typing) renderRuns(Array.isArray(runs) ? runs : []);
  renderApprovals(Array.isArray(approvals) ? approvals : []);
  clearTimeout(timer);
  const busy = (Array.isArray(runs) ? runs : []).some((r) => !FINAL.has(r.status) && r.status !== "composed");
  $("approvals-section").hidden = !approvals.length && !(Array.isArray(runs) ? runs : []).some(planWaiting);
  if (busy || approvals.length) timer = setTimeout(refresh, 3000);
});

function renderRuns(runs) {
  const list = $("runs");
  list.replaceChildren();
  if (!runs.length) return list.append(el("li", { className: "empty", textContent: "No runs yet." }));
  for (const run of runs) {
    const open = el("a", { href: `${DEFAULT_BASE}/`, title: `Run ${run.id}: open the Podium`, target: "_blank", rel: "noopener", textContent: runLabel(run) });
    const meta = el("div", { className: "row small" },
      el("span", { className: `status ${planWaiting(run) ? "awaiting_approval" : run.status}`, textContent: planWaiting(run) ? "plan review" : run.status.replace(/_/g, " ") }),
      el("span", { className: "muted", textContent: new Date(run.updatedAt || run.createdAt).toLocaleString() }));
    const item = el("li", {}, open, meta);
    if (run.error) item.append(el("div", { className: "small status failed", textContent: run.error }));
    if (run.verdict?.summary) item.append(el("div", { className: "small muted", textContent: run.verdict.summary }));
    if (planWaiting(run)) {
      item.append(el("ol", { className: "small" }, ...(run.score?.steps || []).map((s) => el("li", { textContent: s.title }))));
      item.append(el("button", { className: "btn primary", type: "button", textContent: "Approve plan", onclick: guard(async () => { await client.perform(run.id); await refresh(); }) }));
    }
    if (!FINAL.has(run.status) && run.status !== "composed") {
      item.append(el("button", { className: "btn", type: "button", textContent: "Cancel", onclick: guard(async () => { await client.cancel(run.id); await refresh(); }) }));
    }
    if (!FINAL.has(run.status)) {
      // Comments reach a performing run on its next turn, without stopping it.
      const box = el("input", { className: "input", placeholder: "Comment for Architect" });
      const send = guard(async () => { await client.comment(run.id, box.value); box.value = ""; await refresh(); });
      box.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); send(); } });
      item.append(el("div", { className: "row" }, box, el("button", { className: "btn", type: "button", textContent: "Send", onclick: send })));
    }
    list.append(item);
  }
}

function renderApprovals(approvals) {
  const list = $("approvals");
  list.replaceChildren();
  for (const a of approvals) {
    const note = el("input", { className: "input", placeholder: "Note (optional)" });
    const decide = (ok) => guard(async () => { await client.decide(a.id, ok, note.value.trim()); await refresh(); });
    list.append(el("li", {},
      el("div", { textContent: a.reason }),
      a.tool ? el("div", { className: "small muted", textContent: `${a.tool}${a.risk ? " · " + a.risk : ""}` }) : null,
      a.input !== undefined ? el("pre", { textContent: JSON.stringify(a.input, null, 2) }) : null,
      el("div", { className: "field" }, note),
      el("div", { className: "row" },
        el("button", { className: "btn primary", type: "button", textContent: "Approve", onclick: decide(true) }),
        el("button", { className: "btn", type: "button", textContent: "Decline", onclick: decide(false) }))));
  }
}

function applyDraft(draft) {
  if (!draft) return;
  $("goal").value = draft.goal || "";
  $("start-url").value = draft.startUrl || "";
  $("goal").focus();
  chrome.storage.session.remove("draft");
}

$("new-run").addEventListener("submit", (e) => {
  e.preventDefault();
  const button = $("start");
  button.disabled = true;
  guard(async () => {
    const run = await client.start({
      goal: $("goal").value, startUrl: $("start-url").value, autonomy: $("autonomy").value,
      review: $("review").value, sameSite: $("same-site").checked,
    });
    $("goal").value = "";
    $("start-url").value = "";
    if (run?.id) await refresh();
  })().finally(() => { button.disabled = false; });
});

$("use-tab").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.url && /^https?:/.test(tab.url)) $("start-url").value = tab.url;
});
$("refresh").addEventListener("click", () => refresh());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.draft?.newValue) applyDraft(changes.draft.newValue);
  if (area === "local" && changes.token) loadClient().then(refresh);
});

(async () => {
  await loadClient();
  const { draft } = await chrome.storage.session.get("draft");
  applyDraft(draft);
  await refresh();
})();
