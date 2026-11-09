// Chrome extension build tools (no extra dependencies).
//   node scripts/extension.mjs icons   render podium/icon.svg to extension/icons/*.png (needs Playwright's Chromium)
//   node scripts/extension.mjs zip     check the manifest, then write dist/architect-extension-<version>.zip for the Chrome Web Store
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { checkManifest } from "./extension-check.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const EXT = path.join(ROOT, "extension");

async function icons() {
  const { chromium } = await import("playwright");
  const svg = await readFile(path.join(ROOT, "podium/icon.svg"), "utf8");
  const browser = await chromium.launch();
  try {
    await mkdir(path.join(EXT, "icons"), { recursive: true });
    for (const size of [16, 32, 48, 128]) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
      await page.screenshot({ path: path.join(EXT, `icons/icon-${size}.png`), omitBackground: true });
      await page.close();
      console.log(`extension/icons/icon-${size}.png`);
    }
  } finally {
    await browser.close();
  }
}

async function files(dir, base = dir) {
  const out = [];
  for (const name of (await readdir(dir)).sort()) {
    if (name.startsWith(".") || name === "README.md") continue;
    const full = path.join(dir, name);
    if ((await stat(full)).isDirectory()) out.push(...(await files(full, base)));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

/** Minimal ZIP writer (deflate), enough for a Web Store upload. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(0x00210000, 10); // fixed 1980-01-01 timestamp: reproducible zips
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0x00210000, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cenBuf, end]);
}

async function pack() {
  const problems = await checkManifest(EXT);
  if (problems.length) {
    console.error(problems.map((p) => "  - " + p).join("\n"));
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(path.join(EXT, "manifest.json"), "utf8"));
  const names = await files(EXT);
  const entries = await Promise.all(names.map(async (name) => ({ name, data: await readFile(path.join(EXT, name)) })));
  await mkdir(path.join(ROOT, "dist"), { recursive: true });
  const out = path.join(ROOT, "dist", `architect-extension-${manifest.version}.zip`);
  await writeFile(out, zip(entries));
  console.log(`${path.relative(ROOT, out)} (${names.length} files)`);
}

const cmd = process.argv[2];
if (cmd === "icons") await icons();
else if (cmd === "zip") await pack();
else {
  console.error("usage: node scripts/extension.mjs icons|zip");
  process.exit(2);
}
