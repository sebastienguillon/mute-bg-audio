import { chromium, test as base, type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAMPLE_RATE } from '../../src/lib/constants';
import type { MixerStats, TabStatus } from '../../src/lib/protocol';
// @ts-expect-error plain JS module
import { startServer } from './server.mjs';

/**
 * The e2e build (`pnpm build:e2e`), which has the debug bridge the tests use (production builds do
 * not). BGMR_EXTENSION selects another build with it, e.g. `.output/chrome-mv3-dev` while `pnpm dev` runs.
 */
const outputDir = resolve(process.env.BGMR_EXTENSION ?? '.output/chrome-mv3-e2e');
if (!existsSync(join(outputDir, 'manifest.json'))) throw new Error(`${outputDir} is missing. Run \`pnpm build:e2e\` first.`);
export const extensionPath = realpathSync(outputDir);

/**
 * ID Chrome gives an unpacked extension without a manifest key: the SHA-256 of its absolute path,
 * first 32 hex digits mapped 0-f → a-p. Known before launch, so it can be allowlisted for tab
 * capture (which otherwise needs a click on the extension's action).
 */
export const extensionId = [...createHash('sha256').update(extensionPath).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16)))
  .join('');

export const YT = 'https://www.youtube.com';

export interface Fixtures {
  server: { port: number };
  context: BrowserContext;
  background: Worker;
  /** Writes extension settings (merged over the stored ones); the controllers follow storage changes live. */
  setSettings: (s: Record<string, unknown>) => Promise<void>;
  /** Sends a runtime message from an extension page (popup.html in its own tab), as the popup does. */
  extensionMessage: (msg: Record<string, unknown>) => Promise<any>;
}

export const test = base.extend<Fixtures>({
  server: [
    async ({}, use) => {
      const server: Server = await startServer(0);
      await use({ port: (server.address() as AddressInfo).port });
      server.close();
    },
    { scope: 'test' },
  ],
  context: async ({ server }, use) => {
    const profile = mkdtempSync(join(tmpdir(), 'bgmr-e2e-'));
    const map = (host: string) => `MAP ${host} 127.0.0.1:${server.port}`;
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      viewport: { width: 1100, height: 760 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        `--allowlisted-extension-id=${extensionId}`,
        `--host-resolver-rules=${['www.youtube.com', 'music.youtube.com', 'media.test'].map(map).join(',')}`,
        '--ignore-certificate-errors',
        '--autoplay-policy=no-user-gesture-required',
        '--enable-unsafe-webgpu',
      ],
    });
    await use(context);
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  },
  background: async ({ context }, use) => {
    const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(sw.url()).host;
    if (id !== extensionId) throw new Error(`extension id ${id}, expected ${extensionId} (the computed id is used for allowlisting)`);
    await use(sw);
  },
  setSettings: async ({ background }, use) => {
    await use(async (s) => {
      await background.evaluate(async (patch) => {
        const storage = (globalThis as any).chrome.storage.local;
        const cur = (await storage.get('settings')).settings ?? {};
        await storage.set({ settings: { ...cur, ...patch } });
      }, s);
    });
  },
  extensionMessage: async ({ context, background }, use) => {
    let page: Page | null = null;
    await use(async (msg) => {
      if (!page) {
        page = await context.newPage();
        await page.goto(`chrome-extension://${new URL(background.url()).host}/popup.html`);
      }
      return page.evaluate((m) => (globalThis as any).chrome.runtime.sendMessage(m), msg);
    });
  },
});

export const expect = test.expect;

/** What the page controller's debug bridge reports (src/content/controller.ts debugSnapshot). */
export interface DebugSnapshot {
  status: TabStatus;
  shutDown: boolean;
  /** Last mixer stats (frozen once the controller shut down). */
  mixer: MixerStats | null;
  /**
   * Where routed audio goes (through the mixer or straight to the speakers), how many routed
   * elements are in the graph (released ones are not), and the playback state last sent to the
   * mixer (null before the first).
   */
  graph: { path: 'worklet' | 'direct'; settling: 'worklet' | 'direct' | null; sources: number; playing: boolean | null };
  engine: 'none' | 'starting' | 'connecting' | 'ready';
  current: { src: string; paused: boolean; muted: boolean; volume: number } | null;
}

/** Snapshot from the page controller's debug bridge; null when no controller answers. */
export async function debugStatus(page: Page): Promise<DebugSnapshot | null> {
  return page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const onMsg = (e: MessageEvent) => {
          if (e.data?.__bgmr_debug_reply !== 'status') return;
          window.removeEventListener('message', onMsg);
          resolve(e.data);
        };
        window.addEventListener('message', onMsg);
        window.postMessage({ __bgmr_debug: 'status' }, '*');
        setTimeout(() => resolve(null), 2000);
      }),
  );
}

/** Polls the debug status until `accept` holds; returns that snapshot. */
export async function waitForStatus(
  page: Page,
  accept: (s: DebugSnapshot) => boolean,
  what: string,
  timeoutMs = 30_000,
  intervalMs = 250,
): Promise<DebugSnapshot> {
  const t0 = Date.now();
  let last: DebugSnapshot | null = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await debugStatus(page);
    if (last && accept(last)) return last;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(`${what} not reached in ${timeoutMs} ms; last: ${JSON.stringify(last)}`);
}

export async function waitForMode(page: Page, modes: string[], timeoutMs = 60_000): Promise<DebugSnapshot> {
  return waitForStatus(page, (s) => modes.includes(s.status.mode), `mode ${modes.join('/')}`, timeoutMs, 500);
}

export interface Recording {
  /** The mixer's undelayed input x[f] (stereo). */
  input: Float32Array[];
  /** Its output y[f] for the same frames: leads x by the sink latency in look-ahead mode, lags by L in real-time mode. */
  output: Float32Array[];
}

/**
 * Records the mixer's input and output for the next `seconds` (from when the worklet gets the
 * request). Rejects when the mixer is not in the audio path.
 */
export async function record(page: Page, seconds: number): Promise<Recording> {
  const b64 = await page.evaluate(
    (s) =>
      new Promise<{ input: string[]; output: string[] }>((resolve, reject) => {
        const enc = (a: Float32Array) => {
          const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
          let bin = '';
          for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
          return btoa(bin);
        };
        const onMsg = (e: MessageEvent) => {
          if (e.data?.__bgmr_debug_reply !== 'recording') return;
          window.removeEventListener('message', onMsg);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve({ input: e.data.input.map(enc), output: e.data.output.map(enc) });
        };
        window.addEventListener('message', onMsg);
        window.postMessage({ __bgmr_debug: 'record', seconds: s }, '*');
        setTimeout(() => reject(new Error('recording timed out')), (s + 15) * 1000);
      }),
    seconds,
  );
  const dec = (s: string) => {
    const buf = Buffer.from(s, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4).slice();
  };
  return { input: b64.input.map(dec), output: b64.output.map(dec) };
}

export async function startPlayback(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const v = document.querySelector('video')!;
    v.muted = false;
    await v.play();
  });
}

/** Waits until the first <video> has played to media time `t` (s). */
export async function waitForMediaTime(page: Page, t: number, timeoutMs = 60_000): Promise<void> {
  await page.waitForFunction((t) => document.querySelector('video')!.currentTime >= t, t, { timeout: timeoutMs, polling: 20 });
}

export async function mediaTime(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('video')!.currentTime);
}

/** Media time of the first <video>, sampled twice `ms` apart: whether it advances. */
export async function playbackAdvances(page: Page, ms = 500): Promise<boolean> {
  const t0 = await page.evaluate(() => document.querySelector('video')!.currentTime);
  await page.waitForTimeout(ms);
  return (await page.evaluate(() => document.querySelector('video')!.currentTime)) > t0;
}

/** Engine iframes in the page: <iframe> elements with the extension's URL, and extension frames. */
export async function engineFrames(page: Page): Promise<number> {
  const elements = await page.evaluate(() => document.querySelectorAll('iframe[src^="chrome-extension:"]').length);
  return elements + page.frames().filter((f) => f.url().startsWith('chrome-extension:')).length;
}

export async function tabIdOf(background: Worker, url: string): Promise<number> {
  const id = await background.evaluate(
    async (u) => ((await (globalThis as any).chrome.tabs.query({})) as { id: number; url?: string }[]).find((t) => t.url?.startsWith(u))?.id,
    url,
  );
  if (id === undefined) throw new Error(`no tab with ${url}`);
  return id;
}

/** Sends a runtime message from the background to the content scripts of a tab (as the popup's commands arrive). */
export async function sendToTab(background: Worker, tabId: number, msg: Record<string, unknown>, frameId = 0): Promise<any> {
  return background.evaluate(
    ({ tabId, msg, frameId }) => (globalThis as any).chrome.tabs.sendMessage(tabId, msg, { frameId }),
    { tabId, msg, frameId },
  );
}

/** Where a routed element's audio goes, as traced in the extension's world. */
export interface AudioRoutes {
  /** Per MediaElementAudioSourceNode: its destinations ('speakers', 'mixer' or the node type). */
  sources: string[][];
  /** Destinations of the mixer (AudioWorkletNode). */
  mixer: string[];
}

/**
 * The content scripts' isolated world in the top frame, through the DevTools protocol. Used to
 * look at what the debug bridge does not report (the real Web Audio connections, the sink latency
 * the mixer was given) and to see uncaught exceptions in every world of the page.
 */
export class ExtensionWorld {
  /** Uncaught exceptions in any world of the page (the page's own and the content scripts'). */
  readonly exceptions: string[] = [];
  private readonly contexts = new Map<number, { origin: string; frameId?: string; type?: string }>();

  private constructor(private readonly cdp: CDPSession) {
    cdp.on('Runtime.executionContextCreated', ({ context }) => {
      this.contexts.set(context.id, { origin: context.origin, frameId: context.auxData?.frameId, type: context.auxData?.type });
    });
    cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => this.contexts.delete(executionContextId));
    cdp.on('Runtime.executionContextsCleared', () => this.contexts.clear());
    cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
      this.exceptions.push(`${d.text} ${d.exception?.description ?? ''}`.trim());
    });
  }

  static async attach(page: Page): Promise<ExtensionWorld> {
    const cdp = await page.context().newCDPSession(page);
    const world = new ExtensionWorld(cdp);
    await cdp.send('Runtime.enable');
    return world;
  }

  /** Evaluates `expression` in the content scripts' world of the top frame (awaits promises). */
  async evaluate<T>(expression: string): Promise<T> {
    const { frameTree } = await this.cdp.send('Page.getFrameTree');
    const origin = `chrome-extension://${extensionId}`;
    const ids = [...this.contexts].filter(([, c]) => c.origin === origin && c.frameId === frameTree.frame.id && c.type === 'isolated');
    const contextId = ids.at(-1)?.[0];
    if (contextId === undefined) throw new Error('the content scripts are not running in the top frame');
    const r = await this.cdp.send('Runtime.evaluate', { contextId, expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result.value as T;
  }

  /**
   * Records every AudioNode connect/disconnect of the content scripts from now on. Install it
   * before the controller builds its graph (before playback starts).
   */
  traceAudioGraph(): Promise<void> {
    return this.evaluate(`(() => {
      if (globalThis.__e2eGraph) return;
      const edges = new Map();
      const proto = AudioNode.prototype;
      const { connect, disconnect } = proto;
      proto.connect = function (dest, ...rest) {
        const r = connect.call(this, dest, ...rest);
        if (dest instanceof AudioNode) (edges.get(this) ?? edges.set(this, new Set()).get(this)).add(dest);
        return r;
      };
      proto.disconnect = function (...args) {
        disconnect.apply(this, args);
        const set = edges.get(this);
        if (!set) return;
        if (args[0] instanceof AudioNode) set.delete(args[0]);
        else if (!(args[0] instanceof AudioParam)) set.clear();
      };
      globalThis.__e2eGraph = { edges, connect };
    })()`);
  }

  /** Current destinations of every traced media element source and of the mixer. */
  audioRoutes(): Promise<AudioRoutes> {
    return this.evaluate(`(() => {
      const { edges } = globalThis.__e2eGraph;
      const name = (n) => n instanceof AudioDestinationNode ? 'speakers' : n instanceof AudioWorkletNode ? 'mixer' : n.constructor.name;
      const nodes = [...edges.keys()];
      return {
        sources: nodes.filter((n) => n instanceof MediaElementAudioSourceNode).map((n) => [...edges.get(n)].map(name)),
        mixer: nodes.filter((n) => n instanceof AudioWorkletNode).flatMap((n) => [...edges.get(n)].map(name)),
      };
    })()`);
  }

  /**
   * RMS of what the traced media element sources deliver over about `ms` (an untraced analyser
   * fanned out from each): zero for an element that Web Audio cannot read.
   */
  sourceLevel(ms = 400): Promise<number> {
    return this.evaluate(`(async () => {
      const { edges, connect } = globalThis.__e2eGraph;
      const sources = [...edges.keys()].filter((n) => n instanceof MediaElementAudioSourceNode);
      let sum = 0, count = 0;
      const taps = sources.map((s) => {
        const a = s.context.createAnalyser();
        a.fftSize = 2048;
        connect.call(s, a);
        return a;
      });
      const buf = new Float32Array(2048);
      for (const end = performance.now() + ${ms}; performance.now() < end; ) {
        await new Promise((r) => setTimeout(r, 40));
        for (const a of taps) {
          a.getFloatTimeDomainData(buf);
          for (const v of buf) sum += v * v;
          count += buf.length;
        }
      }
      sources.forEach((s, i) => s.disconnect(taps[i]));
      return Math.sqrt(sum / Math.max(1, count));
    })()`);
  }

  /** Sink latency in frames the controller gave the mixer (MixerConfig.outputLatency), and what the context reports now. */
  outputLatency(): Promise<{ frames: number; baseLatency: number; outputLatency: number }> {
    return this.evaluate(`(() => {
      const c = globalThis.__bgmrYouTube ?? globalThis.__bgmrGeneric;
      return { frames: c.outputLatency, baseLatency: c.ctx.baseLatency, outputLatency: c.ctx.outputLatency };
    })()`);
  }

  /**
   * Waits until the mixer has the sink latency the context reports now. Chrome reports
   * outputLatency as 0 until audio plays; the controller re-reads it every 2 s, so for up to 2 s
   * after the graph starts the mixer only leads by baseLatency. (A device that keeps reporting 0
   * is accepted after one refresh interval.)
   */
  async waitForSinkLatency(timeoutMs = 5_000): Promise<number> {
    const t0 = Date.now();
    for (;;) {
      const s = await this.outputLatency();
      const applied = Math.abs(s.frames - Math.round((s.baseLatency + s.outputLatency) * SAMPLE_RATE)) <= 96;
      if (applied && (s.outputLatency > 0 || Date.now() - t0 > 2_500)) return s.frames;
      if (Date.now() - t0 > timeoutMs) throw new Error(`sink latency not applied: ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Whether the controller created its AudioContext. */
  hasAudioContext(): Promise<boolean> {
    return this.evaluate(`!!(globalThis.__bgmrYouTube ?? globalThis.__bgmrGeneric)?.ctx`);
  }
}
