// Render web/icon.svg (made by scripts/logo.py) to the PNG sizes the web app and the extension need.
// The Android app uses the vector drawables scripts/logo.py writes.
//   node scripts/icons.mjs
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const svg = await readFile("web/icon.svg", "utf8");
// [file, size, crop]: small icons crop tighter so the :\™ mark stays legible at 16-48 px.
const TIGHT = "21 21 66 66";
const targets = [
  ["web/icon-192.png", 192],
  ["web/icon-512.png", 512],
  ["extension/icons/icon-16.png", 16, TIGHT],
  ["extension/icons/icon-32.png", 32, TIGHT],
  ["extension/icons/icon-48.png", 48, TIGHT],
  ["extension/icons/icon-128.png", 128],
];
const browser = await chromium.launch();
try {
  for (const [file, size, crop] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${crop ? svg.replace(/viewBox="[^"]*"/, `viewBox="${crop}"`) : svg}`);
    await mkdir(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, omitBackground: true });
    await page.close();
    console.log(file, size);
  }
} finally {
  await browser.close();
}
