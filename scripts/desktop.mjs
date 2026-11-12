#!/usr/bin/env node
// Build :\ARCHITECT\ Desktop without electron-builder:
//   node scripts/desktop.mjs [--platform win32] [--arch x64] [--electron-zip <path>]
// 1. bundles the CLI/server with esbuild into desktop/app/cli.mjs
// 2. lays out an Electron distribution (from a cached or given electron-vX-<platform>-<arch>.zip)
//    with the app in resources/app and the runtime packages it loads lazily
// 3. zips it to dist/Architect-Desktop-<version>-<platform>-<arch>.zip
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")), "..");
// Windows ships bsdtar, which reads and writes zip; Git's GNU tar on PATH does not.
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe") : "tar";
const { values } = parseArgs({ options: { platform: { type: "string" }, arch: { type: "string" }, "electron-zip": { type: "string" } } });
const platform = values.platform ?? process.platform;
const arch = values.arch ?? process.arch;
const desktop = path.join(root, "desktop");
const version = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8")).version;

// Packages the server loads at run time instead of bundling (native helpers, browser drivers, lazy imports).
const EXTERNAL = ["playwright", "playwright-core", "@anthropic-ai/sandbox-runtime", "@playwright/mcp", "chromium-bidi", "fsevents"];

console.log("1/4 bundle the server");
mkdirSync(path.join(desktop, "app"), { recursive: true });
await build({
  entryPoints: [path.join(root, "src", "cli.ts")],
  outfile: path.join(desktop, "app", "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNAL,
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});
rmSync(path.join(desktop, "web"), { recursive: true, force: true });
cpSync(path.join(root, "web"), path.join(desktop, "web"), { recursive: true });

console.log("2/4 find Electron");
// The server uses Node 22 APIs (fs.glob); Electron 35 is the first release on Node 22.
const MIN_ELECTRON = 35;
const electronVersion = (file) => path.basename(file).match(/^electron-v([\d.]+)-/)?.[1] ?? "0";
let zip = values["electron-zip"];
if (!zip) {
  const cache = process.env.ELECTRON_CACHE ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".cache"), "electron", "Cache");
  const found = existsSync(cache)
    ? readdirSync(cache, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(`-${platform}-${arch}.zip`) && path.basename(f).startsWith("electron-v"))
        .map((f) => path.join(cache, f))
        // Highest Electron version first (not newest file: other tools cache older Electrons too).
        .sort((a, b) => electronVersion(b).localeCompare(electronVersion(a), undefined, { numeric: true }))
    : [];
  zip = found.find((f) => Number(electronVersion(f).split(".")[0]) >= MIN_ELECTRON);
}
if (!zip || !existsSync(zip)) {
  throw new Error(`No Electron ${MIN_ELECTRON}+ zip for ${platform}-${arch}. Download electron-v<version>-${platform}-${arch}.zip from github.com/electron/electron/releases and pass --electron-zip.`);
}
if (Number(electronVersion(zip).split(".")[0]) < MIN_ELECTRON) {
  throw new Error(`${path.basename(zip)} is too old: the server needs Node 22 (Electron ${MIN_ELECTRON} or later).`);
}
console.log(`   using ${path.basename(zip)}`);

console.log("3/4 lay out the app");
const name = `Architect-Desktop-${version}-${platform}-${arch}`;
const out = path.join(root, "dist", name);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
execFileSync(TAR, ["-xf", zip, "-C", out], { stdio: "inherit" });
if (platform === "win32") renameSync(path.join(out, "electron.exe"), path.join(out, "Architect.exe"));
else if (platform === "linux") renameSync(path.join(out, "electron"), path.join(out, "architect"));
const resources = platform === "darwin" ? path.join(out, "Electron.app", "Contents", "Resources") : path.join(out, "resources");
rmSync(path.join(resources, "default_app.asar"), { force: true });
const appDir = path.join(resources, "app");
mkdirSync(appDir, { recursive: true });
for (const f of ["package.json", "main.cjs", "signin.html", "app", "web"]) cpSync(path.join(desktop, f), path.join(appDir, f), { recursive: true });

// The external packages and everything they depend on, from this checkout's node_modules.
const seen = new Set();
const copyPkg = (pkg) => {
  if (seen.has(pkg)) return;
  const src = path.join(root, "node_modules", pkg);
  if (!existsSync(src)) return;
  seen.add(pkg);
  cpSync(src, path.join(appDir, "node_modules", pkg), { recursive: true, dereference: true });
  const meta = JSON.parse(readFileSync(path.join(src, "package.json"), "utf8"));
  for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) copyPkg(dep);
};
for (const pkg of EXTERNAL) copyPkg(pkg);
writeFileSync(path.join(out, "README.txt"), [
  ":\\ARCHITECT\\ Desktop",
  "",
  `Run ${platform === "win32" ? "Architect.exe" : platform === "linux" ? "./architect" : "Electron.app"}, open a project folder, and describe what to build or change.`,
  "It works at once with the free open-weight model on rchtch.app (no key, no VPN needed).",
  "For stronger models: Server > Open settings folder, edit .env (OMNIROUTE_URL=…, GROQ_API_KEY=… or ANTHROPIC_API_KEY=…), then Server > Restart.",
  "Project rules are read from ARCHITECT.md, AGENTS.md, CLAUDE.md, .cursorrules and GROK.md in the project folder.",
  "",
].join("\r\n"));

console.log("4/4 zip");
const zipOut = path.join(root, "dist", `${name}.zip`);
rmSync(zipOut, { force: true });
execFileSync(TAR, ["-a", "-cf", zipOut, "-C", path.join(root, "dist"), name], { stdio: "inherit" });
console.log(`built ${path.relative(root, zipOut)} (${(statSync(zipOut).size / 1e6).toFixed(1)} MB, ${seen.size} runtime packages)`);
