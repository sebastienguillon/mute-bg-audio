// Page integration: which media is routed, where the extension starts, what happens to the page
// when the extension goes away or tab capture takes over, cross-origin isolated pages, the engine
// handshake, and what the production build ships.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  debugStatus,
  engineFrames,
  expect,
  extensionPath,
  ExtensionWorld,
  lookahead,
  playbackAdvances,
  record,
  startPlayback,
  switchOn,
  tabIdOf,
  test,
  waitForMode,
  waitForStatus,
  YT,
} from './fixtures';
import { rms } from './audio';

test.describe('which media is routed', () => {
  test('progressive same-origin video uses real-time mode', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    await page.goto(`${YT}/progressive.html`);
    await switchOn(page);
    await startPlayback(page);
    await waitForMode(page, ['realtime'], 60_000);
  });

  test('cross-origin media without CORS is left alone', async ({ context, server, setSettings }) => {
    await setSettings({ reductionDb: 60 });
    const page = await context.newPage();
    await page.goto(`${YT}/progressive.html?src=${encodeURIComponent(`https://media.test:${server.port}/media/video.webm`)}`);
    await switchOn(page);
    await startPlayback(page);
    const st = await waitForMode(page, ['unsupported'], 30_000);
    expect(st.status.needsTabCapture).toBe(true);
    expect(st.graph.sources).toBe(0);
  });

  test('cross-origin media with CORS is processed', async ({ context, server, setSettings }) => {
    await setSettings({ reductionDb: 60 });
    const page = await context.newPage();
    const src = `https://media.test:${server.port}/media/video.webm?cors=1`;
    await page.goto(`${YT}/progressive.html?co=anonymous&src=${encodeURIComponent(src)}`);
    await switchOn(page);
    await startPlayback(page);
    await waitForMode(page, ['realtime'], 60_000);
    const s = await debugStatus(page);
    expect(s?.mixer?.inRms ?? 0).toBeGreaterThan(0.001);
  });

  test('a same-origin URL that redirects to another site without CORS is not routed', async ({ context, server, setSettings }) => {
    await setSettings({ reductionDb: 60 });
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    const target = `https://media.test:${server.port}/media/video.webm`;
    await page.goto(`${YT}/progressive.html?src=${encodeURIComponent(`/redirect?to=${encodeURIComponent(target)}`)}`);
    await switchOn(page);
    await startPlayback(page);
    const st = await waitForMode(page, ['unsupported'], 30_000);
    console.log('redirect status', JSON.stringify(st.status));
    expect(st.status.needsTabCapture).toBe(true);
    expect(await page.evaluate(() => document.querySelector('video')!.currentSrc)).toContain('/redirect');
    // Not routed (no MediaElementAudioSourceNode, so the element plays by itself, audibly).
    await page.waitForTimeout(2000);
    const later = (await debugStatus(page))!;
    expect(later.graph.sources).toBe(0);
    expect(later.status.mode).toBe('unsupported');
    expect(await world.hasAudioContext()).toBe(false);
    expect(await playbackAdvances(page)).toBe(true);
    expect(await page.evaluate(() => { const v = document.querySelector('video')!; return !v.muted && v.volume > 0; })).toBe(true);
  });

  test('a routed element that switches to cross-origin media without CORS reports a problem', async ({ context, server, setSettings }) => {
    await setSettings({ reductionDb: 60 });
    const page = await context.newPage();
    await page.goto(`${YT}/progressive.html`);
    await switchOn(page);
    await startPlayback(page);
    await waitForMode(page, ['realtime'], 60_000);
    await page.evaluate(async (src) => {
      const v = document.querySelector('video')!;
      v.src = src;
      await v.play();
    }, `https://media.test:${server.port}/media/video.webm`);
    const st = await waitForMode(page, ['unsupported'], 15_000);
    console.log('after the switch', JSON.stringify(st.status));
    expect(st.status.detail).toMatch(/now comes from another site/);
    // The element's audio only leaves through the page's AudioContext, which now gets silence, so
    // the tab's output (what tab capture records) is silent too: only a reload helps.
    expect(st.status.detail).toMatch(/Reload the page/);
    // The popup offers a reload (tab capture would only record the silence).
    expect(st.status.needsReload).toBe(true);
    expect(st.status.needsTabCapture).toBeUndefined();
    expect(st.graph.sources).toBe(1);
  });

  test('a muted autoplaying video starts nothing until it is unmuted', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    await page.goto(`${YT}/mse.html?autoplay=1&muted=1`);
    await switchOn(page);
    await page.waitForFunction(() => document.querySelector('video')!.currentTime > 2, null, { timeout: 20_000 });
    for (let i = 0; i < 4; i++) {
      const s = (await debugStatus(page))!;
      expect(s.engine).toBe('none');
      expect(s.graph.sources).toBe(0);
      expect(s.status.mode).toBe('waiting');
      expect(await engineFrames(page)).toBe(0);
      await page.waitForTimeout(1000);
    }
    expect(await world.hasAudioContext()).toBe(false);
    await page.evaluate(() => { document.querySelector('video')!.muted = false; });
    const st = await waitForMode(page, ['lookahead'], 90_000);
    expect(st.engine).toBe('ready');
    expect(await engineFrames(page)).toBeGreaterThan(0);
  });

  test('a feed that plays and removes videos one after another keeps only the playing one in the graph', async ({ context, setSettings }) => {
    // 12 dB without the gap reduction: the posts only play their first second, which has no speech yet.
    await setSettings({ reductionDb: 12, quality: 'auto', gapReduction: false });
    const page = await context.newPage();
    await page.goto(`${YT}/feed.html`);
    await switchOn(page);
    const show = (i: number) => page.evaluate((i) => (window as any).feed.show(i), i);
    const released: number[] = [];
    for (let i = 0; i < 10; i++) {
      await show(i);
      const playing = await waitForStatus(page, (s) => s.status.mode === 'realtime' && !!s.current?.src.endsWith(`post=${i}`), `post ${i} processed`, 30_000);
      expect(playing.graph.sources).toBe(1);
      await page.waitForTimeout(500);
      // Scrolled past: paused first, or removed while it plays (which pauses it).
      await page.evaluate((i) => (window as any).feed.remove(i, i % 2 === 0), i);
      const t0 = Date.now();
      const gone = await waitForStatus(page, (s) => s.graph.sources === 0, `post ${i} released`, 3_000, 50);
      released.push(Date.now() - t0);
      expect(gone.current).toBeNull();
    }
    console.log('routed elements released', released.join(', '), 'ms after their removal');
    // A removed post shown and played again gets its path back (its source node is reused).
    await show(3);
    const again = await waitForStatus(page, (s) => s.status.mode === 'realtime' && !!s.current?.src.endsWith('post=3'), 'post 3 again', 15_000);
    expect(again.graph.sources).toBe(1);
    expect(again.status.detail).toBeUndefined();
    const rec = await record(page, 1);
    expect(rms(rec.input[0]!)).toBeGreaterThan(0.01);
    expect(rms(rec.output[0]!)).toBeGreaterThan(0.1 * rms(rec.input[0]!));
  });

  test('media in a shadow root added after a first video played and paused is processed', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    await page.goto(`${YT}/shadow.html`);
    await switchOn(page);
    await page.evaluate(() => { const v = document.getElementById('light') as HTMLVideoElement; v.muted = false; return v.play(); });
    await waitForStatus(page, (s) => s.status.mode === 'realtime' && !!s.current?.src.endsWith('player=light'), 'light-DOM video processed', 30_000);
    await page.evaluate(() => (document.getElementById('light') as HTMLVideoElement).pause());
    await waitForStatus(page, (s) => s.status.mode === 'waiting', 'paused', 5_000);
    // Played from script: no event reaches the document, the periodic search finds it.
    await page.evaluate(() => (window as any).players.add('one'));
    let t0 = Date.now();
    const one = await waitForStatus(page, (s) => s.status.mode === 'realtime' && !!s.current?.src.endsWith('player=one'), 'shadow player one processed', 10_000, 100);
    console.log('shadow player started from script: processed after', Date.now() - t0, 'ms');
    expect(one.graph.sources).toBe(2);
    // Started from a button inside its own new shadow root while player one plays (no periodic
    // search then): the click reveals the root.
    await page.evaluate(() => (window as any).players.add('two', true));
    await page.waitForTimeout(500);
    await page.locator('#two button').click();
    t0 = Date.now();
    await waitForStatus(page, (s) => s.graph.sources === 3, 'shadow player two routed', 2_500, 50);
    console.log('shadow player started by a click: routed after', Date.now() - t0, 'ms');
    await page.evaluate(() => (window as any).players.video('one').pause());
    const two = await waitForStatus(page, (s) => s.status.mode === 'realtime' && !!s.current?.src.endsWith('player=two'), 'shadow player two current', 5_000);
    expect(two.status.detail).toBeUndefined();
  });

  test('a video without an audio track is not reported as unreadable', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    await page.goto(`${YT}/progressive.html?src=/media/e2e/noaudio.webm`);
    await switchOn(page);
    await startPlayback(page);
    await waitForStatus(page, (s) => s.graph.sources === 1 && s.mixer !== null, 'routed', 30_000);
    // Beyond the silence watchdog's 8 s.
    const seen = new Set<string>();
    for (const end = Date.now() + 12_000; Date.now() < end; ) {
      const s = (await debugStatus(page))!;
      seen.add(`${s.status.mode}${s.status.detail ? ` (${s.status.detail})` : ''}`);
      expect(s.status.mode).not.toBe('unsupported');
      expect(s.mixer?.inRms ?? 0).toBe(0);
      await page.waitForTimeout(500);
    }
    console.log('statuses of the video without audio:', [...seen].join(', '));
    expect(await page.evaluate(() => document.querySelector('video')!.currentTime)).toBeGreaterThan(11);
    expect((await debugStatus(page))!.status).toMatchObject({ mode: 'waiting', detail: 'No sound.' });
  });

  test('a muted inline preview next to the main player does not disturb it', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    await page.goto(`${YT}/mse.html?preview=1`);
    await switchOn(page);
    await page.waitForFunction(() => (document.getElementById('preview') as HTMLVideoElement).currentTime > 0.5);
    await startPlayback(page);
    await waitForMode(page, ['lookahead'], 90_000);
    for (let i = 0; i < 5; i++) {
      const s = (await debugStatus(page))!;
      expect(s.current?.src).toMatch(/^blob:/);
      expect(s.graph.sources).toBe(1);
      expect(s.status.mode).toBe('lookahead');
      expect(s.status.detail).toBeUndefined();
      await page.waitForTimeout(1000);
    }
  });
});

test.describe('where the extension starts', () => {
  test('a tab starts off; switched on mid-video it reaches look-ahead, stays on through a reload, and a new tab starts off', async ({ context, background, setSettings }) => {
    test.setTimeout(300_000);
    await setSettings({ reductionDb: 60, quality: 'auto' });
    // The toolbar icons the background sets, as Chrome took them (it loads the images then).
    await background.evaluate(() => {
      const g = globalThis as any;
      g.__icons = [];
      for (const api of new Set([g.chrome, g.browser].filter((b) => b?.action))) {
        const setIcon = api.action.setIcon.bind(api.action);
        api.action.setIcon = (details: { tabId: number; path: Record<number, string> }) =>
          setIcon(details).then(
            () => void g.__icons.push({ tabId: details.tabId, path: details.path[16] }),
            (e: unknown) => void g.__icons.push({ tabId: details.tabId, path: details.path[16], error: String(e) }),
          );
      }
    });
    const icons = () => background.evaluate(() => (globalThis as any).__icons as { tabId: number; path: string; error?: string }[]);
    /** The last icon set for the tab with `url`, among those set after the first `since`. */
    const iconOf = async (url: string, since = 0) => {
      const tabId = await tabIdOf(background, url);
      return (await icons()).slice(since).filter((i) => i.tabId === tabId).at(-1)?.path;
    };

    const page = await context.newPage();
    await page.goto(`${YT}/mse.html`);
    await startPlayback(page);
    await page.waitForFunction(() => document.querySelector('video')!.currentTime > 2);
    let st = (await debugStatus(page))!;
    expect(st.status).toMatchObject({ mode: 'off', enabled: false });
    expect(st.graph.sources).toBe(0);
    expect(st.engine).toBe('none');
    await expect.poll(() => iconOf(page.url())).toBe('/icon/off/16.png');
    // What the page buffered before is replayed to the look-ahead worker (youtube-hook.content.ts).
    await switchOn(page);
    const t0 = Date.now();
    await waitForMode(page, ['lookahead'], 90_000);
    console.log('look-ahead', Date.now() - t0, 'ms after switching on mid-video');
    await expect.poll(() => iconOf(page.url())).toBe('/icon/16.png');

    // The popup's "Reload page", or any reload: the tab keeps its switch. (Chrome resets the
    // icon of a tab that navigates: the background sets it again.)
    const beforeReload = (await icons()).length;
    await page.reload();
    await startPlayback(page);
    await waitForMode(page, ['lookahead'], 90_000);
    await expect.poll(() => iconOf(page.url(), beforeReload)).toBe('/icon/16.png');

    const other = await context.newPage();
    await other.goto(`${YT}/mse.html?tab=2`);
    await startPlayback(other);
    await other.waitForFunction(() => document.querySelector('video')!.currentTime > 2);
    st = (await debugStatus(other))!;
    expect(st.status).toMatchObject({ mode: 'off', enabled: false });
    expect(st.graph.sources).toBe(0);
    await expect.poll(() => iconOf(other.url())).toBe('/icon/off/16.png');
    // Chrome loaded every image it was given.
    expect((await icons()).filter((i) => i.error)).toEqual([]);
  });
});

test.describe('extension lifecycle', () => {
  test('reloading the extension during playback hands the audio back unchanged', async ({ context, background, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    await page.goto(`${YT}/mse.html`);
    await switchOn(page);
    await world.traceAudioGraph();
    await startPlayback(page);
    await waitForMode(page, ['lookahead'], 90_000);
    expect(await engineFrames(page)).toBeGreaterThan(0);
    await background.evaluate(() => (globalThis as any).chrome.runtime.reload()).catch(() => {});
    const t0 = Date.now();
    const st = await waitForStatus(page, (s) => s.shutDown && s.graph.path === 'direct' && !s.graph.settling, 'shutdown with the direct path', 5_000, 100);
    console.log('shut down', Date.now() - t0, 'ms after the reload', JSON.stringify(st.graph));
    expect(st.engine).toBe('none');
    expect(await engineFrames(page)).toBe(0);
    // Element → speakers only (zero-latency bypass: what is played is the element's audio, unchanged).
    expect(await world.audioRoutes()).toEqual({ sources: [['speakers']], mixer: [] });
    expect(await world.sourceLevel()).toBeGreaterThan(0.01);
    expect(await playbackAdvances(page)).toBe(true);
    await expect(record(page, 1)).rejects.toThrow(/not in the audio path/);
    // No uncaught exception in any world of the page ('Extension context invalidated' included).
    await page.waitForTimeout(2000);
    expect(world.exceptions).toEqual([]);
    // (Chromium then leaves an extension loaded with --load-extension disabled
    // (DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION), so this is also what disabling or uninstalling
    // it does to the page; the reloaded instance cannot be checked here.)
  });

  test('the page removing the engine iframe: the sound keeps playing and a new engine takes over', async ({ context, setSettings }) => {
    test.setTimeout(180_000);
    await setSettings({ reductionDb: 60, quality: 'realtime' });
    const page = await context.newPage();
    await page.goto(`${YT}/mse.html?media=long&ahead=30`);
    await switchOn(page);
    await startPlayback(page);
    await waitForMode(page, ['realtime'], 60_000);
    await page.evaluate(() => document.querySelectorAll('iframe[src^="chrome-extension:"]').forEach((f) => f.remove()));
    const t0 = Date.now();
    // While the engine is gone the mixer passes the input through (no silence, no garbage).
    const rec = await record(page, 1);
    expect(rms(rec.output[0]!)).toBeGreaterThan(0.005);
    // The first replacement of a broken engine happens at once (later ones at most once a minute).
    const back = await waitForStatus(page, (s) => s.engine === 'ready' && s.status?.mode === 'realtime' && s.mixer?.rtHealthy === true, 'a new engine', 20_000);
    console.log('engine replaced', Date.now() - t0, 'ms after its iframe was removed');
    expect(back.engine).toBe('ready');
    expect(await engineFrames(page)).toBeGreaterThan(0);
  });

  // The real-time worker starts loading DeepFilterNet as it starts; its thread is kept busy for
  // longer than the mixer's 10 s wait for its 'ready' (a slow machine, or a model that loads
  // slowly). Look-ahead does not need it: the engine with its look-ahead must stay, and the
  // real-time path must start once the worker is ready.
  for (const quality of ['auto', 'realtime'] as const) {
    test(`a slow real-time model start does not replace the engine (${quality})`, async ({ context, setSettings }) => {
      await setSettings({ reductionDb: 60, quality, gapReduction: false });
      const page = await context.newPage();
      const DELAY = quality === 'auto' ? 12_000 : 6_000;
      const workers: string[] = [];
      let blocked: Promise<number> | null = null;
      page.on('worker', (w) => {
        workers.push(new URL(w.url()).pathname);
        if (w.url().includes('/realtime.worker') && !blocked) {
          // Resolves with the worker's own clock (ms since it started) when the block began.
          blocked = w.evaluate((ms) => {
            const at = performance.now();
            for (const end = Date.now() + ms; Date.now() < end; );
            return at;
          }, DELAY);
        }
      });
      await page.goto(`${YT}/mse.html?media=long&ahead=30`);
      await switchOn(page);
      await startPlayback(page);
      const t0 = Date.now();
      const mode = quality === 'auto' ? 'lookahead' : 'realtime';
      const first = await waitForStatus(page, (s) => s.mixer?.mode === mode, `${mode} mode`, DELAY + 15_000, 100);
      const firstMs = Date.now() - t0;
      await page.evaluate(() => document.querySelectorAll<HTMLIFrameElement>('iframe[src^="chrome-extension:"]').forEach((f) => (f.dataset.e2e = 'first')));
      const healthy = new Set<boolean>();
      const modes = new Set<string>();
      // Through the block and the mixer's 10 s ready timeout, and 10 s beyond.
      while (Date.now() - t0 < DELAY + 10_000) {
        const s = (await debugStatus(page))!;
        modes.add(s.mixer!.mode);
        healthy.add(s.mixer!.rtHealthy);
        expect(s.engine).toBe('ready');
        expect(await page.evaluate(() => [...document.querySelectorAll<HTMLIFrameElement>('iframe[src^="chrome-extension:"]')].map((f) => f.dataset.e2e ?? 'new'))).toEqual(['first']);
        await page.waitForTimeout(500);
      }
      const last = (await debugStatus(page))!;
      const blockedAt = await blocked!;
      console.log(`${quality}: ${mode} after ${firstMs} ms (the real-time worker was blocked ${DELAY} ms from ${blockedAt.toFixed(0)} ms after its start);`,
        'mixer modes since', [...modes].join(' '), 'rtHealthy', [...healthy].join(' '), 'workers', workers.join(' '), JSON.stringify(last.mixer));
      expect(blockedAt).toBeLessThan(300);
      if (quality === 'auto') expect(firstMs).toBeLessThan(DELAY);
      else expect(firstMs).toBeGreaterThan(DELAY);
      expect(modes).toEqual(new Set([mode]));
      // One engine, one real-time worker: neither was replaced.
      expect(workers.filter((w) => w.includes('/lookahead.worker'))).toHaveLength(1);
      expect(workers.filter((w) => w.includes('/realtime.worker'))).toHaveLength(1);
      expect(last.mixer!.rtHealthy).toBe(true);
      if (quality === 'auto') {
        // The standby real-time path works: switching to it needs no new worker.
        await setSettings({ quality: 'realtime' });
        await waitForStatus(page, (s) => s.mixer?.mode === 'realtime', 'real-time setting', 5_000);
        expect(workers).toHaveLength(2);
      }
    });
  }

  test('tab capture of a YouTube tab stands the in-page processing down', async ({ context, background, extensionMessage, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'realtime' });
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    await page.goto(`${YT}/mse.html`);
    await switchOn(page);
    await world.traceAudioGraph();
    await startPlayback(page);
    await waitForMode(page, ['realtime'], 60_000);
    const tabId = await tabIdOf(background, `${YT}/mse.html`);
    // Allowed without a click on the action: the extension id is allowlisted (fixtures.ts).
    const started = await extensionMessage({ type: 'start-tab-capture', tabId });
    console.log('start-tab-capture', JSON.stringify(started));
    expect(started?.error).toBeUndefined();
    const st = await waitForStatus(page, (s) => s.status.mode === 'off' && s.graph.path === 'direct' && !s.graph.settling, 'stood down', 10_000);
    expect(st.status.detail).toBe('Tab capture is processing this tab.');
    expect(st.status.enabled).toBe(true);
    expect(await world.audioRoutes()).toEqual({ sources: [['speakers']], mixer: [] });
    // The background reports 'starting' until the capture document has loaded its model.
    let tab: any = null;
    for (const t0 = Date.now(); tab?.mode !== 'tabcapture' && Date.now() - t0 < 15_000; ) {
      await page.waitForTimeout(250);
      tab = await extensionMessage({ type: 'get-tab-status', tabId });
    }
    console.log('tab status while capturing', JSON.stringify(tab));
    expect(tab?.mode).toBe('tabcapture');
    expect((await debugStatus(page))!.status.mode).toBe('off');
    await extensionMessage({ type: 'stop-tab-capture', tabId });
    await waitForMode(page, ['realtime'], 15_000);
    expect(await world.audioRoutes()).toEqual({ sources: [['mixer']], mixer: ['speakers'] });
  });
});

test.describe('page environments', () => {
  test('a cross-origin isolated page (COEP require-corp) reaches real-time mode', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    await page.goto(`${YT}/progressive.html?coep=1`);
    await switchOn(page);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await startPlayback(page);
    await waitForMode(page, ['realtime'], 60_000);
  });

  test('a cross-origin isolated YouTube page reaches look-ahead mode', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    await page.goto(`${YT}/mse.html?coep=1`);
    await switchOn(page);
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await startPlayback(page);
    await waitForMode(page, ['lookahead'], 90_000);
    expect(rms((await record(page, 2)).output[0]!)).toBeGreaterThan(0.005);
  });

  test('the page cannot take over the engine with its own CONNECT', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    // Registered before the controller's listener, so the page sees the engine's HELLO first and
    // answers it with a forged token and its own port.
    await page.addInitScript(() => {
      const w = window as unknown as { spoof: { connects: number; received: number } };
      w.spoof = { connects: 0, received: 0 };
      window.addEventListener(
        'message',
        (e) => {
          if (e.data?.type !== 'bgmr-engine-hello' || !e.source) return;
          const channel = new MessageChannel();
          channel.port1.onmessage = () => w.spoof.received++;
          (e.source as Window).postMessage({ type: 'bgmr-engine-connect', token: 'f'.repeat(32) }, e.origin, [channel.port2]);
          w.spoof.connects++;
        },
        true,
      );
    });
    await page.goto(`${YT}/mse.html`);
    await switchOn(page);
    await startPlayback(page);
    await waitForMode(page, ['lookahead'], 90_000);
    await page.waitForTimeout(2000);
    const spoof = await page.evaluate(() => (window as unknown as { spoof: { connects: number; received: number } }).spoof);
    console.log('forged CONNECTs', spoof.connects, 'messages the page received', spoof.received);
    expect(spoof.connects).toBeGreaterThan(0);
    expect(spoof.received).toBe(0);
  });
});

test.describe('builds', () => {
  test('the production build contains no debug bridge', async () => {
    test.setTimeout(120_000);
    // `pnpm build` (or `pnpm build:scnet`) output, production mode, rebuilt from the current
    // sources for the model under test (LOOKAHEAD_MODEL is inherited).
    execFileSync(resolve('node_modules/.bin/wxt'), ['build'], { stdio: 'pipe' });
    const markers = ['__bgmr_debug', 'bgmrDebug', 'bgmrStatus'];
    const scan = (dir: string) => {
      const hits = new Map<string, number>();
      const walk = (d: string) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (/\.(js|html)$/.test(entry.name)) {
            const text = readFileSync(p, 'utf8');
            for (const m of markers) if (text.includes(m)) hits.set(m, (hits.get(m) ?? 0) + 1);
          }
        }
      };
      walk(dir);
      return Object.fromEntries(hits);
    };
    expect(scan(resolve(`.output/chrome-mv3${lookahead.suffix}`))).toEqual({});
    // The scan finds them where they are (the e2e build).
    expect(Object.keys(scan(extensionPath)).sort()).toEqual([...markers].sort());
  });
});
