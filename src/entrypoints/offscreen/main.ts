// Tab-capture document (offscreen, extension origin). Each captured tab gets its own session:
// tab stream → mixer worklet (real-time model) → speakers. Capturing mutes the tab, so the
// session output is what the user hears. Only chrome.runtime is available in offscreen
// documents, so settings arrive from the background.
import { DEFAULT_JITTER, RT_HOP, SAMPLE_RATE } from '@/lib/constants';
import type { FromMixer, MixerStats, RuntimeMessage, TabStatus, ToMixer } from '@/lib/protocol';
import { reductionGain, type Settings } from '@/lib/settings';
import type { FromRealtimeWorker, ToRealtimeWorker } from '../engine/messages';
import realtimeWorkerUrl from '../engine/realtime.worker.ts?worker&url';
import { workerUrl } from '../engine/worker-url';

const STATUS_INTERVAL_MS = 1000;

const STOPPED: TabStatus = { mode: 'off', site: 'tabcapture', enabled: false };

/** One captured tab. */
class CaptureSession {
  private stats: MixerStats | null = null;
  private rtError: string | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  private lastReport = '';
  private stopped = false;

  private constructor(
    readonly tabId: number,
    private readonly stream: MediaStream,
    private readonly ctx: AudioContext,
    private readonly node: AudioWorkletNode,
    private readonly worker: Worker,
    onEnded: (session: CaptureSession) => void,
  ) {
    node.port.onmessage = (e: MessageEvent<FromMixer>) => {
      if (e.data.type !== 'stats') return;
      this.stats = e.data.stats;
      this.report(false);
    };
    worker.onmessage = (e: MessageEvent<FromRealtimeWorker>) => {
      if (e.data.type !== 'rt-status') return;
      this.rtError = e.data.error ?? null;
      this.report(false);
    };
    worker.onerror = (e) => {
      this.rtError = e.message || 'The real-time model failed to start.';
      this.report(false);
    };

    // The worklet talks to the model worker directly.
    const channel = new MessageChannel();
    this.postMixer({ type: 'connect-rt' }, [channel.port1]);
    worker.postMessage({ type: 'connect' } satisfies ToRealtimeWorker, [channel.port2]);

    ctx.createMediaStreamSource(stream).connect(node).connect(ctx.destination);
    // The stream ends when the tab closes or the user stops sharing from Chrome's indicator.
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => onEnded(this), { once: true });
    this.timer = setInterval(() => this.report(true), STATUS_INTERVAL_MS);
  }

  /** Captures the tab behind `streamId` and starts processing. */
  static async start(
    tabId: number,
    streamId: string,
    settings: Settings,
    onEnded: (session: CaptureSession) => void,
  ): Promise<CaptureSession> {
    const stream = await navigator.mediaDevices.getUserMedia({
      // Chrome's legacy constraint syntax is the only way to open a tab stream.
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as MediaTrackConstraints,
      video: false,
    });
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    let worker: Worker | null = null;
    try {
      await ctx.audioWorklet.addModule(browser.runtime.getURL('/worklet.js'));
      const node = new AudioWorkletNode(ctx, 'bgmr-mixer', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        // The real-time round trip must also cover the audio callback (one buffer of baseLatency).
        processorOptions: { jitter: Math.max(DEFAULT_JITTER, Math.round(ctx.baseLatency * SAMPLE_RATE) + RT_HOP + 480) },
      });
      worker = new Worker(workerUrl(realtimeWorkerUrl, import.meta.url), { type: 'module' });
      const session = new CaptureSession(tabId, stream, ctx, node, worker, onEnded);
      session.configure(settings);
      if (ctx.state !== 'running') void ctx.resume();
      return session;
    } catch (e) {
      worker?.terminate();
      for (const track of stream.getTracks()) track.stop();
      void ctx.close();
      throw e;
    }
  }

  configure(settings: Settings): void {
    this.postMixer({
      type: 'config',
      config: {
        enabled: settings.enabled,
        residualGain: reductionGain(settings.reductionDb),
        gapReduction: settings.gapReduction,
        lookahead: false,
        // Only used to time look-ahead output, which tab capture has none of.
        outputLatency: Math.round((this.ctx.baseLatency + this.ctx.outputLatency) * SAMPLE_RATE),
      },
    });
  }

  status(): TabStatus {
    const base = { site: 'tabcapture', enabled: true } as const;
    if (this.rtError) {
      return { ...base, mode: 'passthrough', detail: `The speech model failed (${this.rtError}). Audio plays unchanged.` };
    }
    if (this.ctx.state !== 'running') return { ...base, mode: 'starting', detail: 'Waiting for audio output…' };
    const stats = this.stats;
    if (!stats || stats.mode === 'passthrough') return { ...base, mode: 'starting', detail: 'Loading the speech model…' };
    // The mixer bypasses while the model worker does not answer.
    if (stats.rtHealthy === false) {
      return { ...base, mode: 'passthrough', detail: 'The speech model stopped responding. Audio plays unchanged.' };
    }
    if (stats.mode === 'bypass') return { ...base, mode: 'passthrough', detail: 'Processing is switched off.' };
    // The captured tab is silent (paused): nothing is processed until sound comes back.
    if (stats.mode === 'idle') return { ...base, mode: 'tabcapture', detail: 'No sound.' };
    return { ...base, mode: 'tabcapture', latencyMs: Math.round((stats.latency / SAMPLE_RATE) * 1000) };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    for (const track of this.stream.getTracks()) track.stop();
    this.node.port.close();
    this.node.disconnect();
    this.worker.terminate();
    void this.ctx.close();
  }

  /** Sends the status every STATUS_INTERVAL_MS, and right away when it changes. */
  private report(always: boolean): void {
    if (this.stopped) return;
    const status = this.status();
    const json = JSON.stringify(status);
    if (!always && json === this.lastReport) return;
    this.lastReport = json;
    sendStatus(this.tabId, status);
  }

  private postMixer(message: ToMixer, transfer: Transferable[] = []): void {
    this.node.port.postMessage(message, transfer);
  }
}

const sessions = new Map<number, CaptureSession>();
/** Starts in progress, so that a stop arriving meanwhile cancels them. */
const pending = new Map<number, { cancelled: boolean }>();

function sendStatus(tabId: number, status: TabStatus): void {
  browser.runtime.sendMessage({ type: 'offscreen-status', tabId, status } satisfies RuntimeMessage).catch(() => {});
}

function onSessionEnded(session: CaptureSession): void {
  if (sessions.get(session.tabId) !== session) return;
  stopSession(session.tabId);
  sendStatus(session.tabId, { ...STOPPED, detail: 'Tab capture ended.' });
}

async function startSession(tabId: number, streamId: string, settings: Settings): Promise<TabStatus> {
  stopSession(tabId);
  const token = { cancelled: false };
  pending.set(tabId, token);
  try {
    const session = await CaptureSession.start(tabId, streamId, settings, onSessionEnded);
    if (token.cancelled) {
      session.stop();
      return STOPPED;
    }
    sessions.set(tabId, session);
    return session.status();
  } catch (e) {
    return { ...STOPPED, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (pending.get(tabId) === token) pending.delete(tabId);
  }
}

function stopSession(tabId: number): void {
  const token = pending.get(tabId);
  if (token) token.cancelled = true;
  sessions.get(tabId)?.stop();
  sessions.delete(tabId);
}

browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id) return false;
  const msg = raw as RuntimeMessage;
  switch (msg?.type) {
    case 'offscreen-start':
      void startSession(msg.tabId, msg.streamId, msg.settings).then(sendResponse);
      return true;
    case 'offscreen-stop':
      stopSession(msg.tabId);
      sendResponse(true);
      return false;
    case 'offscreen-settings':
      for (const session of sessions.values()) session.configure(msg.settings);
      sendResponse(true);
      return false;
    default:
      // Not for us (e.g. popup ⇄ background traffic): let the intended receiver answer.
      return false;
  }
});
