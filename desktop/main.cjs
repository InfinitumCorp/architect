// :\ARCHITECT\ Desktop — the coding agent on your own machine.
// Runs the Architect server locally (Electron's own Node, no install needed) on a project folder
// you choose, protected by a fresh random token each launch, and shows the Podium in a window.
// Model keys live in the settings folder's .env (Settings > Open settings folder); never in the app.
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");
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
  const { port, token } = await startServer(project);
  win.setTitle(`:\\ARCHITECT\\ — ${project ? path.basename(project) : "no project"}`);
  await win.loadURL(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
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
        { label: "Open in browser", click: () => current && shell.openExternal(`http://127.0.0.1:${current.port}/?token=${encodeURIComponent(current.token)}`) },
      ],
    },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" }] },
    {
      label: "Help",
      submenu: [
        { label: "Cloud Podium (rchtch.app)", click: () => shell.openExternal("https://rchtch.app/") },
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
  // Links away from the local Podium open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(`http://127.0.0.1:${current?.port}/`)) shell.openExternal(url);
    return { action: url.startsWith(`http://127.0.0.1:${current?.port}/`) ? "allow" : "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (current && !url.startsWith(`http://127.0.0.1:${current.port}/`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  buildMenu();
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
