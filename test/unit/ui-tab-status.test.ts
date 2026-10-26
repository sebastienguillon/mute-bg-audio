import { describe, expect, it } from 'vitest';
import type { TabMode, TabStatus } from '../../src/lib/protocol';
import { REDUCTION_STEPS } from '../../src/lib/settings';
import {
  ACTION_ICON_PATHS,
  actionTitle,
  aggregateTabStatus,
  BADGE_WARNING_COLOR,
  badgeFor,
  canOfferTabCapture,
  classifyPage,
  describeStatus,
  iconFor,
  isCapturing,
  MODE_PRIORITY,
  stableStatus,
  originMatchPattern,
  reductionLabel,
  reductionStepIndex,
  statusLine,
  type PageInfo,
} from '../../src/lib/tab-status';

const youtube: PageInfo = { kind: 'youtube', origin: 'https://www.youtube.com' };
const web: PageInfo = { kind: 'web', origin: 'https://vimeo.com' };

function st(mode: TabMode, extra: Partial<TabStatus> = {}): TabStatus {
  return { mode, site: 'generic', enabled: mode !== 'off', ...extra };
}

function frames(...entries: [number, TabStatus][]): [number, TabStatus][] {
  return entries;
}

describe('aggregateTabStatus', () => {
  it('returns null without reports', () => {
    expect(aggregateTabStatus([])).toBeNull();
    expect(aggregateTabStatus([], null)).toBeNull();
  });

  it('orders modes lookahead > realtime > tabcapture > starting > waiting > passthrough > unsupported > off', () => {
    const order: TabMode[] = ['lookahead', 'realtime', 'tabcapture', 'starting', 'waiting', 'passthrough', 'unsupported', 'off'];
    for (let i = 1; i < order.length; i++) expect(MODE_PRIORITY[order[i - 1]!]).toBeGreaterThan(MODE_PRIORITY[order[i]!]);
  });

  it('prefers the top frame over subframes without an active mode', () => {
    const top = st('waiting');
    expect(aggregateTabStatus(frames([3, st('passthrough')], [0, top], [5, st('off')]))).toBe(top);
    const off = st('off');
    expect(aggregateTabStatus(frames([0, off], [2, st('waiting')]))).toBe(off);
  });

  it('lets an active subframe outrank the top frame', () => {
    const sub = st('realtime');
    expect(aggregateTabStatus(frames([0, st('waiting')], [7, sub]))).toBe(sub);
    const starting = st('starting');
    expect(aggregateTabStatus(frames([0, st('off')], [7, starting]))).toBe(starting);
  });

  it('keeps an active top frame unless a subframe ranks higher', () => {
    const top = st('realtime');
    expect(aggregateTabStatus(frames([0, top], [4, st('starting')]))).toBe(top);
    expect(aggregateTabStatus(frames([0, top], [4, st('realtime')]))).toBe(top);
    const la = st('lookahead');
    expect(aggregateTabStatus(frames([0, top], [4, la]))).toBe(la);
  });

  it('picks the highest active subframe', () => {
    const la = st('lookahead');
    expect(aggregateTabStatus(frames([0, st('waiting')], [1, st('starting')], [2, la], [3, st('realtime')]))).toBe(la);
  });

  it('prefers a subframe that needs tab capture over an idle top frame', () => {
    const drm = st('unsupported', { needsTabCapture: true, detail: 'DRM' });
    expect(aggregateTabStatus(frames([0, st('waiting')], [9, drm]))).toBe(drm);
    // ...but not over a top frame the user switched off, or one that is processing.
    const off = st('off');
    expect(aggregateTabStatus(frames([0, off], [9, drm]))).toBe(off);
    const rt = st('realtime');
    expect(aggregateTabStatus(frames([0, rt], [9, drm]))).toBe(rt);
  });

  it('falls back to the best subframe when the top frame has not reported', () => {
    const waiting = st('waiting');
    expect(aggregateTabStatus(frames([2, st('off')], [3, waiting], [4, st('passthrough')]))).toBe(waiting);
  });

  it('lets a running capture session win', () => {
    const capture: TabStatus = { mode: 'tabcapture', site: 'tabcapture', enabled: true, latencyMs: 60 };
    expect(aggregateTabStatus(frames([0, st('lookahead')]), capture)).toBe(capture);
    expect(aggregateTabStatus([], capture)).toBe(capture);
  });

  it('shows the detail of a failed capture on top of the frame status', () => {
    const failed: TabStatus = { mode: 'off', site: 'tabcapture', enabled: false, detail: 'Tab is already captured' };
    const merged = aggregateTabStatus(frames([0, st('unsupported', { needsTabCapture: true, detail: 'DRM' })]), failed);
    expect(merged).toMatchObject({ mode: 'unsupported', site: 'generic', needsTabCapture: true, detail: 'Tab is already captured' });
    expect(aggregateTabStatus([], failed)).toBe(failed);
    // A stopped capture without detail is ignored.
    const top = st('waiting');
    expect(aggregateTabStatus(frames([0, top]), { mode: 'off', site: 'tabcapture', enabled: false })).toBe(top);
  });
});

describe('stableStatus', () => {
  it('drops the look-ahead progress and speed, nothing else', () => {
    const s = st('lookahead', { latencyMs: 60, lookahead: { state: 'ready', backend: 'webgpu', aheadSeconds: 12.3, rtf: 0.21 } });
    expect(stableStatus(s)).toEqual({ ...s, lookahead: { state: 'ready', backend: 'webgpu' } });
    expect(s.lookahead).toMatchObject({ aheadSeconds: 12.3, rtf: 0.21 }); // Not mutated.
    const unavailable = st('realtime', { lookahead: { state: 'unavailable', reason: 'No WebGPU.' } });
    expect(stableStatus(unavailable)).toEqual(unavailable);
    const plain = st('waiting');
    expect(stableStatus(plain)).toBe(plain);
  });
});

describe('iconFor', () => {
  it('is on whenever the extension is on in the tab, whatever it does there', () => {
    for (const mode of ['waiting', 'starting', 'realtime', 'lookahead', 'tabcapture', 'passthrough', 'unsupported'] as const) {
      expect(iconFor(st(mode)), mode).toBe('on');
    }
    // Tab capture runs while the in-page script stands down: the aggregate is the capture's status.
    expect(iconFor(aggregateTabStatus(frames([0, st('off', { enabled: true })]), st('tabcapture', { site: 'tabcapture' })))).toBe('on');
  });

  it('is off for a tab that was not switched on, or without any script', () => {
    expect(iconFor(st('off'))).toBe('off');
    // The master switch makes every frame report enabled: false.
    expect(iconFor(st('waiting', { enabled: false }))).toBe('off');
    expect(iconFor(null)).toBe('off');
  });

  it('has an image per toolbar size and state', () => {
    expect(ACTION_ICON_PATHS).toEqual({
      on: { 16: '/icon/16.png', 32: '/icon/32.png' },
      off: { 16: '/icon/off/16.png', 32: '/icon/off/32.png' },
    });
  });
});

describe('badgeFor', () => {
  it('shows an amber "!" when tab capture is needed or the media is unsupported', () => {
    expect(badgeFor(st('unsupported'))).toEqual({ text: '!', color: BADGE_WARNING_COLOR });
    expect(badgeFor(st('waiting', { needsTabCapture: true }))).toEqual({ text: '!', color: BADGE_WARNING_COLOR });
    expect(BADGE_WARNING_COLOR).toBe('#d97706');
    // Processing wins over the warning.
    expect(badgeFor(st('realtime', { needsTabCapture: true })).text).toBe('');
  });

  it('is empty otherwise: the icon shows on and off', () => {
    for (const mode of ['off', 'waiting', 'starting', 'passthrough', 'realtime', 'lookahead', 'tabcapture'] as const) {
      expect(badgeFor(st(mode)).text).toBe('');
    }
    expect(badgeFor(null).text).toBe('');
  });
});

describe('actionTitle', () => {
  it('names the extension and the coarse state', () => {
    expect(actionTitle(null)).toBe('Mute BG Audio');
    expect(actionTitle(st('realtime'))).toBe('Mute BG Audio: Real-time (CPU)');
    expect(actionTitle(st('lookahead', { lookahead: { state: 'ready', backend: 'webgpu', aheadSeconds: 12 } }))).toBe(
      'Mute BG Audio: Look-ahead (GPU)',
    );
    expect(actionTitle(st('unsupported', { needsTabCapture: true }))).toBe(
      "Mute BG Audio: Can't process this video directly – tab capture available",
    );
    expect(actionTitle(st('waiting', { detail: 'Paused.' }))).toBe('Mute BG Audio: Paused');
    expect(actionTitle(st('waiting', { detail: 'No sound.' }))).toBe('Mute BG Audio: Waiting for sound');
  });
});

describe('describeStatus', () => {
  const line = (s: TabStatus | null, page: PageInfo = youtube, master = true) => statusLine(describeStatus(s, page, master));

  it('describes look-ahead with backend and buffered seconds', () => {
    const s = st('lookahead', { site: 'youtube', latencyMs: 60, lookahead: { state: 'ready', backend: 'webgpu', aheadSeconds: 24.7 } });
    const text = describeStatus(s, youtube, true);
    expect(statusLine(text)).toBe('Look-ahead · GPU · 24 s ready');
    expect(text.headline).toBe('Look-ahead · GPU');
    expect(text.progress).toBe('24 s ready');
    expect(text.latency).toBe('Latency 60 ms');
    expect(text.tone).toBe('active');
    expect(line(st('lookahead', { lookahead: { state: 'ready', backend: 'wasm', aheadSeconds: 0.4 } }))).toBe('Look-ahead · CPU');
  });

  it('describes real-time with the look-ahead state as detail', () => {
    expect(line(st('realtime'))).toBe('Real-time · CPU');
    const loading = describeStatus(st('realtime', { lookahead: { state: 'loading' } }), youtube, true);
    expect(loading.detail).toBe('Preparing the GPU look-ahead model…');
    const unavailable = describeStatus(st('realtime', { lookahead: { state: 'unavailable', reason: 'No WebGPU.' } }), youtube, true);
    expect(unavailable.detail).toBe('Look-ahead unavailable: No WebGPU.');
    expect(describeStatus(st('realtime', { lookahead: { state: 'off' } }), youtube, true).detail).toBeUndefined();
    // A detail from the content script wins.
    expect(describeStatus(st('realtime', { detail: 'X', lookahead: { state: 'loading' } }), youtube, true).detail).toBe('X');
  });

  it('describes waiting, starting, passthrough and tab capture', () => {
    expect(line(st('waiting'))).toBe('Waiting for the video to play');
    expect(describeStatus(st('waiting', { detail: 'Waiting for a video to play.' }), web, true).detail).toBeUndefined();
    expect(describeStatus(st('waiting', { detail: 'Click or press a key on the page to start.' }), web, true).detail).toBe(
      'Click or press a key on the page to start.',
    );
    // The controller's mixer idles while the video is paused or silent.
    expect(describeStatus(st('waiting', { detail: 'Paused.' }), youtube, true)).toEqual({ headline: 'Paused', tone: 'pending' });
    expect(describeStatus(st('waiting', { detail: 'No sound.' }), web, true)).toEqual({ headline: 'Waiting for sound', tone: 'pending' });
    expect(line(st('starting'))).toBe('Starting…');
    expect(line({ mode: 'starting', site: 'tabcapture', enabled: true })).toBe('Starting tab capture…');
    expect(describeStatus(st('passthrough', { detail: 'Engine failed' }), web, true)).toMatchObject({
      headline: 'Audio passes through unchanged',
      detail: 'Engine failed',
      tone: 'pending',
    });
    const capture = describeStatus({ mode: 'tabcapture', site: 'tabcapture', enabled: true, latencyMs: 60.4 }, web, true);
    expect(capture).toMatchObject({ headline: 'Tab capture · Real-time · CPU', latency: 'Latency 60 ms', tone: 'active' });
  });

  it('explains unsupported media', () => {
    expect(describeStatus(st('unsupported'), web, true)).toEqual({
      headline: "Can't process this video directly (protected or cross-origin media)",
      tone: 'warning',
    });
    expect(describeStatus(st('unsupported', { detail: 'This video is DRM-protected.' }), web, true)).toEqual({
      headline: "Can't process this video directly",
      detail: 'This video is DRM-protected.',
      tone: 'warning',
    });
  });

  it('explains media in a cross-origin frame and offers tab capture for it', () => {
    const framed = st('unsupported', { needsTabCapture: true, detail: 'The video plays in a frame from player.vimeo.com.' });
    expect(describeStatus(framed, web, true)).toEqual({
      headline: "Can't process this video directly",
      detail: 'The video plays in a frame from player.vimeo.com.',
      tone: 'warning',
    });
    expect(canOfferTabCapture(framed, web)).toBe(true);
    expect(badgeFor(framed).text).toBe('!');
  });

  it('only shows latency while processing', () => {
    expect(describeStatus(st('passthrough', { latencyMs: 60 }), web, true).latency).toBeUndefined();
    expect(describeStatus(st('realtime'), web, true).latency).toBeUndefined();
  });

  it('covers off, missing statuses, restricted pages and the master switch', () => {
    expect(line(st('off'))).toBe('Off on this tab');
    // In-page processing stands down while tab capture runs.
    expect(describeStatus(st('off', { detail: 'Tab capture is processing this tab.' }), web, true)).toEqual({
      headline: 'Off on this tab',
      detail: 'Tab capture is processing this tab.',
      tone: 'idle',
    });
    expect(describeStatus({ mode: 'off', site: 'tabcapture', enabled: false, detail: 'Busy' }, web, true)).toMatchObject({
      headline: 'Tab capture stopped',
      detail: 'Busy',
      tone: 'warning',
    });
    expect(describeStatus(null, youtube, true)).toMatchObject({ headline: 'Not running on this tab yet', detail: 'Reload the page to start.' });
    expect(line(null, web)).toBe('Off on this page');
    expect(line(st('realtime'), { kind: 'restricted', origin: null })).toBe("Chrome doesn't allow extensions on this page");
    expect(line(st('realtime'), web, false)).toBe('Turned off on all sites');
  });
});

describe('classifyPage', () => {
  it('recognises YouTube', () => {
    expect(classifyPage('https://www.youtube.com/watch?v=x')).toEqual({ kind: 'youtube', origin: 'https://www.youtube.com' });
    expect(classifyPage('https://m.youtube.com/')).toMatchObject({ kind: 'youtube' });
    expect(classifyPage('https://www.youtube-nocookie.com/embed/x')).toMatchObject({ kind: 'youtube' });
    expect(classifyPage('https://notyoutube.com/')).toMatchObject({ kind: 'web' });
  });

  it('classifies other pages', () => {
    expect(classifyPage('https://vimeo.com/123')).toEqual({ kind: 'web', origin: 'https://vimeo.com' });
    expect(classifyPage('http://localhost:8080/a')).toEqual({ kind: 'web', origin: 'http://localhost:8080' });
    expect(classifyPage('file:///Users/me/movie.mp4')).toEqual({ kind: 'file', origin: null });
    for (const url of ['chrome://extensions', 'chrome-extension://abc/popup.html', 'about:blank', 'https://chromewebstore.google.com/detail/x', 'https://chrome.google.com/webstore/x', undefined, 'not a url']) {
      expect(classifyPage(url)).toEqual({ kind: 'restricted', origin: null });
    }
  });
});

describe('originMatchPattern', () => {
  it('builds a pattern for http(s) origins only', () => {
    expect(originMatchPattern('https://vimeo.com')).toBe('https://vimeo.com/*');
    expect(originMatchPattern('http://localhost:8080')).toBe('http://localhost:8080/*');
    expect(originMatchPattern('https://vimeo.com/path')).toBeNull();
    expect(originMatchPattern('chrome://extensions')).toBeNull();
    expect(originMatchPattern('vimeo.com')).toBeNull();
    expect(originMatchPattern('')).toBeNull();
  });
});

describe('canOfferTabCapture', () => {
  it('offers capture when the media needs it', () => {
    expect(canOfferTabCapture(st('unsupported', { needsTabCapture: true }), youtube)).toBe(true);
    expect(canOfferTabCapture(st('waiting', { needsTabCapture: true }), youtube)).toBe(true);
  });

  it('does not offer capture for routed media that only a reload brings back', () => {
    const detail = 'The sound of this media cannot be read any more. Reload the page to hear it; tab capture can then process it.';
    const silenced = st('unsupported', { detail });
    expect(canOfferTabCapture(silenced, youtube)).toBe(false);
    expect(canOfferTabCapture(silenced, web)).toBe(false);
  });

  it('offers capture on non-YouTube pages that are not processing', () => {
    expect(canOfferTabCapture(null, web)).toBe(true);
    expect(canOfferTabCapture(st('waiting'), web)).toBe(true);
    expect(canOfferTabCapture(null, { kind: 'file', origin: null })).toBe(true);
    expect(canOfferTabCapture(st('realtime'), web)).toBe(false);
  });

  it('does not offer capture on YouTube without need, on restricted pages or while capturing', () => {
    expect(canOfferTabCapture(null, youtube)).toBe(false);
    expect(canOfferTabCapture(st('waiting'), youtube)).toBe(false);
    expect(canOfferTabCapture(st('unsupported'), { kind: 'restricted', origin: null })).toBe(false);
    const capturing: TabStatus = { mode: 'tabcapture', site: 'tabcapture', enabled: true };
    expect(isCapturing(capturing)).toBe(true);
    expect(canOfferTabCapture(capturing, web)).toBe(false);
    expect(isCapturing({ mode: 'off', site: 'tabcapture', enabled: false })).toBe(false);
    expect(isCapturing(null)).toBe(false);
  });
});

describe('reduction slider helpers', () => {
  it('labels values', () => {
    expect(reductionLabel(18)).toBe('18 dB');
    expect(reductionLabel(0)).toBe('0 dB');
    expect(reductionLabel(60)).toBe('Remove');
    expect(reductionLabel(80)).toBe('Remove');
  });

  it('maps values to the nearest step', () => {
    REDUCTION_STEPS.forEach((db, i) => expect(reductionStepIndex(db)).toBe(i));
    expect(reductionStepIndex(-5)).toBe(0);
    expect(reductionStepIndex(19)).toBe(REDUCTION_STEPS.indexOf(18));
    expect(reductionStepIndex(50)).toBe(REDUCTION_STEPS.length - 1);
  });
});
