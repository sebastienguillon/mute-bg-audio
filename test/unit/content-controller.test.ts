// The page controller in Chromium: activation rules, problems, the audio path, the engine
// lifecycle and shutdown, against a stub mixer worklet and a fake engine page.
import type { Page } from '@playwright/test';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  addMedia,
  controlEngine,
  engineFrames,
  engineLog,
  extState,
  openContentPage,
  patchMixerStats,
  play,
  snapshot,
  startContentHarness,
  startController,
  TEST_TIMING,
  waitFor,
  type ContentHarness,
  type PageOptions,
} from './helpers/content-harness';

let h: ContentHarness;
let page: Page | null = null;
let errors: string[] = [];

beforeAll(async () => {
  h = await startContentHarness();
});

afterAll(async () => {
  await h?.close();
});

afterEach(async () => {
  await page?.context().close();
  page = null;
  expect(errors).toEqual([]);
});

async function open(options: PageOptions = {}): Promise<Page> {
  ({ page, errors } = await openContentPage(h, options));
  return page;
}

const evaluate = <T>(p: Page, fn: () => T) => p.evaluate(fn);
const dispatch = (p: Page, msg: unknown) => p.evaluate((m) => (window as unknown as { __ext: { dispatch(m: unknown): unknown } }).__ext.dispatch(m), msg);
const tokens = async (p: Page) => (await extState(p)).tokens;
const mode = (m: string) => (s: { status: { mode: string } }) => s.status.mode === m;
const restarts = async (p: Page) => (await engineLog(p)).filter((e) => e.type === 'restart-realtime');
const setSettings = (p: Page, patch: Record<string, unknown>) =>
  p.evaluate((x) => (window as unknown as { __ext: { setSettings(s: unknown): void } }).__ext.setSettings(x), patch);
const pause = (p: Page, id: string) => p.evaluate((id) => (document.getElementById(id) as HTMLMediaElement).pause(), id);

describe('activation', () => {
  it('routes an audible same-origin video and starts the engine with a registered token', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    const s = await waitFor(p, mode('realtime'), 10_000, 'realtime');
    expect(s.graph).toMatchObject({ path: 'worklet', sources: 1 });
    expect(s.engine).toBe('ready');
    const issued = await tokens(p);
    expect(issued).toHaveLength(1);
    const log = await engineLog(p);
    expect(log[0]).toEqual({ type: 'connect', token: issued[0] });
    expect(log.map((e) => e.type)).toEqual(expect.arrayContaining(['init', 'connect-worklet', 'playhead']));
    expect(log.filter((e) => e.type === 'playhead').at(-1)?.playhead).toMatchObject({ audible: true, paused: false });
    // Latency figures from the AudioContext.
    const expected = await evaluate(p, () => {
      const ctx = (window as unknown as { __controller: { ctx: AudioContext } }).__controller.ctx;
      return {
        outputLatency: Math.round((ctx.baseLatency + ctx.outputLatency) * 48000),
        jitter: Math.max(1440, Math.round(ctx.baseLatency * 48000) + 960),
      };
    });
    // Chrome reports outputLatency only once audio plays: the controller re-sends it (every 0.5 s here).
    const stub = (
      await waitFor(
        p,
        (x) => x.mixer?.test?.config?.enabled === true && Math.abs(x.mixer.test.config.outputLatency - expected.outputLatency) <= 96,
        3000,
        'output latency sent',
      )
    ).mixer!.test!;
    expect(expected.outputLatency).toBeGreaterThan(0);
    expect(stub.options.jitter).toBe(expected.jitter);
    expect(stub.connects).toEqual(['connect-rt', 'connect-la']);
  });

  it('leaves muted media alone until it becomes audible, and tells the engine when it is muted again', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm', muted: true });
    await play(p, 'v');
    await p.waitForTimeout(700);
    let s = await snapshot(p);
    expect(s.status).toMatchObject({ mode: 'waiting', detail: 'Waiting for a video to play.' });
    expect(s.graph.sources).toBe(0);
    expect(engineFrames(p)).toHaveLength(0);
    expect(await evaluate(p, () => (window as unknown as { __controller: { ctx: unknown } }).__controller.ctx)).toBeNull();

    await evaluate(p, () => void ((document.getElementById('v') as HTMLMediaElement).muted = false));
    s = await waitFor(p, mode('realtime'), 10_000, 'realtime after unmute');
    expect(s.graph.sources).toBe(1);

    await evaluate(p, () => void ((document.getElementById('v') as HTMLMediaElement).volume = 0));
    await p.waitForTimeout(400);
    expect((await engineLog(p)).filter((e) => e.type === 'playhead').at(-1)?.playhead?.audible).toBe(false);
  });

  it('does not let a second playing element take over the current one', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'a', src: '/media/video.webm' });
    await addMedia(p, { id: 'b', src: '/media/video.webm?b' });
    await play(p, 'a');
    await waitFor(p, (s) => s.status.mode === 'realtime' && s.current?.src.endsWith('/media/video.webm') === true);
    await play(p, 'b');
    await waitFor(p, (s) => s.graph.sources === 2, 5000, 'second element routed');
    expect((await snapshot(p)).current?.src).toMatch(/\/media\/video\.webm$/);
    await evaluate(p, () => (document.getElementById('a') as HTMLMediaElement).pause());
    await waitFor(p, (s) => s.current?.src.endsWith('?b') === true, 3000, 'b becomes current');
  });

  it("prefers YouTube's main player over an inline preview", async () => {
    const p = await open();
    await startController(p, 'youtube');
    // Off until the tab is switched on, like the popup does.
    await dispatch(p, { type: 'tab-command', command: 'enable' });
    await evaluate(p, () => {
      const player = document.createElement('div');
      player.id = 'movie_player';
      document.body.appendChild(player);
    });
    await addMedia(p, { id: 'preview', src: '/media/video.webm?preview' });
    await addMedia(p, { id: 'main', src: '/media/video.webm?main', parent: '#movie_player' });
    await play(p, 'preview');
    await waitFor(p, (s) => s.current?.src.endsWith('?preview') === true);
    await play(p, 'main');
    await waitFor(p, (s) => s.current?.src.endsWith('?main') === true, 5000, 'main player takes over');
    await evaluate(p, () => (document.getElementById('preview') as HTMLMediaElement).pause());
    await play(p, 'preview');
    await p.waitForTimeout(400);
    expect((await snapshot(p)).current?.src).toMatch(/\?main$/);
  });

  it('finds media in open shadow roots', async () => {
    const p = await open();
    await startController(p);
    await evaluate(p, () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const v = document.createElement('video');
      v.src = '/media/video.webm';
      v.loop = true;
      host.attachShadow({ mode: 'open' }).appendChild(v);
      void v.play();
    });
    await waitFor(p, mode('realtime'), 10_000, 'shadow video processed');
  });

  it('does not start on YouTube until the tab is switched on', async () => {
    const p = await open();
    await startController(p, 'youtube');
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await p.waitForTimeout(500);
    expect((await snapshot(p)).status).toMatchObject({ mode: 'off', enabled: false });
    // Nothing routed: the element keeps its own audio path, and no engine or audio context exists.
    expect((await snapshot(p)).graph.sources).toBe(0);
    expect((await snapshot(p)).engine).toBe('none');
    expect(await evaluate(p, () => (window as unknown as { __controller: { ctx: unknown } }).__controller.ctx)).toBeNull();
    // Already playing: enabling picks it up without a new 'play' event.
    await dispatch(p, { type: 'tab-command', command: 'enable' });
    await waitFor(p, mode('realtime'), 10_000, 'realtime after enabling');
  });

  it('starts on YouTube in a tab the user switched on (a reload, a frame that starts later)', async () => {
    const p = await open({ tabEnabled: true });
    await startController(p, 'youtube');
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'), 10_000, 'realtime without a command');
  });

  it('keeps the generic script off in a tab the user switched off (a site it always runs on)', async () => {
    const p = await open({ tabEnabled: false });
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await p.waitForTimeout(500);
    expect((await snapshot(p)).status).toMatchObject({ mode: 'off', enabled: false });
    expect((await snapshot(p)).graph.sources).toBe(0);
  });
});

describe('problems', () => {
  it('does not route a same-origin URL that redirects to another site', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: `/redirect?to=${encodeURIComponent(`${h.otherOrigin}/media/video.webm`)}` });
    await play(p, 'v');
    const s = await waitFor(p, mode('unsupported'), 5000);
    expect(s.status).toMatchObject({ needsTabCapture: true, detail: 'This media comes from another site without permission to read its audio.' });
    expect(s.graph.sources).toBe(0);
  });

  it('reports a problem only while the element plays audibly and nothing routed plays', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'x', src: `${h.otherOrigin}/media/video.webm`, muted: true });
    await play(p, 'x');
    await p.waitForTimeout(400);
    expect((await snapshot(p)).status.mode).toBe('waiting');
    await evaluate(p, () => void ((document.getElementById('x') as HTMLMediaElement).muted = false));
    await waitFor(p, mode('unsupported'), 3000, 'problem when audible');
    await evaluate(p, () => (document.getElementById('x') as HTMLMediaElement).pause());
    await waitFor(p, mode('waiting'), 3000, 'cleared on pause');

    // A routed element that plays fine hides other elements' problems.
    await addMedia(p, { id: 'main', src: '/media/video.webm' });
    await play(p, 'main');
    await waitFor(p, mode('realtime'));
    await play(p, 'x');
    await p.waitForTimeout(500);
    let s = await snapshot(p);
    expect(s.status.mode).toBe('realtime');
    expect(s.status.needsTabCapture).toBeUndefined();
    await evaluate(p, () => (document.getElementById('main') as HTMLMediaElement).pause());
    await waitFor(p, mode('unsupported'), 3000, 'shown once the routed element stops');
    // Removed from the page (which also pauses it): gone. The paused main element then idles.
    await evaluate(p, () => document.getElementById('x')!.remove());
    s = await waitFor(p, mode('waiting'), 3000, 'cleared on removal');
    expect(s.status).toMatchObject({ detail: 'Paused.' });
    expect(s.status.needsTabCapture).toBeUndefined();
  });

  it('reports a routed element whose new source cannot be read', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'));
    // The page reuses the element for the next item, which redirects to another site.
    await p.evaluate((other) => {
      const v = document.getElementById('v') as HTMLMediaElement;
      v.src = `/redirect?to=${encodeURIComponent(`${other}/media/video.webm`)}`;
      return v.play();
    }, h.otherOrigin);
    const s = await waitFor(p, mode('unsupported'), 5000, 'problem after the source change');
    expect(s.status.detail).toBe('This media now comes from another site, which silences it here. Reload the page to hear it; tab capture can then process it.');
    // Tab capture would record the same silence: only a reload helps.
    expect(s.status.needsTabCapture).toBeUndefined();
  });

  it('reports routed media whose source has delivered only digital silence, until sound returns', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'a', tag: 'audio', src: '/tone.wav?parts=s3,t3' });
    await play(p, 'a');
    await waitFor(p, (s) => s.status.mode === 'waiting' && s.status.detail === 'No sound.', 5000, "'idle' mapped to No sound.");
    const s = await waitFor(p, mode('unsupported'), 5000, 'silence watchdog');
    expect(s.status.detail).toBe('The sound of this media cannot be read any more. Reload the page to hear it; tab capture can then process it.');
    expect(s.status.needsTabCapture).toBeUndefined();
    await waitFor(p, mode('realtime'), 5000, 'cleared when sound returns');
  });

  it('does not report silence of media without audio, of a source heard before, or of page-made sources', async () => {
    const p = await open();
    await startController(p);
    // No audio track: nothing is decoded.
    await addMedia(p, { id: 'v', src: '/media/video-only.webm' });
    await play(p, 'v');
    await waitFor(p, (s) => s.graph.sources === 1 && s.status.detail === 'No sound.', 5000, 'video without audio routed');
    await p.waitForTimeout(1500);
    expect((await snapshot(p)).status).toMatchObject({ mode: 'waiting', detail: 'No sound.' });
    await pause(p, 'v');

    // Sound, then a long digital silence in the same source: the content is silent.
    await addMedia(p, { id: 'a', tag: 'audio', src: '/tone.wav?parts=t1,s4' });
    await play(p, 'a');
    await waitFor(p, mode('realtime'), 5000, 'tone heard');
    await waitFor(p, (s) => s.status.detail === 'No sound.', 5000, 'silence after the tone');
    await p.waitForTimeout(1500);
    expect((await snapshot(p)).status).toMatchObject({ mode: 'waiting', detail: 'No sound.' });
    await pause(p, 'a');

    // A blob: source is made by the page and cannot be tainted.
    await p.evaluate(async () => {
      const blob = await (await fetch('/tone.wav?parts=s4,t1')).blob();
      const el = document.createElement('audio');
      el.id = 'b';
      el.src = URL.createObjectURL(blob);
      document.body.appendChild(el);
      await el.play();
    });
    await waitFor(p, (s) => s.current?.src.startsWith('blob:') === true && s.status.detail === 'No sound.', 5000, 'blob source current');
    await p.waitForTimeout(1500);
    expect((await snapshot(p)).status).toMatchObject({ mode: 'waiting', detail: 'No sound.' });
  });

  it('names the cross-origin frame that probably holds the player when the page has no media', async () => {
    const p = await open();
    await p.evaluate((other) => {
      const f = document.createElement('iframe');
      f.src = `${other}/page.html`;
      f.allowFullscreen = true;
      f.style.cssText = 'width:640px;height:360px';
      document.body.appendChild(f);
      const ad = document.createElement('iframe');
      ad.src = 'http://ads.invalid/banner';
      ad.style.cssText = 'width:300px;height:250px';
      document.body.appendChild(ad);
    }, h.otherOrigin);
    await startController(p);
    const s = await waitFor(p, mode('unsupported'), 3000);
    expect(s.status).toMatchObject({ detail: 'The video plays in a frame from localhost.', needsTabCapture: true });
  });
});

describe('audio path and engine lifecycle', () => {
  it('takes the mixer out of the path while disabled, releases the engine, and comes back', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'));
    await dispatch(p, { type: 'tab-command', command: 'disable' });
    let s = await snapshot(p);
    expect(s.status.mode).toBe('off');
    expect(s.mixer?.test?.config?.enabled).toBeDefined();
    s = await waitFor(p, (x) => x.graph.path === 'direct', 1000, 'direct path');
    // The engine is released after TEST_TIMING.disabledEngine.
    await waitFor(p, (x) => x.engine === 'none', 3000, 'engine released');
    expect(engineFrames(p)).toHaveLength(0);

    await dispatch(p, { type: 'tab-command', command: 'enable' });
    s = await snapshot(p);
    expect(s.graph).toMatchObject({ path: 'worklet', settling: 'worklet' });
    s = await waitFor(p, mode('realtime'), 10_000, 'realtime again');
    expect(s.mixer?.test?.config?.enabled).toBe(true);
    expect(await tokens(p)).toHaveLength(2);
  });

  it('leaves the mixer only once it can have reached bypass, which takes longer with a large output latency', async () => {
    const p = await open();
    // A Bluetooth-like output (300 ms): look-ahead output led by that much, held as silence first.
    await evaluate(p, () => {
      Object.defineProperty(AudioContext.prototype, 'outputLatency', { configurable: true, get: () => 0.3 });
    });
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, (x) => x.status.mode === 'realtime' && (x.mixer?.test?.config?.outputLatency ?? 0) >= 14400, 5000, 'output latency sent');
    const t0 = Date.now();
    await dispatch(p, { type: 'tab-command', command: 'disable' });
    await p.waitForTimeout(250);
    expect((await snapshot(p)).graph).toMatchObject({ path: 'worklet', settling: 'direct' });
    await waitFor(p, (x) => x.graph.path === 'direct', 2000, 'direct path');
    // Output latency + 60 ms (more than settle, 100 ms here).
    expect(Date.now() - t0).toBeGreaterThanOrEqual(360);
  });

  it('follows the master switch', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'));
    await p.evaluate(() => (window as unknown as { __ext: { setSettings(s: unknown): void } }).__ext.setSettings({ enabled: false }));
    await waitFor(p, (x) => x.status.mode === 'off' && x.graph.path === 'direct', 1000);
    await p.evaluate(() => (window as unknown as { __ext: { setSettings(s: unknown): void } }).__ext.setSettings({ enabled: true }));
    await waitFor(p, mode('realtime'), 10_000);
  });

  it('stands down while tab capture processes the tab', async () => {
    const p = await open({ captureActive: true });
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await p.waitForTimeout(500);
    let s = await snapshot(p);
    expect(s.status).toMatchObject({ mode: 'off', enabled: true, detail: 'Tab capture is processing this tab.' });
    expect(s.graph.sources).toBe(0);
    expect((await extState(p)).sent.some((m) => m.type === 'get-tab-state')).toBe(true);
    await dispatch(p, { type: 'capture-state', active: false });
    await waitFor(p, mode('realtime'), 10_000, 'processing after capture stopped');
    await dispatch(p, { type: 'capture-state', active: true });
    s = await waitFor(p, (x) => x.graph.path === 'direct', 1000);
    expect(s.status.detail).toBe('Tab capture is processing this tab.');
  });

  it('restores the direct path when the mixer fails', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'));
    await evaluate(p, () => (window as unknown as { __controller: { node: AudioWorkletNode } }).__controller.node.port.postMessage({ type: 'test-throw' }));
    const s = await waitFor(p, mode('passthrough'), 3000, 'failure reported');
    expect(s.status).toMatchObject({ detail: 'Processing failed; the original audio was restored.', needsTabCapture: true });
    expect(s.graph.path).toBe('direct');
    expect(s.engine).toBe('none');
    // Nothing else gets routed into the dead mixer.
    await addMedia(p, { id: 'w', src: '/media/video.webm?w' });
    await play(p, 'w');
    await p.waitForTimeout(300);
    expect((await snapshot(p)).graph.sources).toBe(1);
  });

  it('replaces an engine that never gets ready, at most once per restart interval', async () => {
    const p = await open({ engineMode: 'no-ready' });
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, (s) => s.engine === 'connecting', 5000);
    expect((await snapshot(p)).status.mode).toBe('starting');
    // engineReady 800 ms: the first replacement happens as soon as the engine is found broken, later
    // ones at most once per engineRestart (1500 ms).
    await p.waitForFunction(() => (window as unknown as { __ext: { state: { tokens: string[] } } }).__ext.state.tokens.length >= 4, null, {
      timeout: 8000,
    });
    const times = (await extState(p)).tokenTimes;
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(800 - 20);
    expect(times[1]! - times[0]!).toBeLessThan(1500);
    for (let i = 2; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1500 - 20);
    expect(new Set(await tokens(p)).size).toBe(times.length);
  });

  it('replaces an engine that stopped reporting after its real-time worker ran, or whose iframe the page removed', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'));
    await p.waitForTimeout(500);
    await controlEngine(p, { stopStatus: true });
    // No message for engineSilent (1.5 s) while hops flow: replaced at once (the first replacement).
    await p.waitForFunction(() => (window as unknown as { __ext: { state: { tokens: string[] } } }).__ext.state.tokens.length === 2, null, { timeout: 5000 });
    await waitFor(p, (s) => s.engine === 'ready');
    // Later replacements wait for engineRestart (1.5 s).
    await p.waitForTimeout(1600);
    await evaluate(p, () => document.querySelector('iframe')!.remove());
    await p.waitForFunction(() => (window as unknown as { __ext: { state: { tokens: string[] } } }).__ext.state.tokens.length === 3, null, { timeout: 5000 });
    await waitFor(p, mode('realtime'), 5000);
  });

  it('reports steadily playing media rarely', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'));
    await p.waitForTimeout(300);
    const before = (await extState(p)).sent.filter((m) => m.type === 'tab-status').length;
    await p.waitForTimeout(2500);
    const after = (await extState(p)).sent.filter((m) => m.type === 'tab-status').length;
    expect(after - before).toBeLessThanOrEqual(1);
  });
});

describe('real-time worker health', () => {
  it('counts the health only once the worker is ready, then restarts only the real-time worker', async () => {
    const p = await open({ engineMode: 'rt-loading' });
    // A long engineReady: the model load may take its time.
    await startController(p, 'generic', { ...TEST_TIMING, engineReady: 5000 });
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, (s) => s.engine === 'ready' && s.mixer?.mode === 'realtime', 10_000, 'engine ready');
    // The mixer reports no answers while the model loads: no reaction (rtUnhealthy is 600 ms).
    await patchMixerStats(p, { rtHealthy: false });
    await p.waitForTimeout(1500);
    expect(await restarts(p)).toHaveLength(0);
    expect(await tokens(p)).toHaveLength(1);

    await controlEngine(p, { rtReady: true });
    await p.waitForFunction(
      () => (window as unknown as { __controller: { rtReadySeen: boolean } }).__controller.rtReadySeen,
      null,
      { timeout: 2000 },
    );
    const before = (await snapshot(p)).mixer!.test!.playback.length;
    await waitFor(p, (s) => s.mixer?.test?.connects.length === 3, 3000, 'new real-time channel');
    const log = await restarts(p);
    expect(log).toHaveLength(1);
    expect(log[0]!.ports).toBe(1);
    const s = await waitFor(p, (x) => x.mixer?.rtHealthy === true, 2000, 'fresh real-time session');
    expect(s.mixer!.test!.connects).toEqual(['connect-rt', 'connect-la', 'connect-rt']);
    // The engine (with its look-ahead worker) stays; the mixer hears the playback state again.
    expect(await tokens(p)).toHaveLength(1);
    expect(engineFrames(p)).toHaveLength(1);
    expect(s.mixer!.test!.playback.length).toBeGreaterThan(before);
    expect(s.mixer!.test!.playback.at(-1)).toBe(true);
  });

  it('leaves the real-time worker alone while look-ahead output is heard', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, (s) => s.engine === 'ready' && s.status.mode === 'realtime');
    await p.waitForTimeout(500);
    await patchMixerStats(p, { mode: 'lookahead', locked: true, rtHealthy: false });
    await waitFor(p, mode('lookahead'), 2000);
    await p.waitForTimeout(1500);
    expect(await restarts(p)).toHaveLength(0);
    // The lock is lost: the real-time path is heard again, and its worker is restarted.
    await patchMixerStats(p, { rtHealthy: false });
    await waitFor(p, (s) => s.mixer?.test?.connects.length === 3, 3000, 'real-time worker restarted');
    expect(await restarts(p)).toHaveLength(1);
    expect(await tokens(p)).toHaveLength(1);
  });

  it('does not let idle stretches reset the health clock', async () => {
    const p = await open();
    await startController(p, 'generic', { ...TEST_TIMING, rtUnhealthy: 2000 });
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, (s) => s.engine === 'ready' && s.status.mode === 'realtime');
    await p.waitForTimeout(500);
    await patchMixerStats(p, { rtHealthy: false });
    await p.waitForTimeout(1000);
    // Idle (no hops; a mixer may report healthy then): no restart, and the clock keeps running.
    await patchMixerStats(p, { mode: 'idle', rtHealthy: true });
    await p.waitForTimeout(1500);
    expect(await restarts(p)).toHaveLength(0);
    const t0 = Date.now();
    await patchMixerStats(p, { rtHealthy: false });
    await waitFor(p, (s) => s.mixer?.test?.connects.length === 3, 3000, 'restart after the idle stretch');
    // Unhealthy since 2.5 s already: at once, not after another rtUnhealthy (2 s).
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('restarts a real-time worker that never gets ready, without replacing the engine', async () => {
    const p = await open({ engineMode: 'silent' });
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, (s) => s.engine === 'ready' && s.mixer?.mode === 'realtime');
    // engineReady (800 ms) after its start: restarted at once, then at most once per engineRestart (1.5 s).
    await waitFor(p, (s) => s.mixer?.test?.connects.length === 3, 3000, 'first restart');
    await p.waitForTimeout(800);
    expect(await restarts(p)).toHaveLength(1);
    await waitFor(p, (s) => s.mixer?.test?.connects.length === 4, 3000, 'second restart');
    // No status messages at all, but the engine was never seen running its worker: it stays.
    expect(await tokens(p)).toHaveLength(1);
  });
});

describe('playback state for the mixer', () => {
  it('reports whether the current element plays normally', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    const last = (s: { mixer: { test?: { playback: boolean[] } } | null }) => s.mixer?.test?.playback.at(-1);
    await waitFor(p, (s) => s.status.mode === 'realtime' && last(s) === true && s.graph.playing === true, 5000, 'playing');
    await pause(p, 'v');
    await waitFor(p, (s) => last(s) === false && s.graph.playing === false, 2000, 'paused');
    await play(p, 'v');
    await waitFor(p, (s) => last(s) === true, 2000, 'playing again');
    await evaluate(p, () => void ((document.getElementById('v') as HTMLMediaElement).playbackRate = 1.5));
    await waitFor(p, (s) => last(s) === false, 2000, 'not at normal speed');
    await evaluate(p, () => void ((document.getElementById('v') as HTMLMediaElement).playbackRate = 1));
    let s = await waitFor(p, (x) => last(x) === true, 2000, 'normal speed');
    // A seek stops look-ahead output until the element plays again.
    const n = s.mixer!.test!.playback.length;
    await evaluate(p, () => void ((document.getElementById('v') as HTMLMediaElement).currentTime = 2));
    s = await waitFor(p, (x) => (x.mixer?.test?.playback.length ?? 0) >= n + 2 && last(x) === true, 3000, 'seeked');
    expect(s.mixer!.test!.playback.slice(n)).toEqual([false, true]);
  });

  it('follows the current element, and reports nothing playing without one', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'a', src: '/media/video.webm' });
    await addMedia(p, { id: 'b', src: '/media/video.webm?b' });
    await play(p, 'a');
    await waitFor(p, (s) => s.status.mode === 'realtime' && s.graph.playing === true);
    await play(p, 'b');
    await waitFor(p, (s) => s.graph.sources === 2);
    await pause(p, 'a');
    // b takes over at the next tick and plays.
    await waitFor(p, (s) => s.current?.src.endsWith('?b') === true && s.mixer?.test?.playback.at(-1) === true, 3000, 'b current');
    // Removed (which pauses it): released, and nothing else plays.
    await evaluate(p, () => document.getElementById('b')!.remove());
    await waitFor(p, (s) => s.current === null && s.mixer?.test?.playback.at(-1) === false && s.graph.playing === false, 3000, 'no current element');
  });
});

describe('media lifetime', () => {
  it('releases routed elements the page removed, and gives them their path back if they play again', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, (s) => s.status.mode === 'realtime' && s.graph.sources === 1);
    await evaluate(p, () => {
      const v = document.getElementById('v')!;
      (window as unknown as { __v: Element }).__v = v;
      v.remove();
    });
    let s = await waitFor(p, (x) => x.graph.sources === 0 && x.current === null, 2000, 'released');
    expect(s.status).toMatchObject({ mode: 'waiting', detail: 'Waiting for a video to play.' });
    // Back in the page and playing: connected again at once (it cannot be routed twice).
    await evaluate(p, () => {
      const v = (window as unknown as { __v: HTMLMediaElement }).__v;
      document.body.appendChild(v);
      return v.play();
    });
    expect((await snapshot(p)).graph.sources).toBe(1);
    s = await waitFor(p, (x) => x.status.mode === 'realtime' && x.current !== null, 3000, 'processed again');
    expect(s.status.detail).toBeUndefined();
    // An element that stays in the page keeps its node across 'emptied' (players reuse elements).
    await evaluate(p, () => {
      const v = (window as unknown as { __v: HTMLMediaElement }).__v;
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
    await p.waitForTimeout(400);
    expect((await snapshot(p)).graph.sources).toBe(1);
  });

  it('does not keep removed media alive itself', async () => {
    const p = await open();
    // Chrome's AudioContext keeps every element it made a MediaElementAudioSourceNode for alive
    // until it is closed (connected or not): stand in for a Web Audio that does not, so that only
    // the controller's own references count.
    await evaluate(p, () => {
      AudioContext.prototype.createMediaElementSource = function (this: AudioContext) {
        return this.createGain() as unknown as MediaElementAudioSourceNode;
      };
    });
    await startController(p);
    await evaluate(p, () => {
      const w = window as unknown as { __refs: WeakRef<HTMLMediaElement>[] };
      w.__refs = [];
      for (let i = 0; i < 3; i++) {
        const v = document.createElement('video');
        v.src = `/media/video-only.webm?feed=${i}`;
        v.loop = true;
        document.body.appendChild(v);
        w.__refs.push(new WeakRef(v));
        void v.play();
      }
    });
    await waitFor(p, (s) => s.graph.sources === 3 && s.current !== null, 10_000, 'three routed');
    // Like a feed that scrolled on: removed (and paused by that), not torn down.
    await evaluate(p, () => {
      for (const v of document.querySelectorAll('video')) v.remove();
    });
    await waitFor(p, (s) => s.graph.sources === 0 && s.current === null, 2000, 'released');
    const cdp = await p.context().newCDPSession(p);
    let alive = 3;
    for (let i = 0; i < 20 && alive > 0; i++) {
      await cdp.send('HeapProfiler.collectGarbage');
      await p.waitForTimeout(200);
      alive = await evaluate(p, () => (window as unknown as { __refs: WeakRef<object>[] }).__refs.filter((r) => r.deref()).length);
    }
    expect(alive).toBe(0);
  });
});

describe('media in shadow roots', () => {
  it('finds media in a shadow root created after the current element stopped', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'));
    await pause(p, 'v');
    await evaluate(p, () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const v = document.createElement('video');
      v.src = '/media/video.webm?shadow';
      v.loop = true;
      host.attachShadow({ mode: 'open' }).appendChild(v);
      void v.play();
    });
    // Found by the walk (every 300 ms here while nothing plays audibly).
    await waitFor(p, (s) => s.current?.src.endsWith('?shadow') === true && s.status.mode === 'realtime', 5000, 'shadow video processed');
  });

  it('watches a new shadow root as soon as the user clicks into it', async () => {
    const p = await open();
    // No periodic walk during the test.
    await startController(p, 'generic', { ...TEST_TIMING, discovery: 60_000 });
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'));
    await evaluate(p, () => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: 'open' });
      const v = document.createElement('video');
      v.src = '/media/video.webm?shadow';
      v.loop = true;
      v.muted = true;
      const button = document.createElement('button');
      button.id = 'unmute';
      button.textContent = 'Unmute';
      button.onclick = () => {
        v.muted = false;
      };
      root.append(v, button);
      void v.play();
    });
    await p.waitForTimeout(300);
    expect((await snapshot(p)).graph.sources).toBe(1);
    await p.locator('#unmute').click();
    await waitFor(p, (s) => s.graph.sources === 2, 5000, 'unmuted shadow video routed');
  });
});

describe('look-ahead replay', () => {
  const handshakes = (p: Page) => evaluate(p, () => (window as unknown as { __handshakes: number }).__handshakes);

  async function openYouTube(): Promise<Page> {
    const p = await open();
    await evaluate(p, () => {
      const w = window as unknown as { __handshakes: number };
      w.__handshakes = 0;
      window.addEventListener('message', (e) => {
        if ((e.data as Record<string, unknown> | null)?.__bgmr_hook_connect__ === true) w.__handshakes++;
      });
    });
    await startController(p, 'youtube');
    await dispatch(p, { type: 'tab-command', command: 'enable' });
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, (s) => s.engine === 'ready' && s.status.mode === 'realtime');
    expect(await handshakes(p)).toBe(1);
    return p;
  }

  it("reconnects the hook when look-ahead comes back after the worker dropped its audio (quality 'realtime' → 'auto')", async () => {
    const p = await openYouTube();
    // Shorter than lookaheadSuspend (500 ms): the worker kept its audio, no replay.
    await setSettings(p, { quality: 'realtime' });
    await p.waitForTimeout(200);
    await setSettings(p, { quality: 'auto' });
    await p.waitForTimeout(200);
    expect(await handshakes(p)).toBe(1);
    await setSettings(p, { quality: 'realtime' });
    await p.waitForTimeout(700);
    await setSettings(p, { quality: 'auto' });
    await p.waitForFunction(() => (window as unknown as { __handshakes: number }).__handshakes === 2, null, { timeout: 1000 });
    const settings = (await engineLog(p)).filter((e) => e.type === 'settings').map((e) => e.settings?.quality);
    expect(settings.slice(-4)).toEqual(['realtime', 'auto', 'realtime', 'auto']);
    expect(await tokens(p)).toHaveLength(1);
  });

  it('reconnects the hook when the tab is switched back on before the engine is released', async () => {
    const p = await openYouTube();
    await dispatch(p, { type: 'tab-command', command: 'disable' });
    // Past lookaheadSuspend (500 ms), before disabledEngine (800 ms).
    await p.waitForTimeout(600);
    await dispatch(p, { type: 'tab-command', command: 'enable' });
    await p.waitForFunction(() => (window as unknown as { __handshakes: number }).__handshakes === 2, null, { timeout: 1000 });
    expect(await tokens(p)).toHaveLength(1);
  });
});

describe('extension lifecycle', () => {
  it('hands the audio back and stops when the extension goes away', async () => {
    const p = await open();
    await startController(p);
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    await waitFor(p, mode('realtime'));
    await p.evaluate(() => (window as unknown as { __ext: { kill(): void } }).__ext.kill());
    const s = await waitFor(p, (x) => x.graph.path === 'direct', 2000, 'direct path after invalidation');
    expect(s.engine).toBe('none');
    expect(engineFrames(p)).toHaveLength(0);
    expect(await evaluate(p, () => (window as unknown as { __controller: { isShutDown: boolean } }).__controller.isShutDown)).toBe(true);
    expect(await evaluate(p, () => (window as unknown as { __ext: { listenerCount(): number } }).__ext.listenerCount())).toBe(0);
    // Dead: new media is left alone. (The debug bridge of test builds still answers.)
    await addMedia(p, { id: 'w', src: '/media/video.webm?w' });
    await play(p, 'w');
    await p.waitForTimeout(300);
    expect((await snapshot(p)).graph.sources).toBe(1);
    const reply = await p.evaluate(
      () =>
        new Promise((resolve) => {
          window.addEventListener('message', (e) => e.data?.__bgmr_debug_reply && resolve(e.data));
          window.postMessage({ __bgmr_debug: 'status' }, '*');
        }),
    );
    expect(reply).toMatchObject({ shutDown: true, status: { mode: 'off' }, graph: { path: 'direct' }, engine: 'none' });
  });

  it('answers the debug bridge while alive', async () => {
    const p = await open();
    await startController(p);
    const reply = await p.evaluate(
      () =>
        new Promise<{ status?: { mode: string }; graph?: unknown }>((resolve) => {
          window.addEventListener('message', (e) => e.data?.__bgmr_debug_reply === 'status' && resolve(e.data));
          window.postMessage({ __bgmr_debug: 'status' }, '*');
        }),
    );
    expect(reply.status?.mode).toBe('waiting');
    expect(reply.graph).toMatchObject({ path: 'worklet', sources: 0 });
  });

  it('lets a second injection of the generic script take the controller over', async () => {
    const p = await open();
    await p.evaluate(() => {
      const c = (window as unknown as { __content: { startController(ctx: unknown, site: string): unknown; context(): unknown } }).__content;
      (window as unknown as { __first: unknown }).__first = c.startController(c.context(), 'generic');
    });
    await addMedia(p, { id: 'v', src: '/media/video.webm' });
    await play(p, 'v');
    const same = await p.evaluate(async () => {
      const w = window as unknown as {
        __content: { startController(ctx: unknown, site: string): unknown; context(): unknown };
        __first: { status(): { mode: string }; isShutDown: boolean };
        __bgmrGeneric: unknown;
      };
      for (let i = 0; i < 100 && w.__first.status().mode !== 'realtime'; i++) await new Promise((r) => setTimeout(r, 100));
      // WXT invalidates the first context when the same script starts again in the frame.
      const second = w.__content.startController(w.__content.context(), 'generic');
      await new Promise((r) => setTimeout(r, 600));
      return { same: second === w.__first, dead: w.__first.isShutDown, mode: w.__first.status().mode };
    });
    expect(same).toEqual({ same: true, dead: false, mode: 'realtime' });
  });

  it('does not start the generic controller where the YouTube controller runs', async () => {
    const p = await open();
    const started = await p.evaluate(() => {
      const c = (window as unknown as { __content: { startController(ctx: unknown, site: string): unknown; context(name: string): unknown } }).__content;
      const yt = c.startController(c.context('youtube'), 'youtube');
      const generic = c.startController(c.context('generic'), 'generic');
      return { yt: yt !== null, generic };
    });
    expect(started).toEqual({ yt: true, generic: null });
  });
});
