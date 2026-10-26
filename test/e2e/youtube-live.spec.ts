// Smoke test against the real youtube.com. Opt-in (network, consent wall, ads):
//   LIVE_YOUTUBE=1 pnpm exec playwright test youtube-live
//   LIVE_YOUTUBE=1 LOOKAHEAD_MODEL=scnet pnpm exec playwright test youtube-live   (the SCNet e2e build)
// Optional: YT_VIDEO=<id> (default: Kurzgesagt "The Egg", narration over music).
import { chromium, expect, test } from '@playwright/test';
import { extensionPath, ExtensionWorld, lookahead, record } from './fixtures';
import { alignedDifference, outputLead, rms } from './audio';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.skip(!process.env.LIVE_YOUTUBE, 'set LIVE_YOUTUBE=1 to run against youtube.com');

test('processes a real YouTube video', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'bgmr-live-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: !process.env.HEADED,
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const world = await ExtensionWorld.attach(page);
    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => (document.documentElement.dataset.bgmrDebug = '1'));
      if (document.documentElement) document.documentElement.dataset.bgmrDebug = '1';
    });
    await page.goto(`https://www.youtube.com/watch?v=${process.env.YT_VIDEO ?? 'h6fcK_fRYaI'}`);
    for (let i = 0; i < 15; i++) {
      const consent = page.locator('button', { hasText: /^\s*(Reject all|Tout refuser|Accept all)\s*$/ }).first();
      if (await consent.isVisible({ timeout: 500 }).catch(() => false)) {
        await consent.click();
        break;
      }
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector('video')?.play().catch(() => {}));
    let status: any = null;
    for (let i = 0; i < 90; i++) {
      await page.waitForTimeout(1000);
      const raw = await page.evaluate(() => document.documentElement.dataset.bgmrStatus ?? null);
      status = raw ? JSON.parse(raw) : null;
      const ad = await page.evaluate(() => !!document.querySelector('.ad-showing'));
      if (i % 5 === 0) console.log(i, ad ? '[ad]' : '', JSON.stringify(status));
      if (status?.mode === 'lookahead' && !ad) {
        console.log(`${lookahead.name}: look-ahead about ${i + 1} s after play()`, JSON.stringify(status.lookahead));
        break;
      }
    }
    expect(status?.mode).toBe('lookahead');
    const rec = await record(page, 5);
    const inRms = rms(rec.input[0]!), outRms = rms(rec.output[0]!);
    const sink = await world.outputLatency();
    // In look-ahead mode the output leads the element's audio by the sink latency.
    const lead = outputLead(rec);
    const changed = alignedDifference(rec, lead.lead);
    console.log('live recording', JSON.stringify({ inRms, outRms, lead, sinkLatency: sink, changed }));
    expect(inRms).toBeGreaterThan(0.005);
    expect(outRms).toBeGreaterThan(0.1 * inRms); // the voice is still there
    expect(Math.abs(lead.lead - sink.frames)).toBeLessThanOrEqual(96);
    expect(changed).toBeGreaterThan(0.05); // and the audio was changed
    // Seek forward within the buffered range; look-ahead must come back.
    await page.evaluate(() => { const v = document.querySelector('video')!; v.currentTime = v.currentTime + 8; });
    let back = false;
    for (let i = 0; i < 40 && !back; i++) {
      await page.waitForTimeout(500);
      const raw = await page.evaluate(() => document.documentElement.dataset.bgmrStatus ?? null);
      const st = raw ? JSON.parse(raw) : null;
      back = st?.mode === 'lookahead' && i > 0;
      if (back) console.log('look-ahead again after seek in', ((i + 1) * 0.5).toFixed(1), 's', JSON.stringify(st.lookahead));
    }
    expect(back).toBe(true);
    await page.screenshot({ path: test.info().outputPath('youtube.png') });
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
