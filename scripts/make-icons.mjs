#!/usr/bin/env node
// Renders assets/icon.svg to public/icon/<size>.png (picked up by WXT for the manifest icons, and
// the toolbar icon of a tab where the extension is on) and its greyed-out variant to
// public/icon/off/<size>.png (the toolbar icon everywhere else: see ACTION_ICON_PATHS in
// src/lib/tab-status.ts), with Playwright's Chromium, so the text in the SVG uses the same font
// stack as the browser.
//
// Usage: node scripts/make-icons.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const VARIANTS = [
  { dir: 'public/icon', sizes: [16, 32, 48, 96, 128], filter: 'none' },
  // Toolbar sizes only (16 px, and 32 px on high-DPI screens). Grey and faded like a disabled
  // control, so that on and off differ in colour and in contrast, on light and dark toolbars.
  { dir: 'public/icon/off', sizes: [16, 32], filter: 'grayscale(1) opacity(0.45)' },
];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'assets/icon.svg'), 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  // Render the SVG at each target size directly (rather than downscaling) for crisp edges.
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  for (const { dir, sizes, filter } of VARIANTS) {
    await mkdir(join(root, dir), { recursive: true });
    for (const size of sizes) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:transparent">` +
          `<img src="${src}" width="${size}" height="${size}" style="display:block;filter:${filter}"></body></html>`,
      );
      await page.locator('img').evaluate((img) => img.decode());
      const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
      await writeFile(join(root, dir, `${size}.png`), png);
      console.log(`${dir}/${size}.png`);
    }
  }
} finally {
  await browser.close();
}
