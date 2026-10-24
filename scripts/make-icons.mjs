#!/usr/bin/env node
// Renders assets/icon.svg to public/icon/<size>.png (picked up by WXT for the manifest icons)
// with Playwright's Chromium, so the text in the SVG uses the same font stack as the browser.
//
// Usage: node scripts/make-icons.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const SIZES = [16, 32, 48, 96, 128];
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svg = await readFile(join(root, 'assets/icon.svg'), 'utf8');
const outDir = join(root, 'public/icon');
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  // Render the SVG at each target size directly (rather than downscaling) for crisp edges.
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><html><body style="margin:0;background:transparent">` +
        `<img src="${src}" width="${size}" height="${size}" style="display:block"></body></html>`,
    );
    await page.locator('img').evaluate((img) => img.decode());
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(join(outDir, `${size}.png`), png);
    console.log(`public/icon/${size}.png`);
  }
} finally {
  await browser.close();
}
