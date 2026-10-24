// canTap verdicts in Chromium, with real media loading, redirects, CORS and canvas taint.
import type { Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TapVerdict } from '../../src/content/media';
import { openContentPage, startContentHarness, type ContentHarness } from './helpers/content-harness';

let h: ContentHarness;
let page: Page | null = null;

beforeAll(async () => {
  h = await startContentHarness();
});

afterAll(async () => {
  await h?.close();
});

afterEach(async () => {
  await page?.context().close();
  page = null;
});

interface Case {
  tag?: 'video' | 'audio';
  src: string;
  crossOrigin?: string;
  /** Wait until the element has loaded data (a first frame for videos) before asking. */
  loaded?: boolean;
  timeouts?: { fetchMs: number; frameMs: number; taintSettleMs: number };
}

async function verdict(c: Case): Promise<TapVerdict> {
  page ??= (await openContentPage(h)).page;
  return page.evaluate(async (c) => {
    const el = document.createElement(c.tag ?? 'video');
    if (c.crossOrigin) el.crossOrigin = c.crossOrigin;
    el.src = c.src;
    document.body.appendChild(el);
    if (c.loaded) {
      await new Promise<void>((resolve, reject) => {
        el.addEventListener('loadeddata', () => resolve(), { once: true });
        el.addEventListener('error', () => reject(new Error(`media error ${el.error?.code}`)), { once: true });
      });
    }
    const content = (window as unknown as { __content: { canTap(e: HTMLMediaElement, t?: unknown): Promise<TapVerdict> } }).__content;
    return content.canTap(el, c.timeouts);
  }, c);
}

const OK = { ok: true };
const CROSS = { ok: false, reason: 'cross-origin' };

describe('canTap', () => {
  it('accepts same-origin media (video with a frame, audio, and before any data)', async () => {
    expect(await verdict({ src: '/media/video.webm', loaded: true })).toEqual(OK);
    expect(await verdict({ src: '/media/video.webm' })).toEqual(OK);
    expect(await verdict({ tag: 'audio', src: '/media/audio-only.webm', loaded: true })).toEqual(OK);
  });

  it('rejects a same-origin URL that redirects to another site without CORS', async () => {
    const to = encodeURIComponent(`${h.otherOrigin}/media/video.webm`);
    // Before and after the first frame: the same-origin fetch probe refuses the redirect.
    expect(await verdict({ src: `/redirect?to=${to}` })).toEqual(CROSS);
    expect(await verdict({ src: `/redirect?to=${to}`, loaded: true })).toEqual(CROSS);
    const audioTo = encodeURIComponent(`${h.otherOrigin}/media/audio-only.webm`);
    expect(await verdict({ tag: 'audio', src: `/redirect?to=${audioTo}`, loaded: true })).toEqual(CROSS);
  });

  it('accepts a same-origin redirect', async () => {
    expect(await verdict({ src: `/redirect?to=${encodeURIComponent('/media/video.webm')}`, loaded: true })).toEqual(OK);
    expect(await verdict({ tag: 'audio', src: `/redirect?to=${encodeURIComponent('/media/audio-only.webm')}`, loaded: true })).toEqual(OK);
  });

  it('accepts cross-origin media loaded with CORS', async () => {
    expect(await verdict({ src: `${h.otherOrigin}/media/video.webm?cors=1`, crossOrigin: 'anonymous', loaded: true })).toEqual(OK);
    expect(await verdict({ tag: 'audio', src: `${h.otherOrigin}/media/audio-only.webm?cors=1`, crossOrigin: 'anonymous', loaded: true })).toEqual(OK);
  });

  it('rejects cross-origin media without CORS, with or without the crossorigin attribute', async () => {
    expect(await verdict({ src: `${h.otherOrigin}/media/video.webm` })).toEqual(CROSS);
    expect(await verdict({ tag: 'audio', src: `${h.otherOrigin}/media/audio-only.webm`, crossOrigin: 'anonymous' })).toEqual(CROSS);
  });

  it('treats a crossorigin attribute set after loading started as unproven', async () => {
    page ??= (await openContentPage(h)).page;
    const v = await page.evaluate(async (src) => {
      const el = document.createElement('video');
      el.src = src;
      document.body.appendChild(el);
      await new Promise((r) => el.addEventListener('loadeddata', r, { once: true }));
      // Too late: the response was fetched without CORS, so the media is tainted.
      el.crossOrigin = 'anonymous';
      const content = (window as unknown as { __content: { canTap(e: HTMLMediaElement): Promise<TapVerdict> } }).__content;
      return content.canTap(el);
    }, `${h.otherOrigin}/media/video.webm?cors=1`);
    expect(v).toEqual(CROSS);
  });

  it('accepts blob: and data: sources without probing, and needs a source', async () => {
    page ??= (await openContentPage(h)).page;
    const verdicts = await page.evaluate(async () => {
      const content = (window as unknown as { __content: { canTap(e: HTMLMediaElement): Promise<TapVerdict> } }).__content;
      const mse = document.createElement('video');
      mse.src = URL.createObjectURL(new MediaSource());
      const data = document.createElement('audio');
      data.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgLsAAAB3AQACABAAZGF0YQAAAAA=';
      const none = document.createElement('video');
      return Promise.all([content.canTap(mse), content.canTap(data), content.canTap(none)]);
    });
    expect(verdicts).toEqual([OK, OK, { ok: false, reason: 'no-source' }]);
  });

  it('does not take a network failure for another site', async () => {
    // The probe fails until the network is back (a request without Range gets through): checked again.
    expect(await verdict({ src: '/flaky?key=a' })).toEqual(OK);
    // The network stays down: unverified, so the controller asks again at the next play.
    expect(await verdict({ tag: 'audio', src: '/dead' })).toEqual({ ok: false, reason: 'unverified' });
  });

  it('does not vouch for streaming playlists or for a probe that gets no answer', async () => {
    expect(await verdict({ tag: 'audio', src: '/playlist.m3u8' })).toEqual({ ok: false, reason: 'unverified' });
    expect(await verdict({ tag: 'audio', src: '/slow', timeouts: { fetchMs: 400, frameMs: 300, taintSettleMs: 0 } })).toEqual({ ok: false, reason: 'unverified' });
  });
});
