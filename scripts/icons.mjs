// Render podium/icon.svg to the PNG sizes the web app and the Android app need.
//   node scripts/icons.mjs
import { chromium } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const svg = await readFile("podium/icon.svg", "utf8");
const targets = [
  ["podium/icon-192.png", 192],
  ["podium/icon-512.png", 512],
  ["android/res/mipmap-mdpi/ic_launcher.png", 48],
  ["android/res/mipmap-hdpi/ic_launcher.png", 72],
  ["android/res/mipmap-xhdpi/ic_launcher.png", 96],
  ["android/res/mipmap-xxhdpi/ic_launcher.png", 144],
  ["android/res/mipmap-xxxhdpi/ic_launcher.png", 192],
];
const browser = await chromium.launch();
try {
  for (const [file, size] of targets) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
    await mkdir(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, omitBackground: true });
    await page.close();
    console.log(file, size);
  }
} finally {
  await browser.close();
}
