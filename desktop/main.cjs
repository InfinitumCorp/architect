// :\ARCHITECT\ Desktop — the coding agent on your own machine.
// Runs the Architect server locally (Electron's own Node, no install needed) on a project folder
// you choose, protected by a fresh random token each launch, and shows the Podium in a window.
// Model keys live in the settings folder's .env (Settings > Open settings folder); never in the app.
// People sign in with Cumulus://ID in their browser: the app sends them to the OIDC issuer
// (https://id.cumuluscloud.app/realms/cumulus) with PKCE S256 and a nonce, rchtch.app/cid-return.html
// hands the one-time code back over architect://, and the app trades it for tokens here and verifies
// the ID token against the issuer's JWKS (ES256, iss, aud, exp, nonce) before keeping the session. The local server's token is a machine secret the app
// adds to its own requests; nobody types or sees it.
const { app, BrowserWindow, Menu, dialog, safeStorage, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const userDir = () => app.getPath("userData");
const prefsFile = () => path.join(userDir(), "desktop.json");
const readPrefs = () => {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), "utf8"));
  } catch {
    return {};
  }
};
const writePrefs = (p) => fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2));

let win = null;
let server = null;
let current = null; // { port, token, project }

// ---- Cumulus://ID ----
const CID_CLIENT = "architect";
const cidIssuer = () => {
  const v = process.env.CID_ISSUER || readPrefs().cidIssuer || "";
  return (/^https:\/\//.test(v) ? v : "https://id.cumuluscloud.app/realms/cumulus").replace(/\/+$/, "");
};
const cidOidc = () => `${cidIssuer()}/protocol/openid-connect`;
const CID_RETURN = "https://rchtch.app/cid-return.html?to=desktop";
const cidFile = () => path.join(userDir(), "cumulus-id.bin");
const b64url = (buf) => Buffer.from(buf).toString("base64url");
let pending = null; // { verifier, state, nonce } while the browser is out signing in

function readCid() {
  try {
    const raw = fs.readFileSync(cidFile());
    const s = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8"));
    return s && s.token && s.until > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}
function writeCid(s) {
  fs.mkdirSync(userDir(), { recursive: true });
  if (!s) return fs.rmSync(cidFile(), { force: true });
  const text = JSON.stringify(s);
  fs.writeFileSync(cidFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text, { mode: 0o600 });
}

/** Verify the ID token: ES256 against the issuer's JWKS, then iss, aud, exp and nonce. */
async function verifyCidIdToken(idToken, nonce) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Cumulus ID sent no ID token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (header.alg !== "ES256" || String(header.typ || "JWT").toLowerCase() === "at+jwt") throw new Error("Cumulus ID sent an unexpected token");
  const r = await fetch(`${cidOidc()}/certs`, { headers: { accept: "application/json" } });
  const { keys = [] } = await r.json().catch(() => ({}));
  const jwk = keys.find((k) => k && k.kty === "EC" && k.crv === "P-256" && (!header.kid || k.kid === header.kid));
  if (!jwk) throw new Error("Cumulus ID's signing key was not found");
  const subtle = crypto.webcrypto.subtle;
  const key = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(parts[2], "base64url"), Buffer.from(`${parts[0]}.${parts[1]}`));
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = Math.floor(Date.now() / 1000);
  if (!ok || claims.iss !== cidIssuer() || !aud.includes(CID_CLIENT) || (aud.length > 1 && claims.azp !== CID_CLIENT) ||
    typeof claims.exp !== "number" || claims.exp + 60 <= now || claims.nonce !== nonce || typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("That sign-in couldn't be verified");
  }
  return claims;
}

function startCidSignIn(create) {
  const verifier = b64url(crypto.randomBytes(48));
  const state = b64url(crypto.randomBytes(16));
  const nonce = b64url(crypto.randomBytes(16));
  pending = { verifier, state, nonce };
  const u = new URL(`${cidOidc()}/auth`);
  u.search = new URLSearchParams({
    response_type: "code",
    client_id: CID_CLIENT,
    redirect_uri: CID_RETURN,
    scope: "openid profile email",
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state,
    nonce,
    ...(create ? { prompt: "create" } : {}),
  }).toString();
  shell.openExternal(u.toString());
  showSignIn("Finish in your browser. :\\ARCHITECT\\ continues here once you're signed in.");
}

/** architect://cid?code&state from the return page: trade the code for tokens and verify them. */
async function finishCidSignIn(link) {
  let u;
  try {
    u = new URL(link);
  } catch {
    return;
  }
  if (u.protocol !== "architect:" || u.hostname !== "cid") return;
  if (win && win.isMinimized()) win.restore();
  win?.focus();
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  const was = pending;
  pending = null;
  if (!was || !code || state !== was.state) return showSignIn(u.searchParams.get("error") || "That sign-in didn't match. Please try again.");
  try {
    const r = await fetch(`${cidOidc()}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: was.verifier, client_id: CID_CLIENT, redirect_uri: CID_RETURN }).toString(),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) throw new Error(d.error_description || d.error || `Cumulus ID answered ${r.status}`);
    const claims = await verifyCidIdToken(d.id_token, was.nonce);
    const profile = { cid: claims.sub, username: claims.preferred_username || claims.username, email: claims.email, name: claims.name };
    writeCid({ token: d.access_token, profile, until: Date.now() + Number(d.expires_in || 3600) * 1000 });
    const prefs = readPrefs();
    if (prefs.project && fs.existsSync(prefs.project)) await openPodium(prefs.project);
    else {
      await openPodium(undefined);
      await chooseProject();
    }
  } catch (err) {
    showSignIn(`Sign-in failed: ${err.message}`);
  }
}

function showSignIn(note) {
  stopServer();
  current = null;
  win.setTitle(":\\ARCHITECT\\");
  win.loadFile(path.join(__dirname, "signin.html"), note ? { query: { note } } : undefined);
  buildMenu();
}

function signOut() {
  const s = readCid();
  writeCid(null);
  // Revoke at Cumulus://ID so this app session leaves the person's session list.
  if (s) {
    fetch(`${cidOidc()}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: s.token, client_id: CID_CLIENT }).toString(),
    }).catch(() => {});
  }
  showSignIn("Signed out.");
}

// architect:// links reach this app: as a second launch on Windows/Linux, as open-url on macOS.
if (process.defaultApp) app.setAsDefaultProtocolClient("architect", process.execPath, [path.resolve(process.argv[1] || ".")]);
else app.setAsDefaultProtocolClient("architect");
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on("second-instance", (_e, argv) => {
  const link = argv.find((a) => a.startsWith("architect://"));
  if (link) return finishCidSignIn(link);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
app.on("open-url", (e, link) => {
  e.preventDefault();
  app.whenReady().then(() => finishCidSignIn(link));
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function ensureSettings() {
  fs.mkdirSync(userDir(), { recursive: true });
  const env = path.join(userDir(), ".env");
  if (!fs.existsSync(env)) {
    fs.writeFileSync(
      env,
      [
        "# :\\ARCHITECT\\ Desktop settings. Add one model key, save, then restart the app (Server > Restart).",
        "# ANTHROPIC_API_KEY=",
        "# Or an OpenAI-compatible gateway (OmniRoute, LM Studio, Ollama):",
        "# OMNIROUTE_URL=http://localhost:20128/v1",
        "",
      ].join("\n"),
    );
  }
  return env;
}

async function startServer(project) {
  stopServer();
  const port = await freePort();
  const token = crypto.randomBytes(24).toString("base64url");
  ensureSettings();
  const cli = path.join(__dirname, "app", "cli.mjs");
  const args = [cli, "serve", "--port", String(port)];
  if (project) args.push("--workspace", project);
  server = spawn(process.execPath, args, {
    cwd: userDir(), // runs, schedules and .env live in the settings folder
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ARCHITECT_API_TOKEN: token, ARCHITECT_DESKTOP: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const log = fs.createWriteStream(path.join(userDir(), "server.log"), { flags: "a" });
  server.stdout.pipe(log);
  server.stderr.pipe(log);
  server.on("exit", (code) => {
    if (code && win && !win.isDestroyed()) {
      dialog.showErrorBox(":\\ARCHITECT\\", `The local server stopped (exit ${code}). See server.log in the settings folder.`);
    }
  });
  current = { port, token, project };
  await waitFor(port);
  return current;
}

function stopServer() {
  if (server && !server.killed) server.kill();
  server = null;
}

async function waitFor(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function chooseProject() {
  const r = await dialog.showOpenDialog(win, { title: "Open a project folder", properties: ["openDirectory", "createDirectory"] });
  if (r.canceled || !r.filePaths[0]) return;
  const prefs = readPrefs();
  prefs.project = r.filePaths[0];
  prefs.recent = [r.filePaths[0], ...(prefs.recent || []).filter((p) => p !== r.filePaths[0])].slice(0, 8);
  writePrefs(prefs);
  await openPodium(r.filePaths[0]);
}

async function openPodium(project) {
  const cid = readCid();
  if (!cid) return showSignIn();
  const { port } = await startServer(project);
  win.setTitle(`:\\ARCHITECT\\ — ${project ? path.basename(project) : "no project"}`);
  // The Podium shows who is signed in and can save to Labyrinth with this Cumulus ID session.
  const handoff = b64url(JSON.stringify({ token: cid.token, profile: cid.profile, until: cid.until }));
  await win.loadURL(`http://127.0.0.1:${port}/#cid_handoff=${handoff}`);
  buildMenu();
}

function buildMenu() {
  const prefs = readPrefs();
  const template = [
    {
      label: "Project",
      submenu: [
        { label: "Open folder…", accelerator: "CmdOrCtrl+O", click: chooseProject },
        {
          label: "Recent",
          submenu: (prefs.recent || []).length
            ? prefs.recent.map((p) => ({ label: p, click: () => openPodium(p) }))
            : [{ label: "No recent folders", enabled: false }],
        },
        { label: "Show project in file manager", enabled: Boolean(current?.project), click: () => current?.project && shell.openPath(current.project) },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Server",
      submenu: [
        { label: "Restart", click: () => openPodium(current?.project) },
        { label: "Open settings folder (.env with model keys)", click: () => shell.openPath(path.dirname(ensureSettings())) },
      ],
    },
    {
      label: "Account",
      submenu: (() => {
        const s = readCid();
        const who = s && s.profile && (s.profile.email || s.profile.username);
        return s
          ? [{ label: `Signed in with Cumulus ID${who ? ` as ${who}` : ""}`, enabled: false }, { label: "Sign out", click: signOut }]
          : [{ label: "Sign in with Cumulus ID", click: () => startCidSignIn(false) }, { label: "Create a Cumulus ID", click: () => startCidSignIn(true) }];
      })(),
    },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }] },
    {
      label: "Help",
      submenu: [
        { label: "Architect in the cloud (rchtch.app)", click: () => shell.openExternal("https://rchtch.app/") },
        { label: "About", click: () => dialog.showMessageBox(win, { message: ":\\ARCHITECT\\ Desktop", detail: `Version ${app.getVersion()}\nInfinitum Corporation` }) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#ffffff",
    title: ":\\ARCHITECT\\",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Marks this window as the app, so the Podium accepts the Cumulus ID handoff (and nothing else does).
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} ArchitectShell/desktop`);
  // The local server's machine token rides on the app's own requests; it never appears in the page.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["http://127.0.0.1/*"] }, (details, done) => {
    const headers = details.requestHeaders;
    if (current && details.url.startsWith(`http://127.0.0.1:${current.port}/`)) headers.Authorization = `Bearer ${current.token}`;
    done({ requestHeaders: headers });
  });
  // Links away from the local Podium open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${current?.port}/`)) shell.openExternal(url);
    return { action: url.startsWith(`http://127.0.0.1:${current?.port}/`) ? "allow" : "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    // The sign-in page's two buttons.
    if (url === "architect://signin" || url === "architect://create") {
      e.preventDefault();
      return startCidSignIn(url === "architect://create");
    }
    if (current &&!url.startsWith(`http://127.0.0.1:${current.port}/`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  buildMenu();
  if (!readCid()) return showSignIn();
  const prefs = readPrefs();
  if (prefs.project && fs.existsSync(prefs.project)) await openPodium(prefs.project);
  else {
    await openPodium(undefined);
    await chooseProject();
  }
});

app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});
app.on("before-quit", stopServer);
