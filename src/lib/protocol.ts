// Message types shared by every context of the extension. See docs/ARCHITECTURE.md.
import type { Settings } from './settings';

// ───────────── MAIN-world hook → ISOLATED controller (private MessagePort) ─────────────

/** Marker used for the window.postMessage handshake between the two worlds. */
export const HOOK_HANDSHAKE = '__bgmr_hook_connect__';

export type HookMessage =
  /** A MediaSource got an object URL (lets the controller match `video.src` to a MediaSource). */
  | { type: 'ms-url'; msId: number; url: string }
  /** A SourceBuffer was added. Sent for every mime type; only audio appends are forwarded. */
  | { type: 'sb-add'; msId: number; sbId: number; mime: string }
  /**
   * An append to an audio SourceBuffer completed (posted after `updateend`; `ok` is false when the
   * append raised `error`). `data` is a copy owned by the receiver.
   */
  | {
      type: 'sb-append';
      msId: number;
      sbId: number;
      data: ArrayBuffer;
      timestampOffset: number;
      appendWindowStart: number;
      appendWindowEnd: number;
      ok: boolean;
    }
  | { type: 'sb-abort'; msId: number; sbId: number }
  | { type: 'sb-remove'; msId: number; sbId: number; start: number; end: number }
  | { type: 'sb-change-type'; msId: number; sbId: number; mime: string }
  | { type: 'sb-gone'; msId: number; sbId: number }
  /** The page attached a MediaSourceHandle (MSE in a worker): look-ahead is impossible. */
  | { type: 'ms-worker' };

// ───────────── Controller ⇄ engine iframe (MessagePort) ─────────────

export type LookaheadState = 'off' | 'loading' | 'ready' | 'unavailable' | 'error';

export interface PlayheadInfo {
  /** video.currentTime in seconds (media timeline of the active MediaSource). */
  time: number;
  paused: boolean;
  rate: number;
  seeking: boolean;
  /** False when the element is muted or at volume 0 (nothing to process). */
  audible: boolean;
  /**
   * Sampling time in ms on the RECEIVER's clock. Clocks of different processes can disagree by
   * hours after a system sleep, so the look-ahead worker re-stamps this when a message arrives;
   * senders may put any value here.
   */
  at: number;
}

export type EngineIn =
  | { type: 'init'; settings: Settings; lookahead: boolean }
  | { type: 'settings'; settings: Settings }
  /** Transfers [realtimePort, lookaheadPort]; the other ends are held by the worklet. */
  | { type: 'connect-worklet' }
  | { type: 'hook'; message: HookMessage }
  /** MediaSource id currently attached to the controlled element (null: not MSE / unknown). */
  | { type: 'active-timeline'; msId: number | null }
  | { type: 'playhead'; playhead: PlayheadInfo }
  /**
   * Replace only the real-time worker (it stopped answering); transfers [realtimePort] whose other
   * end the controller just gave the worklet with a new 'connect-rt'. The look-ahead worker stays.
   */
  | { type: 'restart-realtime' }
  | { type: 'dispose' };

export interface LookaheadStatus {
  state: LookaheadState;
  reason?: string;
  /** Model processing time / audio duration (lower is better). */
  rtf?: number;
  /** Seconds of processed audio ahead of the playhead. */
  aheadSeconds?: number;
  backend?: 'webgpu' | 'wasm';
}

export type EngineOut =
  | { type: 'ready'; gpu: string | null }
  | { type: 'status'; realtime: { ready: boolean; rtf?: number; error?: string }; lookahead: LookaheadStatus }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

// ───────────── Worklet ⇄ real-time worker (MessagePort) ─────────────

export type RtToWorker =
  /** `index` is the worklet frame index of data[0]; data is RT_HOP mono (mid) samples. */
  | { type: 'hop'; index: number; data: Float32Array }
  | { type: 'reset' };

export type RtFromWorker =
  | { type: 'ready' }
  /**
   * Speech estimate, delay-compensated: data[i] estimates the speech in input frame index + i.
   * (index = hop index − DFN_DELAY, so the first calls after a reset have index < 0.) After a model
   * error or for a stale hop the worker skipped, data is the (delayed) input itself and
   * `passthrough` is set: the mixer treats it like a missing answer (crossfaded pass-through).
   */
  | { type: 'speech'; index: number; data: Float32Array; passthrough?: true }
  /** Periodic performance report: processing time / audio time over the last `frames` input frames. */
  | { type: 'stats'; rtf: number; frames: number }
  | { type: 'error'; message: string };

// ───────────── Worklet ⇄ look-ahead worker (MessagePort) ─────────────

export type LaToWorker =
  /** Last PROBE_LENGTH mono input samples, ending (exclusive) at worklet frame `frameEnd`. */
  { type: 'probe'; id: number; frameEnd: number; data: Float32Array };

export type LaFromWorker =
  /** Processed audio for media indices [start, start + length) of a timeline. */
  | {
      type: 'block';
      timelineId: number;
      start: number;
      speechL: Float32Array;
      speechR: Float32Array;
      residualL: Float32Array;
      residualR: Float32Array;
    }
  /** Drop stored blocks (all, or for one timeline). */
  | { type: 'flush'; timelineId?: number }
  | {
      type: 'probe-result';
      id: number;
      frameEnd: number;
      found: boolean;
      timelineId: number;
      /** Media index corresponding to frameEnd. */
      mediaEnd: number;
      /** Least-squares gain of the element input relative to the decoded mix. */
      gain: number;
      /** Normalised correlation in [0, 1]. */
      score: number;
    };

// ───────────── Controller ⇄ worklet (AudioWorkletNode.port) ─────────────

export type MixerMode = 'bypass' | 'idle' | 'passthrough' | 'realtime' | 'lookahead';

export interface MixerConfig {
  /** false: output the input unchanged with no added latency. */
  enabled: boolean;
  /** Linear residual gain g (see settings.reductionGain). */
  residualGain: number;
  gapReduction: boolean;
  /** Use look-ahead blocks when locked. */
  lookahead: boolean;
  /**
   * Audio output latency in frames (round((ctx.baseLatency + ctx.outputLatency) · 48000)). Chrome
   * does not compensate it for media routed through Web Audio; look-ahead output leads by this
   * much (and by L) so that it is heard in sync with the picture.
   */
  outputLatency: number;
}

export type ToMixer =
  | { type: 'connect-rt' } // transfers [port]
  | { type: 'connect-la' } // transfers [port]
  | { type: 'config'; config: MixerConfig }
  /**
   * Playback state of the controlled element, sent on every change: playing = not paused, not
   * seeking, not ended, not waiting for data, and playbackRate === 1. Look-ahead output only
   * continues while playing; silence in the content itself (playing === true) keeps the lock.
   */
  | { type: 'playback'; playing: boolean }
  | { type: 'debug-record'; seconds: number };

export interface MixerStats {
  /**
   * 'idle': the input has been digital silence for a while: no processing (a look-ahead lock may
   * be kept through silence while the element plays). 'bypass': the output equals the input; it
   * is reported at once when a disable's crossfade has finished.
   */
  mode: MixerMode;
  /** Locked to the look-ahead stream (the output may still wait up to 1.5 s for a speech-free switch). */
  locked: boolean;
  /** Added output latency in frames (0 in look-ahead mode, which plays in sync, and in bypass). */
  latency: number;
  /** Real-time underruns since start. */
  underruns: number;
  inRms: number;
  outRms: number;
  /** Seconds of look-ahead audio stored ahead of the current output position (0 when unlocked). */
  laAhead: number;
  /** Measured worklet → worker → worklet round trip of the last hop, ms. */
  rtRoundTripMs: number;
  /**
   * False while hops are being sent but no speech has come back for over 1 s after the worker's
   * 'ready' (or 10 s without 'ready'); it stays false through idle until speech arrives.
   */
  rtHealthy: boolean;
}

export type FromMixer =
  | { type: 'stats'; stats: MixerStats }
  /**
   * Debug capture of `seconds` of audio: the UNDELAYED input x[f] and the output y[f] for the same
   * frames f (stereo). Real-time output lags the input by `latency`; look-ahead output leads it by
   * the configured outputLatency, so callers must align the output themselves.
   */
  | { type: 'debug-recording'; input: [Float32Array, Float32Array]; output: [Float32Array, Float32Array] };

// ───────────── Content scripts ⇄ background ⇄ popup (chrome.runtime) ─────────────

export type TabMode =
  | 'off'
  | 'waiting' // enabled, waiting for playback / user gesture
  | 'starting'
  | 'realtime'
  | 'lookahead'
  | 'passthrough'
  | 'tabcapture'
  | 'unsupported';

export interface TabStatus {
  mode: TabMode;
  /** Human-readable detail shown in the popup. */
  detail?: string;
  site: 'youtube' | 'generic' | 'tabcapture';
  enabled: boolean;
  gpu?: string | null;
  lookahead?: LookaheadStatus;
  latencyMs?: number;
  /** True when the page has media that can only be processed with tab capture. */
  needsTabCapture?: boolean;
  /** Routed media plays silently (its audio became unreadable): only reloading the page restores it. */
  needsReload?: boolean;
}

export type RuntimeMessage =
  | { type: 'tab-status'; status: TabStatus }
  | { type: 'get-tab-status'; tabId: number }
  | { type: 'tab-command'; command: 'enable' | 'disable' }
  | { type: 'enable-on-tab'; tabId: number }
  | { type: 'start-tab-capture'; tabId: number }
  | { type: 'stop-tab-capture'; tabId: number }
  | { type: 'offscreen-start'; tabId: number; streamId: string; settings: Settings }
  | { type: 'offscreen-stop'; tabId: number }
  | { type: 'offscreen-settings'; settings: Settings }
  | { type: 'offscreen-status'; tabId: number; status: TabStatus }
  /** Background → all frames of a tab: tab capture started/stopped (in-page processing stands down). */
  | { type: 'capture-state'; active: boolean }
  /** Content script → background; reply { active: boolean } for the sender's tab. */
  | { type: 'get-capture-state' }
  /** Content script → background: one-time token the engine iframe will present (see engine-verify). */
  | { type: 'engine-token'; token: string }
  /** Engine iframe → background; reply { ok: boolean }: the token was issued for the same tab. Consumes it. */
  | { type: 'engine-verify'; token: string };
