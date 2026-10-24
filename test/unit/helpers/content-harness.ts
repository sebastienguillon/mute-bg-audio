// Runs the content-script code (bundled from source with esbuild) in Playwright's Chromium against
// a scripted fake extension API. Two local HTTP servers give two origins: the page's
// (http://127.0.0.1) and another one (http://localhost) that serves cross-origin media and plays
// the extension: a stub mixer worklet and a fake engine page. Media taint, redirects, CORS,
// Web Audio routing and the WXT content-script context are the real ones.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Frame, type Page } from '@playwright/test';
import { build } from 'esbuild';
import type { ControllerTiming } from '../../../src/content/controller';
import type { RuntimeMessage, TabStatus } from '../../../src/lib/protocol';
import type { Settings } from '../../../src/lib/settings';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MEDIA = join(ROOT, 'test/fixtures/generated');

/** Short timings so the lifecycle tests run in seconds. */
export const TEST_TIMING: Partial<ControllerTiming> = {
  tick: 100,
  settle: 100,
  disabledEngine: 800,
  engineReady: 800,
  engineSilent: 1500,
  rtUnhealthy: 600,
  engineRestart: 1500,
  lookaheadSuspend: 500,
  silentInput: 600,
  discovery: 300,
  latencyRefresh: 500,
  probe: { fetchMs: 2000, frameMs: 1500, taintSettleMs: 500 },
};

export interface ContentHarness {
  browser: Browser;
  bundle: string;
  /** Origin of the test pages. */
  pageOrigin: string;
  /** Another origin: cross-origin media and the fake extension resources. */
  otherOrigin: string;
  close(): Promise<void>;
}

export interface PageOptions {
  settings?: Partial<Settings>;
  /** Answer to 'get-capture-state'. */
  captureActive?: boolean;
  /**
   * Fake engine behaviour: 'normal', 'no-ready' (never answers init), 'silent' (no status
   * messages), 'rt-loading' (its real-time worker reports ready only after setRtReady(true)).
   */
  engineMode?: EngineMode;
  /** Path of the page on the page origin (default /page.html). */
  path?: string;
}

/** Snapshot of the fake extension API's state in the page. */
export interface ExtState {
  alive: boolean;
  sent: RuntimeMessage[];
  tokens: string[];
  tokenTimes: number[];
}

export type EngineMode = 'normal' | 'no-ready' | 'silent' | 'rt-loading';

export interface Snapshot {
  status: TabStatus;
  mixer: (Record<string, unknown> & { mode: string; inRms: number; test?: StubInfo }) | null;
  graph: { path: 'worklet' | 'direct'; settling: string | null; sources: number; playing: boolean | null };
  engine: 'none' | 'starting' | 'connecting' | 'ready';
  current: { src: string; paused: boolean; muted: boolean; volume: number } | null;
}

/** What the stub worklet reports about itself (inside its stats). */
export interface StubInfo {
  config: { enabled: boolean; outputLatency: number } | null;
  options: { jitter?: number };
  connects: string[];
  /** Every 'playback' message's `playing`, in order. */
  playback: boolean[];
}

export interface EngineLogEntry {
  type: string;
  token?: string;
  playhead?: { audible: boolean; paused: boolean };
  settings?: { enabled: boolean; quality: string };
  /** Number of transferred ports. */
  ports?: number;
}

export async function startContentHarness(): Promise<ContentHarness> {
  const [bundle, browser, page, other] = await Promise.all([
    bundleContent(),
    chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }),
    listen(),
    listen(),
  ]);
  return {
    browser,
    bundle,
    pageOrigin: `http://127.0.0.1:${page.port}`,
    otherOrigin: `http://localhost:${other.port}`,
    async close() {
      await browser.close();
      await Promise.all([page.close(), other.close()]);
    },
  };
}

/** Bundles the test entry (controller, media helpers, WXT's ContentScriptContext) for the page. */
async function bundleContent(): Promise<string> {
  const result = await build({
    entryPoints: [join(ROOT, 'test/unit/helpers/content-entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
    define: { 'import.meta.env.MODE': '"test"', 'import.meta.env.ENTRYPOINT': '"content-test"' },
    plugins: [
      {
        name: 'wxt-alias',
        setup(b) {
          b.onResolve({ filter: /^@\// }, (args) => ({ path: join(ROOT, 'src', `${args.path.slice(2)}.ts`) }));
        },
      },
    ],
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error('esbuild produced no output');
  return file.text;
}

/** Opens a page with the fake extension API installed and the content bundle loaded (not started). */
export async function openContentPage(h: ContentHarness, options: PageOptions = {}): Promise<{ page: Page; errors: string[] }> {
  const context = await h.browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(installFakeExtension, {
    extOrigin: h.otherOrigin,
    settings: options.settings ?? {},
    captureActive: options.captureActive ?? false,
    engineMode: options.engineMode ?? 'normal',
  });
  await page.goto(`${h.pageOrigin}${options.path ?? '/page.html'}`);
  await page.addScriptTag({ content: h.bundle });
  return { page, errors };
}

/** Starts a MediaController in the page (exposed as window.__controller). */
export function startController(page: Page, site: 'youtube' | 'generic' = 'generic', timing = TEST_TIMING): Promise<void> {
  return page.evaluate(
    ([site, timing]) => {
      (window as unknown as { __content: { start(s: string, t: unknown): void } }).__content.start(site, timing);
    },
    [site, timing] as const,
  );
}

export function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => (window as unknown as { __controller: { debugSnapshot(): unknown } }).__controller.debugSnapshot() as Snapshot);
}

export function extState(page: Page): Promise<ExtState> {
  return page.evaluate(() => {
    const s = (window as unknown as { __ext: { state: ExtState } }).__ext.state;
    return JSON.parse(JSON.stringify({ alive: s.alive, sent: s.sent, tokens: s.tokens, tokenTimes: s.tokenTimes })) as ExtState;
  });
}

/** Polls the controller until `predicate` holds; returns the last snapshot. */
export async function waitFor(page: Page, predicate: (s: Snapshot) => boolean, timeoutMs = 10_000, what = 'condition'): Promise<Snapshot> {
  const t0 = Date.now();
  let last: Snapshot | null = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await snapshot(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(50);
  }
  throw new Error(`${what} not reached; last snapshot: ${JSON.stringify(last)}`);
}

/** Fake engine frames currently in the page. */
export function engineFrames(page: Page): Frame[] {
  return page.frames().filter((f) => f.url().includes('/engine.html'));
}

export async function engineLog(page: Page): Promise<EngineLogEntry[]> {
  const frame = engineFrames(page)[0];
  if (!frame) return [];
  return frame.evaluate(() => (window as unknown as { log: EngineLogEntry[] }).log);
}

/** Controls the fake engine: its real-time worker's readiness, or stops all its status messages. */
export async function controlEngine(page: Page, command: { rtReady?: boolean; stopStatus?: true }): Promise<void> {
  const frame = engineFrames(page)[0];
  if (!frame) throw new Error('no engine frame');
  await frame.evaluate((c) => (window as unknown as { control(c: unknown): void }).control(c), command);
}

/** Overrides fields of the stub mixer's stats (e.g. rtHealthy, mode, locked) until the next call. */
export function patchMixerStats(page: Page, patch: Record<string, unknown>): Promise<void> {
  return page.evaluate(
    (p) => (window as unknown as { __controller: { node: AudioWorkletNode } }).__controller.node.port.postMessage({ type: 'test-stats', patch: p }),
    patch,
  );
}

/** Adds a media element to the page; `src` is relative to the page origin unless absolute. */
export function addMedia(
  page: Page,
  opts: { id: string; tag?: 'video' | 'audio'; src: string; muted?: boolean; crossOrigin?: string; parent?: string },
): Promise<void> {
  return page.evaluate((o) => {
    const el = document.createElement(o.tag ?? 'video');
    el.id = o.id;
    el.muted = o.muted ?? false;
    el.loop = true;
    if (o.crossOrigin) el.crossOrigin = o.crossOrigin;
    el.src = o.src;
    if (el instanceof HTMLVideoElement) el.style.cssText = 'width:320px;height:180px';
    (o.parent ? document.querySelector(o.parent)! : document.body).appendChild(el);
  }, opts);
}

export function play(page: Page, id: string): Promise<void> {
  return page.evaluate((id) => (document.getElementById(id) as HTMLMediaElement).play(), id);
}

// ───────────── servers ─────────────

interface Listening {
  port: number;
  close(): Promise<void>;
}

function listen(): Promise<Listening> {
  const sockets = new Set<Socket>();
  const server: Server = createServer(handle);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    // All interfaces: 'localhost' may resolve to ::1.
    server.listen(0, () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

/** /flaky keys whose network "came back". */
const recovered = new Set<string>();

function handle(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const cors: Record<string, string> = url.searchParams.get('cors') === '1' ? { 'Access-Control-Allow-Origin': '*' } : {};
  const send = (type: string, body: string | Buffer) => void res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...cors }).end(body);
  switch (url.pathname) {
    case '/page.html':
      return send('text/html', '<!doctype html><html data-bgmr-debug="1"><head><meta charset="utf-8"></head><body></body></html>');
    case '/worklet.js':
      // Worklet modules are fetched in CORS mode (the extension serves it as a web-accessible resource).
      return void res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' }).end(STUB_WORKLET);
    case '/engine.html':
      return send('text/html', FAKE_ENGINE);
    case '/redirect':
      return void res.writeHead(302, { Location: url.searchParams.get('to') ?? '/', 'Cache-Control': 'no-store' }).end();
    case '/slow':
      return; // never answers
    case '/playlist.m3u8':
      return send('application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-ENDLIST\n');
    case '/tone.wav':
      return send('audio/wav', toneWav(url.searchParams.get('parts') ?? 't1'));
    case '/dead':
      return void req.socket.destroy();
    case '/flaky': {
      // The network is "down" for the probe's Range request until a request without Range (a
      // no-cors reachability check) gets through; the element's own requests always do.
      const key = url.searchParams.get('key') ?? '';
      if (req.headers.range === 'bytes=0-0' && !recovered.has(key)) return void req.socket.destroy();
      if (req.headers.range === undefined) recovered.add(key);
      return serveFile(join(MEDIA, 'video.webm'), req, res, cors);
    }
  }
  if (url.pathname.startsWith('/media/')) return serveFile(join(MEDIA, url.pathname.slice('/media/'.length)), req, res, cors);
  res.writeHead(404).end('not found');
}

function serveFile(file: string, req: IncomingMessage, res: ServerResponse, extra: Record<string, string>): void {
  if (!file.startsWith(MEDIA) || !existsSync(file)) return void res.writeHead(404).end();
  const size = statSync(file).size;
  const type = file.endsWith('.webm') ? 'video/webm' : file.endsWith('.mp4') ? 'video/mp4' : 'audio/wav';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', ...extra };
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  createReadStream(file).pipe(res);
}

/**
 * 48 kHz mono 16-bit WAV from comma-separated parts: 's<seconds>' digital silence, 't<seconds>'
 * 440 Hz tone (e.g. 's3,t3').
 */
function toneWav(parts: string): Buffer {
  const sr = 48000;
  const spans = parts.split(',').map((p) => ({ tone: p.startsWith('t'), frames: Math.round(Number(p.slice(1)) * sr) }));
  const n = spans.reduce((sum, p) => sum + p.frames, 0);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  let i = 0;
  for (const span of spans) {
    for (const end = i + span.frames; i < end; i++) {
      if (span.tone) buf.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * 440 * i) / sr)), 44 + i * 2);
    }
  }
  return buf;
}

// ───────────── fake extension ─────────────

/**
 * Stub mixer: passes its input through and posts stats every 0.25 s: 'bypass' when disabled,
 * 'idle' on digital silence, else 'realtime'. The stats carry what it was told (stats.test).
 * Test-only port messages: 'test-throw' (process() throws: processorerror), 'test-stats' (fields
 * that override the stats; a connect-rt starts a new real-time session, healthy again).
 */
const STUB_WORKLET = `
class StubMixer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.options = options.processorOptions || {};
    this.config = null; this.connects = []; this.playback = []; this.throwNext = false; this.patch = {};
    this.sq = 0; this.n = 0; this.frames = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'config') this.config = m.config;
      else if (m.type === 'connect-rt' || m.type === 'connect-la') {
        this.connects.push(m.type);
        if (m.type === 'connect-rt') delete this.patch.rtHealthy;
      }
      else if (m.type === 'playback') this.playback.push(m.playing);
      else if (m.type === 'test-throw') this.throwNext = true;
      else if (m.type === 'test-stats') this.patch = m.patch;
      else if (m.type === 'debug-record') this.port.postMessage({ type: 'debug-recording', input: [new Float32Array(4), new Float32Array(4)], output: [new Float32Array(4), new Float32Array(4)] });
    };
  }
  process(inputs, outputs) {
    if (this.throwNext) throw new Error('stub mixer failure');
    const input = inputs[0] || [];
    const out = outputs[0];
    for (let c = 0; c < out.length; c++) {
      const x = input[c] || input[0];
      if (x) out[c].set(x);
    }
    for (const ch of input) for (let i = 0; i < ch.length; i++) this.sq += ch[i] * ch[i];
    this.n += 128 * Math.max(1, input.length);
    this.frames += 128;
    if (this.frames >= 12000) {
      const inRms = Math.sqrt(this.sq / this.n);
      const enabled = !!(this.config && this.config.enabled);
      const mode = !enabled ? 'bypass' : inRms === 0 ? 'idle' : 'realtime';
      this.port.postMessage({ type: 'stats', stats: {
        mode, locked: false, latency: enabled ? 2880 : 0, underruns: 0, inRms, outRms: inRms, laAhead: 0,
        rtRoundTripMs: 1, rtHealthy: true, ...this.patch,
        test: { config: this.config, options: this.options, connects: this.connects, playback: this.playback },
      } });
      this.sq = 0; this.n = 0; this.frames = 0;
    }
    return true;
  }
}
registerProcessor('bgmr-mixer', StubMixer);
`;

/**
 * Fake engine page: HELLO/CONNECT handshake, 'ready' on init, a status every 0.3 s; logs what it
 * gets. control({ rtReady }) sets the real-time readiness it reports, control({ stopStatus })
 * stops its status messages.
 */
const FAKE_ENGINE = `<!doctype html><script>
const mode = new URLSearchParams(location.search).get('mode') || 'normal';
window.log = [];
let ctl = null;
let rtReady = mode !== 'rt-loading';
let statusOn = mode !== 'silent';
window.control = (c) => {
  if (c.rtReady !== undefined) rtReady = c.rtReady;
  if (c.stopStatus) statusOn = false;
};
window.addEventListener('message', (e) => {
  if (e.source !== parent || !e.data || e.data.type !== 'bgmr-engine-connect' || !e.ports[0] || ctl) return;
  ctl = e.ports[0];
  log.push({ type: 'connect', token: e.data.token });
  ctl.onmessage = (m) => {
    const d = m.data;
    log.push({ type: d.type, playhead: d.playhead, settings: d.settings && { enabled: d.settings.enabled, quality: d.settings.quality }, ports: m.ports.length });
    if (d.type === 'init' && mode !== 'no-ready') ctl.postMessage({ type: 'ready', gpu: 'test gpu' });
  };
  setInterval(() => ctl && statusOn && ctl.postMessage({ type: 'status', realtime: { ready: rtReady, rtf: Math.random() }, lookahead: { state: 'off' } }), 300);
});
parent.postMessage({ type: 'bgmr-engine-hello' }, '*');
</script>`;

/** Runs in the page before anything else: defines `chrome`/`browser` like a content script sees them. */
function installFakeExtension(cfg: { extOrigin: string; settings: Partial<Settings>; captureActive: boolean; engineMode: string }): void {
  type Listener = (...args: unknown[]) => unknown;
  const state = {
    alive: true,
    settings: cfg.settings,
    captureActive: cfg.captureActive,
    engineMode: cfg.engineMode,
    sent: [] as unknown[],
    tokens: [] as string[],
    /** performance.now() of each token registration (one per engine start). */
    tokenTimes: [] as number[],
  };
  const messageListeners = new Set<Listener>();
  const storageListeners = new Set<Listener>();
  // Like Chrome in an orphaned content script: API calls throw synchronously.
  const dead = (): never => {
    throw new Error('Extension context invalidated.');
  };
  const api = {
    runtime: {
      get id() {
        return state.alive ? 'fake-extension-id' : undefined;
      },
      getURL(path: string) {
        if (!state.alive) dead();
        return cfg.extOrigin + path + (path === '/engine.html' ? `?mode=${state.engineMode}` : '');
      },
      sendMessage(msg: { type: string; token?: string }) {
        if (!state.alive) dead();
        state.sent.push(JSON.parse(JSON.stringify(msg)));
        if (msg.type === 'engine-token') {
          state.tokens.push(msg.token!);
          state.tokenTimes.push(performance.now());
          return Promise.resolve({ ok: true });
        }
        if (msg.type === 'get-capture-state') return Promise.resolve({ active: state.captureActive });
        return Promise.resolve(undefined);
      },
      onMessage: { addListener: (f: Listener) => messageListeners.add(f), removeListener: (f: Listener) => messageListeners.delete(f) },
    },
    storage: {
      local: {
        get: async () => {
          if (!state.alive) dead();
          return { settings: state.settings };
        },
      },
      onChanged: { addListener: (f: Listener) => storageListeners.add(f), removeListener: (f: Listener) => storageListeners.delete(f) },
    },
  };
  Object.defineProperty(window, 'chrome', { value: api, configurable: true, writable: true });
  Object.defineProperty(window, 'browser', { value: api, configurable: true, writable: true });
  Object.defineProperty(window, '__ext', {
    value: {
      state,
      listenerCount: () => messageListeners.size + storageListeners.size,
      dispatch(msg: unknown) {
        let response: unknown;
        for (const f of messageListeners) f(msg, {}, (r: unknown) => (response = r));
        return response;
      },
      setSettings(patch: Partial<Settings>) {
        state.settings = { ...state.settings, ...patch };
        for (const f of storageListeners) f({ settings: { newValue: state.settings } }, 'local');
      },
      kill() {
        state.alive = false;
      },
    },
  });
}
