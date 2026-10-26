// Page-side controller shared by the YouTube and generic content scripts (ISOLATED world).
//
// It routes media elements that play audibly through an AudioWorklet (the mixer), starts the
// engine iframe that hosts the models, forwards MediaSource data and the playhead to it (YouTube
// look-ahead), and reports the tab status to the background.
//
// Routing (createMediaElementSource) cannot be undone, so only media whose audio was verified to
// be readable is routed, and the controller decides where routed audio goes:
//   'worklet': sources → mixer → speakers (enabled; the mixer can still be in bypass)
//   'direct':  sources → speakers (disabled, tab capture, failure, extension gone): zero latency
//              and no JavaScript on the audio thread.
// A routed element that the page removed (and that is paused) leaves the graph and the
// controller's references; should it play again, it gets its path back at once.
// The engine (models, GPU memory) only exists while there is audible playback to process: it is
// released after a minute disabled or five minutes without audible playback, and recreated on the
// next audible play. A real-time worker that stops answering is replaced on its own.
import { DEFAULT_JITTER, RT_HOP, SAMPLE_RATE } from '@/lib/constants';
import type {
  EngineOut,
  FromMixer,
  HookMessage,
  LookaheadStatus,
  MixerConfig,
  MixerStats,
  PlayheadInfo,
  RuntimeMessage,
  TabMode,
  TabState,
  TabStatus,
  ToMixer,
} from '@/lib/protocol';
import { DEFAULT_SETTINGS, normalizeSettings, reductionGain, type Settings } from '@/lib/settings';
import { installDebugBridge, mirrorDebugStatus, type DebugRecording, type DebugTarget } from './debug-bridge';
import { EngineClient } from './engine-client';
import { HookBridge } from './hook-bridge';
import {
  area,
  canTap,
  decodedAudioBytes,
  findShadowRoots,
  hasAudioTrack,
  isAudible,
  isMainPlayer,
  isPlayingNormally,
  playerFrameHost,
  urlVerdict,
  wantsProcessing,
  type TapProbeTimeouts,
  type TapVerdict,
} from './media';
import { extensionAlive, isContextInvalidated, sendRuntime } from './runtime';
import { mixerStatus, statusKey } from './status';

export type Site = 'youtube' | 'generic';

/** The part of WXT's ContentScriptContext the controller uses. */
export interface ScriptContext {
  onInvalidated(cb: () => void): () => void;
  setInterval(handler: () => void, timeout?: number): number;
}

/** Durations in ms (tests shorten them). */
export interface ControllerTiming {
  tick: number;
  /**
   * Mixer crossfade into bypass before it leaves the audio path (at least: see bypassDelay()) /
   * fresh input before it processes again.
   */
  settle: number;
  /** The engine is released after the tab has been disabled this long, */
  disabledEngine: number;
  /** or after this long without audible playback of a routed element. */
  idleEngine: number;
  /**
   * An engine that is not 'ready' this long after its start is replaced (as is one whose iframe is
   * gone, or that sends nothing for engineSilent while real-time hops flow). A real-time worker
   * that has not reported ready this long after its start is restarted.
   */
  engineReady: number;
  /** No engine message for this long while real-time hops flow (once its real-time worker ran). */
  engineSilent: number;
  /** The mixer reports the (once ready) real-time worker unhealthy for this long: it is restarted. */
  rtUnhealthy: number;
  /** Minimum time between two engine starts, or two real-time worker restarts, after a failure. */
  engineRestart: number;
  /** The look-ahead worker drops its decoded audio after being disabled this long (LookaheadCore's suspendAfterMs). */
  lookaheadSuspend: number;
  /** A routed element whose source has delivered only digital silence for this long is reported. */
  silentInput: number;
  /** Shadow-DOM search interval while nothing plays audibly. */
  discovery: number;
  latencyRefresh: number;
  /** Unchanged status re-sent this often (not while off). */
  heartbeat: number;
  probe: TapProbeTimeouts;
}

export const DEFAULT_TIMING: ControllerTiming = {
  tick: 250,
  settle: 150,
  disabledEngine: 60_000,
  idleEngine: 5 * 60_000,
  engineReady: 20_000,
  engineSilent: 10_000,
  rtUnhealthy: 3_000,
  engineRestart: 60_000,
  lookaheadSuspend: 60_000,
  silentInput: 8_000,
  discovery: 3_000,
  latencyRefresh: 2_000,
  heartbeat: 30_000,
  probe: { fetchMs: 5_000, frameMs: 3_000, taintSettleMs: 500 },
};

interface Problem {
  mode: TabMode;
  detail: string;
  needsTabCapture?: boolean;
  /** Only a page reload restores the sound (the popup offers it). */
  needsReload?: boolean;
  /** Raised by the silence watchdog: cleared when the input has sound again. */
  silence?: boolean;
}

const unsupported = (detail: string): Problem => ({ mode: 'unsupported', detail, needsTabCapture: true });
/**
 * Routed media that plays silently: tab capture would record the same silence (the element's
 * audio only leaves through the page's AudioContext). After a reload it is not routed, and tab
 * capture can process it.
 */
const silenced = (detail: string, silence = false): Problem => ({ mode: 'unsupported', detail, needsReload: true, silence });

type Unreadable = Exclude<Extract<TapVerdict, { ok: false }>['reason'], 'no-source'>;

/** Why an element is left alone (not routed yet). */
const NOT_ROUTED: Record<Unreadable, Problem> = {
  drm: unsupported('This video is DRM-protected, so its audio cannot be processed directly.'),
  'cross-origin': unsupported('This media comes from another site without permission to read its audio.'),
  unverified: unsupported('This media could not be checked, so it is left unprocessed.'),
};
const RELOAD = 'Reload the page to hear it; tab capture can then process it.';
/**
 * A routed element loaded media whose audio Web Audio cannot read: it plays silently. (A source
 * that could not be checked raises nothing; the silence watchdog covers it.)
 */
const NOW_UNREADABLE: Partial<Record<Unreadable, Problem>> = {
  drm: silenced(`This media is now DRM-protected, which silences it here. ${RELOAD}`),
  'cross-origin': silenced(`This media now comes from another site, which silences it here. ${RELOAD}`),
};
const SILENT_INPUT = silenced(`The sound of this media cannot be read any more. ${RELOAD}`, true);
const ALREADY_PROCESSED = unsupported('Another extension or the page already processes this media. Disable it or reload the page.');
const PROCESSING_FAILED: Problem = { mode: 'passthrough', detail: 'Processing failed; the original audio was restored.', needsTabCapture: true };

/** Capture-phase listeners on the document (and on open shadow roots) for elements not routed yet. */
const DISCOVERY_EVENTS = ['play', 'playing', 'volumechange', 'pause', 'ended', 'emptied'] as const;
/**
 * User gestures, which cross shadow boundaries (media events do not): a click on play or unmute
 * in a shadow root that discovery has not seen yet reveals it before the player reacts.
 */
const GESTURE_EVENTS = ['pointerdown', 'click', 'keydown'] as const;
/** Listeners on each routed element, for its lifetime (they also track its playback state). */
const ROUTED_EVENTS = [
  'loadstart',
  'loadedmetadata',
  'play',
  'playing',
  'volumechange',
  'pause',
  'ended',
  'emptied',
  'seeking',
  'seeked',
  'ratechange',
  'waiting',
  'canplay',
] as const;

/** Margin for DeepFilterNet's processing time in the initial real-time jitter allowance (10 ms). */
const JITTER_MARGIN = 480;
/** Output latency changes up to this many frames (2 ms) are not re-sent to the mixer. */
const LATENCY_TOLERANCE = 96;
/** Mixer stats older than this are not used by the watchdogs (the mixer reports every 0.5 s). */
const STATS_FRESH_MS = 1500;
/** Beyond the output latency held as silence: the mixer's crossfade to bypass and message delivery (ms). */
const BYPASS_MARGIN_MS = 60;

type Path = 'worklet' | 'direct';

const safely = (f: () => void) => {
  try {
    f();
  } catch {}
};

export class MediaController implements DebugTarget {
  private readonly t: ControllerTiming;
  private settings: Settings = DEFAULT_SETTINGS;
  private settingsLoaded = false;
  /** The tab's switch (popup); null while the user has not set it for this tab. */
  private tabSwitch: boolean | null = null;
  /** Tab capture processes this tab: in-page processing stands down. */
  private captureActive = false;
  private dead = false;
  /** `active` as of the last reconfigure(). */
  private wasActive = false;
  /** Removes every DOM listener at shutdown. */
  private readonly listeners = new AbortController();
  private readonly cleanups: (() => void)[] = [];
  private readonly intervals: number[] = [];

  // ── audio graph ──
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private graphPromise: Promise<boolean> | null = null;
  private graphError: string | null = null;
  private path: Path = 'worklet';
  /** Pending path change: 'direct' after the mixer crossfaded to bypass, 'worklet' before it processes again. */
  private settle: { to: Path; timer: ReturnType<typeof setTimeout> } | null = null;
  /** The worklet failed: the audio plays directly for good. */
  private failure: Problem | null = null;
  private gesturePending = false;
  /** Last 'playback' state sent to the mixer (null: none yet). */
  private playbackSent: boolean | null = null;

  // ── media elements ──
  /** Source node of every element ever routed (createMediaElementSource works once per element). */
  private readonly nodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  /** Routed elements whose node is in the graph; the others were released (see release()). */
  private readonly sources = new Set<HTMLMediaElement>();
  /** createMediaElementSource threw: someone else routed the element. */
  private readonly rejected = new WeakSet<HTMLMediaElement>();
  private readonly activating = new WeakSet<HTMLMediaElement>();
  private readonly verdicts = new WeakMap<HTMLMediaElement, { key: string; verdict: Promise<TapVerdict> }>();
  /** Per-element problems; shown only while that element plays audibly and nothing routed does. */
  private readonly problems = new Map<HTMLMediaElement, Problem>();
  private readonly watchedRoots = new WeakSet<ShadowRoot>();
  private current: HTMLMediaElement | null = null;
  /** Top frame without media: host of a cross-origin frame that probably holds the player. */
  private frameHost: string | null = null;
  private lastDiscoveryAt = -Infinity;

  // ── engine ──
  private engine: EngineClient | null = null;
  private engineStarting = false;
  /** Incremented when an engine is disposed: a start still in flight then discards its result. */
  private engineEpoch = 0;
  private engineAttemptAt = -Infinity;
  /** Last replacement of a broken engine: the first one happens at once, later ones at most once per engineRestart. */
  private engineReplacedAt = -Infinity;
  private engineReady = false;
  /** The engine's real-time worker reported ready at least once: from then on its health counts. */
  private rtReadySeen = false;
  /** Start of the current real-time worker (with the engine, or its last restart). */
  private rtStartedAt = 0;
  /** Last real-time worker restart: the first one happens at once, later ones at most once per engineRestart. */
  private rtRestartedAt = -Infinity;
  /** Since when the engine's look-ahead worker has been disabled (null: enabled, or no engine). */
  private lookaheadOffSince: number | null = null;
  private engineError: string | null = null;
  private lastEngineMessageAt = 0;
  private lastAudibleAt = 0;
  private inactiveSince: number | null = null;
  private rtUnhealthySince: number | null = null;
  private hook: HookBridge | null = null;
  private readonly msByUrl = new Map<string, number>();
  private activeMs: number | null | undefined = undefined;
  /** The page uses MSE in a worker: no look-ahead possible. */
  private workerMse = false;
  private gpu: string | null = null;
  private lookahead: LookaheadStatus | undefined;
  private realtimeError: string | null = null;
  private mixerStats: MixerStats | null = null;
  private mixerStatsAt = 0;

  // ── watchdogs, latency, status ──
  private silentSince: number | null = null;
  /** Audio bytes the current element had decoded when its silence started (Chrome). */
  private silentBytes: number | null = null;
  /** Per element: the source in which its audio was last heard. */
  private readonly heardSource = new WeakMap<HTMLMediaElement, string>();
  private lastMediaTime = NaN;
  /** Frames of output latency last sent to the mixer. */
  private outputLatency = 0;
  private lastLatencyCheckAt = -Infinity;
  private lastStatusKey = '';
  private lastStatusAt = -Infinity;
  private debugWaiters: ((m: DebugRecording) => void)[] = [];

  constructor(
    private readonly site: Site,
    timing: Partial<ControllerTiming> = {},
  ) {
    this.t = { ...DEFAULT_TIMING, ...timing };
  }

  get isShutDown(): boolean {
    return this.dead;
  }

  /**
   * Runs the controller's timer in a WXT content-script context. WXT also invalidates a context
   * when the same script is injected into the frame again; that injection then attaches its own
   * context to this controller (see start.ts). Only a dead extension shuts it down.
   */
  attach(ctx: ScriptContext): void {
    if (this.dead) return;
    this.intervals.push(ctx.setInterval(() => this.tick(), this.t.tick));
    ctx.onInvalidated(() => {
      if (!extensionAlive()) this.shutdown();
    });
  }

  async init(): Promise<void> {
    const signal = this.listeners.signal;
    this.listenToExtension();
    for (const t of DISCOVERY_EVENTS) document.addEventListener(t, this.onDiscoveryEvent, { capture: true, signal });
    for (const t of GESTURE_EVENTS) document.addEventListener(t, this.onGesture, { capture: true, passive: true, signal });
    // Removed iframes and navigations must not leave a stale status behind in the background.
    window.addEventListener('pagehide', this.onPageHide, { signal });
    window.addEventListener('pageshow', (e) => e.persisted && this.publish(true), { signal });
    navigator.mediaDevices?.addEventListener('devicechange', () => this.refreshOutputLatency(), { signal });
    if (import.meta.env.MODE !== 'production') installDebugBridge(this);
    const [settings, tab] = await Promise.all([
      Promise.resolve()
        .then(() => browser.storage.local.get('settings'))
        .then((stored) => normalizeSettings(stored.settings))
        .catch((e: unknown) => {
          if (isContextInvalidated(e)) this.shutdown();
          return DEFAULT_SETTINGS;
        }),
      this.runtime<Partial<TabState> | undefined>({ type: 'get-tab-state' }).catch(() => undefined),
    ]);
    if (this.dead) return;
    this.settings = settings;
    this.captureActive = tab?.capture === true;
    // A command from the popup that arrived meanwhile is newer.
    if (typeof tab?.enabled === 'boolean') this.tabSwitch ??= tab.enabled;
    this.settingsLoaded = true;
    this.reconfigure(true);
  }

  /**
   * Effective on/off state for this tab (what the user chose). A tab starts off: the YouTube
   * script runs on every YouTube page but waits for the tab's switch, while the generic script
   * only runs where the user turned it on or chose to always run.
   */
  get enabled(): boolean {
    if (!this.settings.enabled) return false;
    return this.tabSwitch ?? this.site === 'generic';
  }

  setTabEnabled(on: boolean): void {
    if (this.dead) return;
    this.tabSwitch = on;
    this.reconfigure(true);
  }

  /** Whether in-page processing runs now. */
  private get active(): boolean {
    return this.enabled && this.settingsLoaded && !this.captureActive && this.failure === null && !this.dead;
  }

  /** The mixer processes (otherwise it outputs its input unchanged, with no added latency). */
  private get mixerEnabled(): boolean {
    return this.active && this.path === 'worklet' && this.settle === null;
  }

  private get lookaheadAllowed(): boolean {
    return this.site === 'youtube' && this.settings.quality === 'auto';
  }

  private effectiveSettings(): Settings {
    return { ...this.settings, enabled: this.active };
  }

  /** Settings, the tab switch or the capture state changed. */
  private reconfigure(force: boolean): void {
    this.applyConfig();
    const active = this.active;
    // Media that already plays when processing (re)starts sends no 'play' event.
    if (active && !this.wasActive) this.discover(Date.now());
    this.wasActive = active;
    if (active) {
      this.selectCurrent();
      if (this.hasAudiblePlayback()) this.ensureEngine();
    }
    this.publish(force);
  }

  private listenToExtension(): void {
    const onStorage = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName !== 'local' || !changes.settings || this.dead) return;
      this.settings = normalizeSettings(changes.settings.newValue);
      this.reconfigure(true);
    };
    const onMessage = (msg: RuntimeMessage, _sender: unknown, sendResponse: (r: unknown) => void) => {
      if (this.dead) return false;
      if (msg?.type === 'tab-command') {
        this.setTabEnabled(msg.command === 'enable');
        sendResponse(this.status());
      } else if (msg?.type === 'capture-state') {
        this.setCaptureActive(msg.active);
      }
      return false;
    };
    try {
      browser.storage.onChanged.addListener(onStorage);
      this.cleanups.push(() => browser.storage.onChanged.removeListener(onStorage));
      browser.runtime.onMessage.addListener(onMessage);
      this.cleanups.push(() => browser.runtime.onMessage.removeListener(onMessage));
    } catch (e) {
      if (isContextInvalidated(e)) this.shutdown();
    }
  }

  private setCaptureActive(active: boolean): void {
    if (active === this.captureActive) return;
    this.captureActive = active;
    this.reconfigure(true);
  }

  /** Runtime message; failing because the extension is gone shuts the controller down. */
  private runtime<R>(msg: RuntimeMessage): Promise<R> {
    if (!extensionAlive()) {
      this.shutdown();
      return Promise.reject(new Error('Extension context invalidated.'));
    }
    return sendRuntime<R>(msg).catch((e: unknown) => {
      if (isContextInvalidated(e)) this.shutdown();
      throw e;
    });
  }

  private readonly onPageHide = () => {
    if (this.dead) return;
    this.runtime({ type: 'tab-status', status: { ...this.status(), mode: 'off' } }).catch(() => {});
  };

  // ───────────── media discovery ─────────────

  private readonly onDiscoveryEvent = (e: Event) => {
    const el = e.target;
    // Routed elements have their own listeners.
    if (!(el instanceof HTMLMediaElement) || this.nodes.has(el)) return;
    if ((e.type === 'play' || e.type === 'playing' || e.type === 'volumechange') && wantsProcessing(el)) {
      void this.activate(el);
    } else {
      this.clearProblem(el);
    }
  };

  private readonly onRoutedEvent = (e: Event) => {
    const el = e.currentTarget as HTMLMediaElement;
    switch (e.type) {
      case 'loadstart':
        // A new source in a routed element: routing stays, so its audio must be readable too.
        this.clearProblem(el);
        if (this.active) void this.verdict(el);
        break;
      case 'loadedmetadata':
      case 'play':
      case 'playing':
      case 'volumechange':
        if (wantsProcessing(el)) void this.activate(el);
        else if (e.type === 'volumechange') this.clearProblem(el);
        else if (e.type === 'loadedmetadata' && this.active) void this.verdict(el);
        break;
      case 'pause':
      case 'ended':
      case 'emptied':
        this.clearProblem(el);
        // Removed from the page, which pauses it.
        if (!el.isConnected && el.paused) this.release(el);
        break;
    }
    if (el === this.current) {
      this.sendPlayhead();
      this.postPlayback();
    }
  };

  /**
   * Gives a released element its path back as it starts playing, before its audio is due:
   * routing cannot be undone, so it would play silently otherwise. Stays registered after
   * shutdown, which leaves released elements' nodes unconnected.
   */
  private readonly onRoutedPlay = (e: Event) => {
    const el = e.currentTarget as HTMLMediaElement;
    const src = this.nodes.get(el);
    const { ctx, node } = this;
    if (!src || !ctx || this.sources.has(el)) return;
    safely(() => src.connect(this.path === 'worklet' && node ? node : ctx.destination));
    this.sources.add(el);
  };

  /**
   * Finds media that already plays (it sends no 'play' event) and media in open shadow roots,
   * whose events do not reach the document; their roots get the document's listeners. Walks the
   * whole DOM: at init and on enabling, then at most every few seconds while nothing plays audibly.
   */
  private discover(now: number): void {
    this.lastDiscoveryAt = now;
    let found = this.visit(document);
    for (const root of findShadowRoots(document)) {
      this.watchRoot(root);
      found = this.visit(root) || found;
    }
    this.frameHost = !found && this.site === 'generic' && window === window.top ? playerFrameHost() : null;
  }

  /** Activates the media in `root` that plays audibly; true if `root` has media at all. */
  private visit(root: Document | ShadowRoot): boolean {
    let found = false;
    for (const el of root.querySelectorAll<HTMLMediaElement>('video, audio')) {
      found = true;
      if (!this.nodes.has(el) && wantsProcessing(el)) void this.activate(el);
    }
    return found;
  }

  private watchRoot(root: ShadowRoot): void {
    if (this.watchedRoots.has(root)) return;
    this.watchedRoots.add(root);
    for (const t of DISCOVERY_EVENTS) root.addEventListener(t, this.onDiscoveryEvent, { capture: true, signal: this.listeners.signal });
  }

  /** Watches the open shadow roots a user gesture passes through (see GESTURE_EVENTS). */
  private readonly onGesture = (e: Event) => {
    for (const target of e.composedPath()) {
      if (target instanceof ShadowRoot && !this.watchedRoots.has(target)) {
        this.watchRoot(target);
        this.visit(target);
      }
    }
  };

  /** Whether the element's current source is readable through Web Audio (cached per source). */
  private verdict(el: HTMLMediaElement): Promise<TapVerdict> {
    const key = sourceKey(el);
    const cached = this.verdicts.get(el);
    if (cached?.key === key) return cached.verdict;
    const verdict: Promise<TapVerdict> = canTap(el, this.t.probe).then((v) => {
      // A check that could not complete is repeated at the next play.
      if (!v.ok && v.reason === 'unverified' && this.verdicts.get(el)?.verdict === verdict) this.verdicts.delete(el);
      return v;
    });
    this.verdicts.set(el, { key, verdict });
    return verdict;
  }

  /**
   * Called for elements that play audibly: routes the element once its audio is known to be
   * readable (never on doubt), and offers it as the current element.
   */
  private async activate(el: HTMLMediaElement): Promise<void> {
    if (!this.active || !wantsProcessing(el)) return;
    if (this.rejected.has(el)) {
      this.setProblem(el, ALREADY_PROCESSED);
      return;
    }
    const key = sourceKey(el);
    const verdict = await this.verdict(el);
    // Stopped, muted or switched to another source meanwhile: its own events come back here.
    if (!this.active || !wantsProcessing(el) || sourceKey(el) !== key) return;
    const routed = this.nodes.has(el);
    if (!verdict.ok) {
      const problem = verdict.reason === 'no-source' ? undefined : routed ? NOW_UNREADABLE[verdict.reason] : NOT_ROUTED[verdict.reason];
      if (problem) this.setProblem(el, problem);
      if (routed) this.offerCurrent(el);
      return;
    }
    if (!this.problems.get(el)?.silence) this.clearProblem(el);
    if (routed) {
      this.offerCurrent(el);
      this.ensureEngine();
      return;
    }
    if (this.activating.has(el)) return;
    this.activating.add(el);
    try {
      if (!(await this.ensureGraph())) return;
      if (this.active && wantsProcessing(el) && !this.nodes.has(el)) this.route(el);
    } finally {
      this.activating.delete(el);
    }
  }

  private route(el: HTMLMediaElement): void {
    const { ctx, node } = this;
    if (!ctx || !node) return;
    let src: MediaElementAudioSourceNode;
    try {
      src = ctx.createMediaElementSource(el);
    } catch {
      this.rejected.add(el);
      this.setProblem(el, ALREADY_PROCESSED);
      return;
    }
    src.connect(this.path === 'worklet' ? node : ctx.destination);
    this.nodes.set(el, src);
    this.sources.add(el);
    el.addEventListener('play', this.onRoutedPlay);
    el.addEventListener('playing', this.onRoutedPlay);
    for (const t of ROUTED_EVENTS) el.addEventListener(t, this.onRoutedEvent, { signal: this.listeners.signal });
    this.offerCurrent(el);
    this.ensureEngine();
    this.publish(false);
  }

  /**
   * Takes a routed element that the page removed out of the graph and of the controller's
   * references, so that it can be garbage-collected where Web Audio lets it go. (Chrome's
   * AudioContext keeps every element it made a source node for until it is closed, and closing
   * it would silence those elements for good: there, only what the page tore down is freed.)
   * Its listeners stay: if it plays again, it gets its path back (onRoutedPlay) and is offered
   * as the current element.
   */
  private release(el: HTMLMediaElement): void {
    if (!this.sources.delete(el)) return;
    safely(() => this.nodes.get(el)?.disconnect());
    this.clearProblem(el);
    if (el === this.current) this.setCurrent(null);
  }

  /** Makes `el` current unless the current element still plays audibly (YouTube's main player beats previews). */
  private offerCurrent(el: HTMLMediaElement): void {
    const cur = this.current;
    if (cur === el) return;
    const mainWins = this.site === 'youtube' && isMainPlayer(el) && !isMainPlayer(cur ?? el);
    if (cur && wantsProcessing(cur) && !mainWins) return;
    this.setCurrent(el);
  }

  /** When the current element stopped or was muted, a routed element that plays audibly takes over. */
  private selectCurrent(): void {
    if (this.current && wantsProcessing(this.current)) return;
    let best: HTMLMediaElement | null = null;
    for (const el of this.sources) {
      if (wantsProcessing(el) && (!best || this.prominence(el) > this.prominence(best))) best = el;
    }
    if (best) this.setCurrent(best);
  }

  private setCurrent(el: HTMLMediaElement | null): void {
    this.current = el;
    this.silentSince = null;
    this.lastMediaTime = NaN;
    this.sendPlayhead();
    this.postPlayback();
    this.publish(false);
  }

  private prominence(el: HTMLMediaElement): number {
    return (this.site === 'youtube' && isMainPlayer(el) ? 1e9 : 0) + area(el);
  }

  /** A routed element plays audibly and its audio is readable. */
  private hasAudiblePlayback(): boolean {
    for (const el of this.sources) if (wantsProcessing(el) && !this.problems.has(el)) return true;
    return false;
  }

  // ───────────── problems ─────────────

  private setProblem(el: HTMLMediaElement, problem: Problem): void {
    if (!wantsProcessing(el) || this.problems.get(el) === problem) return;
    this.problems.set(el, problem);
    this.publish(false);
  }

  private clearProblem(el: HTMLMediaElement): void {
    if (this.problems.delete(el)) this.publish(false);
  }

  /** The problem to report: none while a routed element plays fine, else the most prominent playing one's. */
  private visibleProblem(): Problem | null {
    if (this.problems.size === 0 || this.hasAudiblePlayback()) return null;
    let best: HTMLMediaElement | null = null;
    for (const el of this.problems.keys()) {
      if (wantsProcessing(el) && (!best || this.prominence(el) > this.prominence(best))) best = el;
    }
    return best ? (this.problems.get(best) ?? null) : null;
  }

  // ───────────── audio graph ─────────────

  private ensureGraph(): Promise<boolean> {
    this.graphPromise ??= this.buildGraph()
      .catch((e: unknown) => {
        if (isContextInvalidated(e)) this.shutdown();
        else this.graphError = 'The audio processor could not be loaded.';
        return false;
      })
      .finally(() => {
        this.graphPromise = null;
        this.publish(false);
      });
    return this.graphPromise;
  }

  private async buildGraph(): Promise<boolean> {
    this.ctx ??= new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      // Routing into a suspended context would silence the media: wait for a user gesture.
      this.gesturePending = true;
      this.publish(false);
      const running = await waitForRunning(ctx, this.listeners.signal);
      this.gesturePending = false;
      if (!running) return false;
    }
    if (!this.node) {
      await ctx.audioWorklet.addModule(browser.runtime.getURL('/worklet.js'));
      if (this.dead) return false;
      const node = new AudioWorkletNode(ctx, 'bgmr-mixer', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { jitter: initialJitter(ctx) },
      });
      node.port.onmessage = (e: MessageEvent<FromMixer>) => this.onMixer(e.data);
      node.onprocessorerror = () => this.onProcessorError();
      // Nothing is routed yet, so the mixer has no stale history: it can process right away.
      node.connect(ctx.destination);
      this.node = node;
      this.path = 'worklet';
      this.graphError = null;
      this.outputLatency = outputLatencyFrames(ctx);
      this.lastLatencyCheckAt = Date.now();
      this.applyConfig();
      this.postPlayback(true);
    }
    return true;
  }

  private applyConfig(): void {
    this.syncPath();
    this.postConfig();
    this.engine?.post({ type: 'settings', settings: this.effectiveSettings() });
    this.syncLookaheadReplay();
  }

  private postConfig(): void {
    const config: MixerConfig = {
      enabled: this.mixerEnabled,
      residualGain: reductionGain(this.settings.reductionDb),
      gapReduction: this.settings.gapReduction,
      lookahead: this.lookaheadAllowed,
      outputLatency: this.outputLatency,
    };
    this.postMixer({ type: 'config', config });
  }

  /**
   * Moves the routed audio towards the path the state calls for. Leaving the mixer waits until it
   * has crossfaded to bypass (the output then equals the input, so the switch is seamless).
   * Returning reconnects at once, with the mixer still in bypass, and enables processing once its
   * history holds fresh input; the mixer crossfades from bypass.
   */
  private syncPath(): void {
    if (!this.ctx || !this.node) return;
    const want: Path = this.active ? 'worklet' : 'direct';
    if (this.settle) {
      if (this.settle.to === want) return;
      clearTimeout(this.settle.timer);
      this.settle = null;
    }
    if (want === this.path) return;
    if (want === 'worklet') this.setPath('worklet');
    const delay = want === 'direct' ? this.bypassDelay() : this.t.settle;
    this.settle = { to: want, timer: setTimeout(() => this.onSettled(), delay) };
  }

  /**
   * Time the disabled mixer needs to reach bypass (ms): look-ahead output led the input by the
   * output latency, so the mixer holds that much silence before it crossfades to its input.
   */
  private bypassDelay(): number {
    return Math.max(this.t.settle, Math.ceil((this.outputLatency * 1000) / SAMPLE_RATE) + BYPASS_MARGIN_MS);
  }

  private onSettled(): void {
    const to = this.settle?.to;
    this.settle = null;
    if (this.dead) return;
    if (to === 'direct') this.setPath('direct');
    this.postConfig();
    this.publish(false);
  }

  private clearSettle(): void {
    if (this.settle) clearTimeout(this.settle.timer);
    this.settle = null;
  }

  /** Connects every routed source to the mixer, or straight to the speakers (the mixer then idles unconnected). */
  private setPath(path: Path): void {
    const { ctx, node } = this;
    if (!ctx || !node || path === this.path) {
      this.path = path;
      return;
    }
    const [to, from]: [AudioNode, AudioNode] = path === 'worklet' ? [node, ctx.destination] : [ctx.destination, node];
    if (path === 'worklet') safely(() => node.connect(ctx.destination));
    for (const el of this.sources) {
      const src = this.nodes.get(el);
      if (!src) continue;
      safely(() => src.connect(to));
      safely(() => src.disconnect(from));
    }
    if (path === 'direct') safely(() => node.disconnect());
    this.path = path;
  }

  /** The mixer threw: its output is silent for good, so give every element its direct path back. */
  private onProcessorError(): void {
    if (this.failure || this.dead) return;
    this.failure = PROCESSING_FAILED;
    this.clearSettle();
    this.setPath('direct');
    this.disposeEngine();
    this.publish(false);
  }

  private postMixer(msg: ToMixer, transfer: Transferable[] = []): void {
    safely(() => this.node?.port.postMessage(msg, transfer));
  }

  /**
   * Tells the mixer whether the current element plays normally (isPlayingNormally): look-ahead
   * output stops at once when it does not. Sent on changes, or `force`d after (re)connections.
   */
  private postPlayback(force = false): void {
    const playing = this.current !== null && isPlayingNormally(this.current);
    if (!this.node || (!force && playing === this.playbackSent)) return;
    this.playbackSent = playing;
    this.postMixer({ type: 'playback', playing });
  }

  private onMixer(m: FromMixer): void {
    if (m.type === 'stats') {
      const s = m.stats;
      this.mixerStats = s;
      this.mixerStatsAt = Date.now();
      // Real-time health counts once the worker has run (it loads its model first), and not while
      // look-ahead output is heard. While idle no hops are sent: no evidence either way.
      if (!this.rtReadySeen || !this.mixerEnabled || s.locked || s.mode === 'lookahead') this.rtUnhealthySince = null;
      else if (s.mode !== 'idle') this.rtUnhealthySince = s.rtHealthy ? null : (this.rtUnhealthySince ?? this.mixerStatsAt);
      this.publish(false);
    } else if (m.type === 'debug-recording') {
      const waiters = this.debugWaiters;
      this.debugWaiters = [];
      for (const w of waiters) w(m);
    }
  }

  /** Re-sends the output latency when it changed by more than 2 ms (Chrome reports it once playback runs). */
  private refreshOutputLatency(): void {
    this.lastLatencyCheckAt = Date.now();
    if (!this.ctx || !this.node || this.dead) return;
    const frames = outputLatencyFrames(this.ctx);
    if (Math.abs(frames - this.outputLatency) <= LATENCY_TOLERANCE) return;
    this.outputLatency = frames;
    this.postConfig();
  }

  // ───────────── engine ─────────────

  private ensureEngine(): void {
    if (!this.active || !this.node || this.engine || this.engineStarting) return;
    const now = Date.now();
    // After a failure, retry at most once per engineRestart.
    if (this.engineError !== null && now - this.engineAttemptAt < this.t.engineRestart) return;
    void this.startEngine(now);
  }

  private async startEngine(now: number): Promise<void> {
    const epoch = ++this.engineEpoch;
    this.engineStarting = true;
    this.engineAttemptAt = now;
    this.engineReady = false;
    this.rtReadySeen = false;
    this.lastAudibleAt = now;
    try {
      const engine = await EngineClient.create((token) => this.runtime({ type: 'engine-token', token }), this.t.engineReady);
      if (epoch !== this.engineEpoch || this.dead) {
        engine.dispose();
        return;
      }
      const started = Date.now();
      this.engine = engine;
      this.engineError = null;
      this.lastEngineMessageAt = started;
      this.rtStartedAt = started;
      this.rtRestartedAt = -Infinity;
      engine.onMessage((m) => this.onEngine(m));
      engine.post({ type: 'init', settings: this.effectiveSettings(), lookahead: this.site === 'youtube' });
      // Starts the clock if look-ahead starts disabled.
      this.lookaheadOffSince = null;
      this.syncLookaheadReplay();
      // Fresh channels: the mixer drops its old worker ports when it gets new ones.
      const rt = new MessageChannel();
      const la = new MessageChannel();
      this.postMixer({ type: 'connect-rt' }, [rt.port1]);
      this.postMixer({ type: 'connect-la' }, [la.port1]);
      engine.post({ type: 'connect-worklet' }, [rt.port2, la.port2]);
      this.postPlayback(true);
      if (this.site === 'youtube') this.connectHook();
      this.activeMs = undefined;
      this.sendPlayhead();
    } catch (e) {
      if (epoch !== this.engineEpoch) return;
      if (isContextInvalidated(e)) this.shutdown();
      else this.engineError = e instanceof Error ? e.message : String(e);
    } finally {
      if (epoch === this.engineEpoch) this.engineStarting = false;
      this.publish(false);
    }
  }

  /** A new connection makes the hook replay the init segments and recent appends it kept. */
  private connectHook(): void {
    this.hook?.close();
    this.hook = HookBridge.connect((m) => this.onHook(m));
  }

  /**
   * The look-ahead worker drops its decoded audio once it has been disabled for lookaheadSuspend
   * (quality 'realtime', tab off): enabled again after that, it needs the hook's replay of what
   * the page buffered. (A worker that kept its audio must not get it: it would take identical
   * re-appends for changed audio.) Call after posting the settings.
   */
  private syncLookaheadReplay(): void {
    if (!this.engine || this.site !== 'youtube') return;
    const now = Date.now();
    if (!(this.active && this.lookaheadAllowed)) {
      this.lookaheadOffSince ??= now;
      return;
    }
    const since = this.lookaheadOffSince;
    this.lookaheadOffSince = null;
    if (since !== null && now - since >= this.t.lookaheadSuspend) this.connectHook();
  }

  private disposeEngine(): void {
    this.engineEpoch++;
    this.engineStarting = false;
    this.hook?.close();
    this.hook = null;
    this.engine?.dispose();
    this.engine = null;
    this.engineReady = false;
    this.rtReadySeen = false;
    this.lookaheadOffSince = null;
    this.lookahead = undefined;
    this.realtimeError = null;
    this.rtUnhealthySince = null;
    this.activeMs = undefined;
  }

  /**
   * Releases an unused engine and replaces one that stopped working (then at most once per
   * engineRestart). A real-time worker that stopped answering, or never got ready, is restarted on
   * its own, as long as real-time output is what is heard: the look-ahead worker keeps its work.
   */
  private checkEngine(now: number): void {
    if (!this.engine && !this.engineStarting) return;
    if (this.inactiveSince !== null) {
      if (now - this.inactiveSince >= this.t.disabledEngine) this.disposeEngine();
      return;
    }
    if (now - this.lastAudibleAt >= this.t.idleEngine) {
      this.disposeEngine();
      return;
    }
    const s = this.mixerStats;
    const hopsFlow =
      this.mixerEnabled && this.hasAudiblePlayback() && s !== null && now - this.mixerStatsAt < STATS_FRESH_MS && s.mode !== 'idle' && s.mode !== 'bypass';
    const broken =
      (!this.engineReady && now - this.engineAttemptAt > this.t.engineReady) ||
      (this.engine !== null && !this.engine.alive) ||
      // A running real-time worker makes the engine report about every second while hops flow.
      (this.engineReady && this.rtReadySeen && hopsFlow && now - Math.max(this.lastEngineMessageAt, this.rtStartedAt) > this.t.engineSilent);
    if (broken) {
      if (now - this.engineReplacedAt < this.t.engineRestart) return;
      this.engineReplacedAt = now;
      this.disposeEngine();
      if (this.hasAudiblePlayback()) void this.startEngine(now);
      return;
    }
    if (!this.engine || !hopsFlow || s.locked || s.mode === 'lookahead') return;
    // Not ready: a model load that hangs (one that failed reported an error, shown in the status).
    const rtStuck = this.rtReadySeen
      ? this.rtUnhealthySince !== null && now - this.rtUnhealthySince > this.t.rtUnhealthy
      : this.realtimeError === null && now - this.rtStartedAt > this.t.engineReady;
    if (rtStuck && now - this.rtRestartedAt >= this.t.engineRestart) this.restartRealtime(now);
  }

  /** Replaces the real-time worker over a fresh channel; the mixer starts a new real-time session on it. */
  private restartRealtime(now: number): void {
    const engine = this.engine;
    if (!engine) return;
    this.rtRestartedAt = now;
    this.rtStartedAt = now;
    this.rtUnhealthySince = null;
    const rt = new MessageChannel();
    this.postMixer({ type: 'connect-rt' }, [rt.port1]);
    engine.post({ type: 'restart-realtime' }, [rt.port2]);
    this.postPlayback(true);
  }

  private onHook(m: HookMessage): void {
    if (m.type === 'ms-url') this.msByUrl.set(m.url, m.msId);
    if (m.type === 'ms-worker') this.workerMse = true;
    this.engine?.post({ type: 'hook', message: m }, m.type === 'sb-append' ? [m.data] : []);
  }

  private onEngine(m: EngineOut): void {
    this.lastEngineMessageAt = Date.now();
    if (m.type === 'ready') {
      this.engineReady = true;
      this.gpu = m.gpu;
    } else if (m.type === 'status') {
      this.lookahead = m.lookahead;
      this.realtimeError = m.realtime.error ?? null;
      if (m.realtime.ready) this.rtReadySeen = true;
    }
    this.publish(false);
  }

  private sendPlayhead(): void {
    const el = this.current;
    const engine = this.engine;
    if (!el || !engine) return;
    const msId = el.src ? (this.msByUrl.get(el.src) ?? null) : null;
    if (msId !== this.activeMs) {
      this.activeMs = msId;
      engine.post({ type: 'active-timeline', msId });
    }
    const playhead: PlayheadInfo = {
      time: el.currentTime,
      paused: el.paused,
      rate: el.playbackRate,
      seeking: el.seeking,
      audible: isAudible(el),
      at: performance.now(),
    };
    engine.post({ type: 'playhead', playhead });
  }

  // ───────────── timer ─────────────

  private tick(): void {
    if (this.dead) return;
    if (!extensionAlive()) {
      this.shutdown();
      return;
    }
    if (!this.settingsLoaded) return;
    const now = Date.now();
    for (const el of this.problems.keys()) if (!el.isConnected) this.clearProblem(el);
    for (const el of this.sources) if (!el.isConnected && el.paused) this.release(el);
    if (this.active) {
      this.inactiveSince = null;
      this.selectCurrent();
      const processing = this.current !== null && wantsProcessing(this.current);
      if (!processing && now - this.lastDiscoveryAt >= this.t.discovery) this.discover(now);
      if (this.hasAudiblePlayback()) {
        this.lastAudibleAt = now;
        this.ensureEngine();
      }
      this.watchSilence(now);
      // Chrome reports outputLatency as 0 until audio has played: check on every tick until then.
      const reported = (this.ctx?.outputLatency ?? 0) > 0;
      if (!reported || now - this.lastLatencyCheckAt >= this.t.latencyRefresh) this.refreshOutputLatency();
    } else {
      this.inactiveSince ??= now;
      this.silentSince = null;
    }
    this.checkEngine(now);
    this.sendPlayhead();
    // Events cover every change; this catches what they could miss.
    this.postPlayback();
    this.publish(false);
  }

  /**
   * Backstop for routed media whose audio became unreadable unnoticed (an http(s) response that
   * taints it, which the source check could not prove): the current element plays audibly with
   * enough data, its time advances and it decodes audio, but the mixer has received only digital
   * silence for as long as this source has played. Sources made by the page (MediaSource, blobs,
   * streams) cannot be tainted; sound heard earlier in the same source means the content itself
   * went silent; media without an audio track decodes none.
   */
  private watchSilence(now: number): void {
    const el = this.current;
    const s = this.mixerStats;
    const time = el?.currentTime ?? NaN;
    const advancing = !Number.isNaN(this.lastMediaTime) && time !== this.lastMediaTime;
    this.lastMediaTime = time;
    const watching =
      el !== null &&
      s !== null &&
      this.mixerEnabled &&
      now - this.mixerStatsAt < STATS_FRESH_MS &&
      wantsProcessing(el) &&
      el.readyState >= 3 &&
      !el.seeking &&
      advancing;
    if (!watching) {
      this.silentSince = null;
      return;
    }
    const key = sourceKey(el);
    if (s.inRms > 0) {
      this.silentSince = null;
      this.heardSource.set(el, key);
      if (this.problems.get(el)?.silence) this.clearProblem(el);
      return;
    }
    if (urlVerdict(el) !== 'probe' || this.heardSource.get(el) === key) {
      this.silentSince = null;
      return;
    }
    const bytes = decodedAudioBytes(el);
    if (this.silentSince === null) {
      this.silentSince = now;
      this.silentBytes = bytes;
      return;
    }
    if (now - this.silentSince <= this.t.silentInput || this.problems.has(el)) return;
    const decoding = bytes !== null && this.silentBytes !== null ? bytes > this.silentBytes : hasAudioTrack(el) !== false;
    if (decoding) this.setProblem(el, SILENT_INPUT);
  }

  // ───────────── status ─────────────

  status(): TabStatus {
    const base = { site: this.site, enabled: this.enabled, gpu: this.gpu, lookahead: this.lookaheadStatus() } as const;
    if (this.captureActive) return { ...base, mode: 'off', detail: 'Tab capture is processing this tab.' };
    if (!this.enabled || this.dead) return { ...base, mode: 'off' };
    const problem = this.failure ?? this.visibleProblem();
    if (problem) {
      return {
        ...base,
        mode: problem.mode,
        detail: problem.detail,
        ...(problem.needsTabCapture ? { needsTabCapture: true } : {}),
        ...(problem.needsReload ? { needsReload: true } : {}),
      };
    }
    if (this.gesturePending) return { ...base, mode: 'waiting', detail: 'Click or press a key on the page to start.' };
    if (this.graphError && !this.node) return { ...base, mode: 'passthrough', detail: this.graphError };
    const cur = this.current;
    if (!cur) {
      if (this.frameHost) {
        return { ...base, mode: 'unsupported', detail: `The video plays in a frame from ${this.frameHost}.`, needsTabCapture: true };
      }
      return { ...base, mode: 'waiting', detail: 'Waiting for a video to play.' };
    }
    if (!this.engine && !this.engineStarting) {
      if (this.engineError) return { ...base, mode: 'passthrough', detail: this.engineError };
      // Released while nothing audible played; it starts again with audible playback.
      return { ...base, mode: 'waiting', detail: cur.paused ? 'Paused.' : 'No sound.' };
    }
    const s = this.mixerStats;
    if (!s || !this.engineReady || !this.mixerEnabled) return { ...base, mode: 'starting' };
    return { ...base, ...mixerStatus(s, cur.paused, this.realtimeError) };
  }

  private lookaheadStatus(): LookaheadStatus | undefined {
    return this.workerMse ? { state: 'unavailable', reason: 'This player decodes media in a worker.' } : this.lookahead;
  }

  private publish(force: boolean): void {
    if (this.dead || !this.settingsLoaded) return;
    const status = this.status();
    const key = statusKey(status);
    const now = Date.now();
    const heartbeatDue = status.mode !== 'off' && now - this.lastStatusAt >= this.t.heartbeat;
    if (!force && key === this.lastStatusKey && !heartbeatDue) return;
    this.lastStatusKey = key;
    this.lastStatusAt = now;
    if (import.meta.env.MODE !== 'production') mirrorDebugStatus(JSON.stringify(status));
    this.runtime({ type: 'tab-status', status }).catch(() => {});
  }

  /**
   * The extension was reloaded, updated or removed: hand the audio back unchanged (zero-latency
   * bypass, then the direct path) and stop everything. The AudioContext keeps running: the routed
   * elements play through it. Never throws.
   */
  shutdown(): void {
    if (this.dead) return;
    this.dead = true;
    safely(() => this.listeners.abort());
    for (const f of this.cleanups.splice(0)) safely(f);
    for (const id of this.intervals.splice(0)) clearInterval(id);
    this.clearSettle();
    safely(() => this.postConfig());
    safely(() => this.disposeEngine());
    this.debugWaiters = [];
    const node = this.node;
    if (!node) return;
    node.onprocessorerror = null;
    safely(() =>
      setTimeout(() => {
        safely(() => this.setPath('direct'));
        node.port.onmessage = null;
      }, this.bypassDelay()),
    );
  }

  // ───────────── debug bridge (development and test builds) ─────────────

  debugSnapshot(): Record<string, unknown> {
    const el = this.current;
    return {
      status: this.status(),
      shutDown: this.dead,
      mixer: this.mixerStats,
      graph: { path: this.path, settling: this.settle?.to ?? null, sources: this.sources.size, playing: this.playbackSent },
      engine: this.engine ? (this.engineReady ? 'ready' : 'connecting') : this.engineStarting ? 'starting' : 'none',
      current: el && { src: el.currentSrc, paused: el.paused, muted: el.muted, volume: el.volume },
    };
  }

  debugRecord(seconds: number): Promise<DebugRecording> {
    if (!this.node || this.path !== 'worklet' || this.dead) return Promise.reject(new Error('The mixer is not in the audio path.'));
    return new Promise((resolve) => {
      this.debugWaiters.push(resolve);
      this.postMixer({ type: 'debug-record', seconds });
    });
  }
}

/** Identifies what the element plays, for the per-source tap verdict. */
function sourceKey(el: HTMLMediaElement): string {
  return (el.mediaKeys ? 'drm:' : '') + (el.srcObject ? 'object' : el.currentSrc || el.src);
}

/** Output latency of the context in frames (Chrome reports outputLatency as 0 until audio plays). */
function outputLatencyFrames(ctx: AudioContext): number {
  return Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * SAMPLE_RATE);
}

/** Real-time jitter allowance covering the audio callback size: a reply can only be used from the next callback. */
function initialJitter(ctx: AudioContext): number {
  return Math.max(DEFAULT_JITTER, Math.round((ctx.baseLatency || 0) * SAMPLE_RATE) + RT_HOP + JITTER_MARGIN);
}

/** Resolves true once the context runs; resumes it on the next user gesture. False if closed or aborted. */
function waitForRunning(ctx: AudioContext, signal: AbortSignal): Promise<boolean> {
  if (ctx.state === 'running') return Promise.resolve(true);
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const stop = new AbortController();
    const done = (running: boolean) => {
      stop.abort();
      resolve(running);
    };
    const onGesture = () => void ctx.resume().catch(() => {});
    for (const t of ['pointerdown', 'keydown', 'touchend'] as const) {
      window.addEventListener(t, onGesture, { capture: true, signal: stop.signal });
    }
    ctx.addEventListener(
      'statechange',
      () => {
        if (ctx.state === 'running') done(true);
        else if (ctx.state === 'closed') done(false);
      },
      { signal: stop.signal },
    );
    signal.addEventListener('abort', () => done(false), { signal: stop.signal });
    void ctx.resume().catch(() => {});
  });
}
