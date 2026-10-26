/**
 * Logic of the look-ahead worker (pure, testable): ingests the page's MSE audio appends
 * (demux → decoder → 48 kHz PcmStore per timeline), runs the build's separation model
 * (./models.ts) ahead of the playhead of the active timeline, streams {speech, residual} blocks
 * to the worklet and answers its alignment probes. The worker entry provides the model backend,
 * the decoder factory and the message ports.
 *
 * Blocks follow docs/ARCHITECTURE.md: speech = compensate · model vocals and
 * residual = mix − speech, with mix the chunk's own input, so speech + residual is exactly the
 * decoded mix the model saw.
 *
 * Resources and failures: nothing is processed while the element is inaudible or plays at a speed
 * other than 1× (the worklet cannot lock then). The backend is released after a minute without a
 * model run (paused, enough processed ahead, disabled, muted, other speed) and loaded again when
 * needed; decoded audio is dropped after a minute disabled. A failed run is retried after growing
 * delays. A backend that cannot keep up with playback stops look-ahead ('unavailable') until it
 * is switched off and on, or for ten minutes.
 */
import { SAMPLE_RATE } from '../constants';
import { alignProbe } from '../dsp/align';
import { BackendTooSlowError, BackendUnavailableError, TOO_SLOW_REASON, type MdxBackend } from '../mdx/mdx';
import type { MdxStream, MdxStreamBlock } from '../mdx/mdx-stream';
import type { HookMessage, LaFromWorker, LaToWorker, LookaheadStatus, PlayheadInfo } from '../protocol';
import { MseAudioIngest, type DecoderFactory } from './ingest';
import { createModelStream, type LookaheadModel } from './models';
import type { PcmStore } from './pcm-store';

export type { AudioDecoderLike, DecoderFactory } from './ingest';
export type { DecodedAudio } from './pcm-writer';

export interface LookaheadCoreOptions {
  model: LookaheadModel;
  backend: MdxBackend;
  decoderFactory: DecoderFactory;
  postWorklet: (msg: LaFromWorker, transfer?: Transferable[]) => void;
  onStatus: (status: LookaheadStatus) => void;
  /** Target of processed audio ahead of the playhead, in seconds (default 30, at most 50). */
  aheadSeconds?: number;
  /** Decoded PCM kept behind the playhead, in seconds (default 30). */
  keepBehindSeconds?: number;
  /** Decoded PCM kept ahead of the playhead, in seconds (default 120). */
  keepAheadSeconds?: number;
  /**
   * Clock in milliseconds (default performance.now). PlayheadInfo.at must be on this clock: the
   * worker stamps playheads when they arrive.
   */
  now?: () => number;
  /** Waits before the retries after failed processing, in ms (default 5 s, 30 s, 120 s; then it stays failed). */
  retryDelaysMs?: readonly number[];
  /** The backend is released after this long without a model run, in ms (default 60 s). */
  idleReleaseMs?: number;
  /** After this long disabled, in ms, decoded and retained audio is dropped and decoding stops (default 60 s). */
  suspendAfterMs?: number;
  /** Encoded audio kept per SourceBuffer for re-decoding after seeks backwards, in bytes (default 24 MB). */
  maxEncodedBytes?: number;
  /** Look-ahead stops when the real-time factor (median of the last chunks) exceeds this (default 0.7). */
  maxRtf?: number;
  /** After stopping because the backend was too slow, look-ahead is tried again after this long, in ms (default 10 min). */
  tooSlowRetryMs?: number;
}

const DEFAULT_AHEAD_SECONDS = 30;
const DEFAULT_KEEP_BEHIND_SECONDS = 30;
const DEFAULT_KEEP_AHEAD_SECONDS = 120;
/** Extra PCM a timeline may hold beyond its keep window before its store bound evicts data. */
const STORE_SLACK_SECONDS = 30;
/** Previously active timelines whose PCM is kept (most recent first); older ones are cleared. */
const MAX_INACTIVE_TIMELINES = 1;
/**
 * Look-ahead audio the worklet stores (MixerCore's MAX_BLOCK_SECONDS). It evicts the oldest
 * blocks beyond that, so a seek back before them needs processing again.
 */
const WORKLET_BLOCK_SECONDS = 60;
/** The processing target stays this far below the worklet's storage, which keeps blocks behind the playhead. */
const WORKLET_BEHIND_SECONDS = 10;
/** A playhead this far before the stream origin is a seek backwards. */
const SEEK_BACK_SECONDS = 1;
/** A playhead this far after the processed end is a seek forwards (or processing fell behind). */
const SEEK_FORWARD_SECONDS = 2;
/** A playhead this far from the extrapolation of the previous one was moved (a seek). */
const PLAYHEAD_JUMP_SECONDS = 1;
/** The playhead is extrapolated at most this long (ms) after the last playhead message. */
const MAX_EXTRAPOLATION_MS = 1000;
/**
 * When the next chunk's input is not fully decoded (end of the media, or the page stopped
 * appending) and less than this much processed audio remains ahead of the playhead, the chunk is
 * processed with silence after the decoded audio and blocks stop at its end.
 */
const END_SLACK_SECONDS = 3;
/** The first chunk after a reset tolerates this much missing audio before the first decoded sample. */
const LEADING_GAP_SECONDS = 0.25;
/** Missing PCM is decoded again from the retained frames this far beyond the processing target. */
const REDECODE_EXTRA_SECONDS = 15;
/** Probe search window on each side of the extrapolated playhead. */
const PROBE_WINDOW_SECONDS = 0.75;
/** Probe search window on each side of the position predicted from the previous match. */
const PREDICTION_WINDOW_SECONDS = 0.25;
/** A predicted match at least this good is accepted without searching around the playhead. */
const PREDICTION_ACCEPT_SCORE = 0.9;
const STATUS_INTERVAL_MS = 250;
/** The real-time factor is the median over this many of the last measured chunks (one slow chunk does not count). */
const RTF_WINDOW = 5;
/** Look-ahead stops when the real-time factor exceeds this, once SPEED_CHECK_CHUNKS chunks are measured. */
const DEFAULT_MAX_RTF = 0.7;
const SPEED_CHECK_CHUNKS = 3;
const DEFAULT_TOO_SLOW_RETRY_MS = 10 * 60_000;
/** Consecutive restarts because processing fell behind the playhead (not seeks) that stop look-ahead. */
const MAX_BEHIND_RESTARTS = 3;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5000, 30_000, 120_000];
const DEFAULT_IDLE_RELEASE_MS = 60_000;
const DEFAULT_SUSPEND_AFTER_MS = 60_000;

const WORKER_MSE_REASON = 'The page plays media from a worker (MediaSourceHandle); look-ahead is not possible.';
const SPEED_REASON = 'Look-ahead needs normal playback speed (1×). Using real-time mode.';

/** One chunk ready for MdxStream.processNext(). */
interface Job {
  timelineId: number;
  epoch: number;
  /**
   * Decoded mix of [mixStart, mixStart + mixL.length) when the job was built (zeros after `cut`):
   * the model input and the start of the next block, which can lie a few samples before the
   * input (resampler margins). Residuals are computed from it.
   */
  mixStart: number;
  mixL: Float32Array;
  mixR: Float32Array;
  /** The model input: the end of the mix, from nextInputRange().start. */
  inputL: Float32Array;
  inputR: Float32Array;
  /** Blocks are emitted from this index on: the origin, or the first decoded sample after a short gap. */
  emitFrom: number;
  /** The decoded audio ends here; the input after it is silence and blocks stop here. */
  cut: number | null;
}

interface ProbeMatch {
  mediaEnd: number;
  gain: number;
  score: number;
}

export class LookaheadCore {
  private readonly model: LookaheadModel;
  private readonly backend: MdxBackend;
  private readonly postWorklet: LookaheadCoreOptions['postWorklet'];
  private readonly onStatus: LookaheadCoreOptions['onStatus'];
  private readonly now: () => number;
  private readonly ahead: number;
  private readonly keepBehind: number;
  private readonly keepAhead: number;
  private readonly retryDelays: readonly number[];
  private readonly idleReleaseMs: number;
  private readonly suspendAfterMs: number;
  private readonly maxRtf: number;
  private readonly tooSlowRetryMs: number;
  private readonly stream: MdxStream;
  private readonly ingest: MseAudioIngest;

  private enabled = true;
  private disposed = false;
  private active: number | null = null;
  private playhead: PlayheadInfo | null = null;
  /** When each previously active timeline stopped being active. */
  private readonly inactiveSince = new Map<number, number>();

  /** Timeline the stream's state belongs to; null: the stream must be reset before use. */
  private streamTimeline: number | null = null;
  /** Origin of the stream's current chunk grid. */
  private origin = 0;
  /** Start of the contiguous blocks sent (or to be sent) since the last seek. */
  private sessionStart = 0;
  /** Blocks before this index are stale (their PCM changed behind the playhead). */
  private staleBefore = -Infinity;
  /** Longest block sent since the session started (the worklet evicts whole blocks). */
  private longestBlock = 0;
  /** Set when the last block stopped at the end of the decoded audio (processing waits for more). */
  private cutAt: number | null = null;
  /** Blocks of streamTimeline were sent since its last flush. */
  private sentBlocks = false;
  /** Input range of the chunk being processed. */
  private inflight: { timelineId: number; start: number; end: number } | null = null;
  /** Incremented whenever results of a chunk in flight become invalid. */
  private epoch = 0;
  private looping = false;
  private kickQueued = false;
  /** kick() was called while the loop ran: it decides again once it ends. */
  private kickMissed = false;
  private mixL = new Float32Array(0);
  private mixR = new Float32Array(0);

  /** A seek was seen since the session started (a `seeking` playhead or a jump). */
  private seekSeen = false;
  /** Processing waited for decoded audio since the session started. */
  private waitedForData = false;
  /** Consecutive sessions restarted because processing fell behind the playhead. */
  private behindRestarts = 0;

  private failure: string | null = null;
  /** Failed runs since the last block (selects the retry delay). */
  private failures = 0;
  /** Why the backend cannot be used on this page (no usable GPU, too slow). */
  private backendUnavailable: string | null = null;
  /** The page plays media from a worker: nothing to ingest. */
  private workerMse = false;
  private readonly timelineErrors = new Map<number, string>();
  private readonly timelineUnsupported = new Map<number, string>();
  /** Blocks were produced for the active timeline since it became active (or since the PCM was dropped). */
  private producedBlock = false;
  /** Median of `rtfs`. */
  private rtf: number | undefined = undefined;
  /** Real-time factors of the last RTF_WINDOW measured chunks, oldest first. */
  private readonly rtfs: number[] = [];
  /** The next model run is the first one of a fresh backend session: its time includes the warm-up. */
  private warmup = true;
  /** Processing time not measured yet: chunks that finalized nothing, or did not run the model (silence). */
  private pendingMs = 0;
  /** A chunk counted in pendingMs ran the model. */
  private pendingModel = false;
  private lastStatusAt = -Infinity;
  private lastStatusKey = '';
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;

  private lastMatch: { timelineId: number; frameEnd: number; mediaEnd: number } | null = null;
  private refL = new Float32Array(0);
  private refR = new Float32Array(0);
  private refMono = new Float32Array(0);

  constructor(opts: LookaheadCoreOptions) {
    this.model = opts.model;
    this.backend = opts.backend;
    this.postWorklet = opts.postWorklet;
    this.onStatus = opts.onStatus;
    this.now = opts.now ?? (() => performance.now());
    this.retryDelays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.idleReleaseMs = opts.idleReleaseMs ?? DEFAULT_IDLE_RELEASE_MS;
    this.suspendAfterMs = opts.suspendAfterMs ?? DEFAULT_SUSPEND_AFTER_MS;
    this.maxRtf = opts.maxRtf ?? DEFAULT_MAX_RTF;
    this.tooSlowRetryMs = opts.tooSlowRetryMs ?? DEFAULT_TOO_SLOW_RETRY_MS;
    this.keepBehind = Math.round((opts.keepBehindSeconds ?? DEFAULT_KEEP_BEHIND_SECONDS) * SAMPLE_RATE);
    this.keepAhead = Math.round((opts.keepAheadSeconds ?? DEFAULT_KEEP_AHEAD_SECONDS) * SAMPLE_RATE);
    // Processing further ahead than the kept PCM would wait for evicted audio, and further than
    // the worklet stores would evict the blocks around the playhead.
    const aheadSeconds = Math.min(opts.aheadSeconds ?? DEFAULT_AHEAD_SECONDS, WORKLET_BLOCK_SECONDS - WORKLET_BEHIND_SECONDS);
    this.ahead = Math.min(this.keepAhead, Math.round(aheadSeconds * SAMPLE_RATE));
    this.stream = createModelStream(opts.model, opts.backend);
    this.ingest = new MseAudioIngest({
      decoderFactory: opts.decoderFactory,
      maxSamplesPerTimeline: this.keepBehind + this.keepAhead + STORE_SLACK_SECONDS * SAMPLE_RATE,
      ...(opts.maxEncodedBytes !== undefined ? { maxEncodedBytes: opts.maxEncodedBytes } : {}),
      now: this.now,
      listener: {
        onData: (id) => this.onData(id),
        onError: (id, message) => this.onTimelineError(id, message),
        onUnsupported: (id, reason) => this.onTimelineUnsupported(id, reason),
        onPcmChanged: (id, start, end) => this.onPcmChanged(id, start, end),
        onTimelineGone: (id) => this.onTimelineGone(id),
      },
    });
  }

  /** Handles a message of the page's MSE hook. */
  onHook(msg: HookMessage): void {
    if (this.disposed) return;
    if (msg.type === 'ms-worker') {
      this.workerMse = true;
      this.updateStatus();
      return;
    }
    if (msg.type === 'sb-add' && this.workerMse) {
      this.workerMse = false;
      this.updateStatus();
    }
    this.ingest.handle(msg);
  }

  /** Sets the MediaSource attached to the controlled element (null: none / not MSE). */
  setActiveTimeline(msId: number | null): void {
    if (this.disposed || msId === this.active) return;
    if (this.active !== null) this.inactiveSince.set(this.active, this.now());
    if (msId !== null) this.inactiveSince.delete(msId);
    this.active = msId;
    // The playhead of the previous timeline means nothing for the new one.
    this.playhead = null;
    this.lastMatch = null;
    this.producedBlock = false;
    this.postWorklet({ type: 'flush' });
    this.invalidateStream();
    this.pruneInactiveTimelines();
    this.updateStatus();
  }

  /** Latest playhead of the active timeline (`at` on this core's clock). */
  setPlayhead(p: PlayheadInfo): void {
    if (this.disposed) return;
    const expected = this.playheadNow();
    if (p.seeking || (expected !== null && Math.abs(p.time - expected) > PLAYHEAD_JUMP_SECONDS)) this.seekSeen = true;
    // Nothing is processed at other speeds: the playhead moving on meanwhile is not falling behind.
    if (this.playhead && p.rate !== this.playhead.rate) {
      this.seekSeen = true;
      this.behindRestarts = 0;
    }
    this.playhead = p;
    if (this.active !== null) {
      this.ingest.setFocus(this.active, p.time);
      this.evictAround(this.active, p.time);
    }
    this.kick();
    this.updateStatus();
  }

  /** Answers an alignment probe of the worklet with a 'probe-result'. */
  onProbe(msg: LaToWorker): void {
    if (this.disposed || msg.type !== 'probe') return;
    const timelineId = this.active ?? -1;
    const match = this.locateProbe(msg.data, msg.frameEnd);
    if (match) this.lastMatch = { timelineId, frameEnd: msg.frameEnd, mediaEnd: match.mediaEnd };
    this.postWorklet({
      type: 'probe-result',
      id: msg.id,
      frameEnd: msg.frameEnd,
      found: match !== null,
      timelineId,
      mediaEnd: match?.mediaEnd ?? 0,
      gain: match?.gain ?? 0,
      score: match?.score ?? 0,
    });
  }

  /**
   * false: stop processing; ingestion continues for a while (suspendAfterMs), then the decoded
   * audio is dropped until processing is enabled again (the hook then replays its recent appends).
   * true also retries after a failure, or after the backend was too slow.
   */
  setEnabled(enabled: boolean): void {
    if (this.disposed || enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.clearSuspendTimer();
      this.ingest.resume();
      this.failure = null;
      this.failures = 0;
      this.backendUnavailable = null;
      this.resetSpeed();
      this.clearRetryTimer();
      this.clearSlowTimer();
      this.kick();
    } else {
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        this.suspend();
      }, this.suspendAfterMs);
    }
    this.updateStatus();
  }

  /** Stops everything; a chunk in flight is discarded. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.ingest.dispose();
    this.backend.release?.();
    for (const timer of [this.statusTimer, this.retryTimer, this.idleTimer, this.suspendTimer, this.slowTimer]) {
      if (timer !== null) clearTimeout(timer);
    }
    this.statusTimer = this.retryTimer = this.idleTimer = this.suspendTimer = this.slowTimer = null;
  }

  // ───────────── ingestion events ─────────────

  private onData(timelineId: number): void {
    // Decoded audio arrived: earlier decoding problems are over.
    const hadError = this.timelineErrors.delete(timelineId);
    const changed = this.timelineUnsupported.delete(timelineId) || hadError;
    if (timelineId !== this.active) return;
    if (changed) this.updateStatus();
    // While disabled the controller may stop sending playheads: keep the window of the last one.
    if (!this.enabled && this.playhead) this.evictAround(timelineId, this.playhead.time);
    this.kick();
  }

  private onTimelineError(timelineId: number, message: string): void {
    this.timelineErrors.set(timelineId, message);
    if (timelineId === this.active) this.updateStatus();
  }

  private onTimelineUnsupported(timelineId: number, reason: string): void {
    this.timelineUnsupported.set(timelineId, reason);
    if (timelineId === this.active) this.updateStatus();
  }

  /**
   * The page removed PCM or replaced it with different audio. Blocks computed from the old audio
   * at or after the playhead are flushed and processed again; for older ones it is enough that a
   * seek back there restarts processing.
   */
  private onPcmChanged(timelineId: number, start: number, end: number): void {
    if (timelineId !== this.streamTimeline) return;
    const job = this.inflight;
    const inFlight = job !== null && job.timelineId === timelineId && start < job.end && end > job.start;
    const sent = this.sentBlocks && start < this.processedEnd() && end > this.heldFrom();
    if (!inFlight && !sent) return;
    const time = this.playheadNow();
    if (!inFlight && time !== null && end <= Math.round((time - SEEK_BACK_SECONDS) * SAMPLE_RATE)) {
      this.staleBefore = Math.max(this.staleBefore, end);
      return;
    }
    if (this.sentBlocks) this.postWorklet({ type: 'flush', timelineId });
    this.invalidateStream();
    this.kick();
  }

  private onTimelineGone(timelineId: number): void {
    this.timelineErrors.delete(timelineId);
    this.timelineUnsupported.delete(timelineId);
    this.inactiveSince.delete(timelineId);
    if (this.lastMatch?.timelineId === timelineId) this.lastMatch = null;
    if (timelineId === this.active) this.producedBlock = false;
    this.postWorklet({ type: 'flush', timelineId });
    if (this.streamTimeline === timelineId) this.invalidateStream();
    this.updateStatus();
  }

  /** Clears the audio of timelines that stopped being active before the most recent ones. */
  private pruneInactiveTimelines(): void {
    const inactive = [...this.inactiveSince].sort((a, b) => b[1] - a[1]);
    for (const [id] of inactive.slice(MAX_INACTIVE_TIMELINES)) {
      this.ingest.release(id);
      this.inactiveSince.delete(id);
    }
  }

  /** Drops the timeline's PCM outside the keep window around media time `time` (seconds). */
  private evictAround(timelineId: number, time: number): void {
    const at = Math.round(time * SAMPLE_RATE);
    this.ingest.store(timelineId)?.evictOutside(at - this.keepBehind, at + this.keepAhead);
  }

  /** Disabled for a while: frees the decoded audio (the hook replays its recent appends on re-enable). */
  private suspend(): void {
    this.ingest.suspend();
    this.lastMatch = null;
    // Until audio comes again, nothing can be processed: the status says 'loading', not 'ready'.
    this.producedBlock = false;
    this.invalidateStream();
  }

  // ───────────── processing ─────────────

  private invalidateStream(): void {
    this.streamTimeline = null;
    this.cutAt = null;
    this.sentBlocks = false;
    this.epoch++;
  }

  /** Starts the processing loop soon (after the current event) unless it is running. */
  private kick(): void {
    if (this.looping) this.kickMissed = true;
    if (this.looping || this.kickQueued || this.disposed) return;
    this.kickQueued = true;
    queueMicrotask(() => {
      this.kickQueued = false;
      void this.loop();
    });
  }

  /** Single-flight processing loop: runs chunks while there is work. */
  private async loop(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    this.kickMissed = false;
    try {
      for (let job = this.nextJob(); job !== null; job = this.nextJob()) await this.process(job);
    } catch (e) {
      this.onProcessingError(e);
    } finally {
      this.looping = false;
      this.updateStatus();
    }
    // Something changed while nextJob() was deciding (e.g. PCM decoded synchronously).
    if (this.kickMissed) {
      this.kickMissed = false;
      this.kick();
    }
  }

  /** A failed run: the backend dropped its session; retry after a delay, or stop for good. */
  private onProcessingError(e: unknown): void {
    if (this.disposed) return;
    this.invalidateStream();
    if (e instanceof BackendTooSlowError) {
      this.stopTooSlow();
      return;
    }
    this.releaseBackend();
    if (e instanceof BackendUnavailableError) {
      this.backendUnavailable = e.message;
      return;
    }
    this.failure = `Look-ahead processing failed: ${e instanceof Error ? e.message : String(e)}`;
    const delay = this.retryDelays[this.failures++];
    if (delay === undefined) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.failure = null;
      this.updateStatus();
      this.kick();
    }, delay);
  }

  /** Playhead extrapolated to now, in seconds (null: unknown). */
  private playheadNow(): number | null {
    const p = this.playhead;
    if (!p) return null;
    if (p.paused || p.seeking) return p.time;
    // A playhead message comes every 250 ms; an older one is not extrapolated further.
    const age = Math.min(Math.max(0, this.now() - p.at), MAX_EXTRAPOLATION_MS);
    return p.time + (age / 1000) * p.rate;
  }

  /** End of the audio processed by the current stream (media index). */
  private processedEnd(): number {
    return this.cutAt ?? this.stream.finalizedEnd;
  }

  /** First media index from which the worklet still holds the blocks of the session. */
  private heldFrom(): number {
    // It stores WORKLET_BLOCK_SECONDS of blocks and evicts the oldest whole blocks beyond that.
    const retained = this.processedEnd() - WORKLET_BLOCK_SECONDS * SAMPLE_RATE + this.longestBlock;
    return Math.max(this.sessionStart - SEEK_BACK_SECONDS * SAMPLE_RATE, this.staleBefore, retained);
  }

  /** Decides what to do next: (re)starts the stream when needed and prepares the next chunk. */
  private nextJob(): Job | null {
    const timelineId = this.active;
    if (this.disposed || !this.enabled || this.failure !== null || this.backendUnavailable !== null) return null;
    if (timelineId === null || this.timelineUnsupported.has(timelineId)) return null;
    const store = this.ingest.store(timelineId);
    const time = this.playheadNow();
    // Nothing is heard (muted, volume 0), or the worklet cannot lock (speed ≠ 1×): no processing,
    // ingestion continues.
    if (!store || time === null || this.playhead!.audible === false || this.playhead!.rate !== 1) return null;
    const playhead = Math.round(time * SAMPLE_RATE);
    const stream = this.stream;
    if (this.streamTimeline !== timelineId || playhead < this.heldFrom()) {
      // A new stream, or a seek backwards (or a replay) before the blocks the worklet still holds.
      this.startSession(timelineId, playhead);
    } else if (playhead > this.processedEnd() + SEEK_FORWARD_SECONDS * SAMPLE_RATE) {
      // A seek forwards, or processing fell behind the playhead.
      if (this.seekSeen || this.waitedForData) this.behindRestarts = 0;
      else if (++this.behindRestarts >= MAX_BEHIND_RESTARTS) {
        this.stopTooSlow();
        return null;
      }
      this.startSession(timelineId, playhead);
    } else if (this.cutAt !== null && store.contiguousEnd(this.cutAt - 1) > this.cutAt) {
      // Audio arrived after the point where processing stopped: continue from there (no flush).
      this.restartStream(timelineId, this.cutAt);
    }
    if (this.cutAt !== null) {
      this.waitedForData = true;
      return null;
    }
    if (stream.finalizedEnd >= playhead + this.ahead) {
      this.behindRestarts = 0;
      return null;
    }

    const { start, end } = stream.nextInputRange();
    // The input must be decoded from the origin on (the context before it may be missing).
    const firstChunk = start < this.origin;
    let required = firstChunk ? this.origin : start;
    let emitFrom = this.origin;
    if (firstChunk && !store.covers(required, required + 1)) {
      const next = store.nextCovered(required);
      if (next !== null && next - required <= LEADING_GAP_SECONDS * SAMPLE_RATE) required = emitFrom = next;
    }
    const available = store.contiguousEnd(required);
    let cut: number | null = null;
    if (available < end) {
      // PCM evicted earlier (seek back, replay) is decoded again from the retained frames, and
      // audio the page appended is still being decoded (the hook's replay at the start): the chunk
      // waits for it rather than being cut.
      this.ingest.redecode(timelineId, start, Math.min(playhead + this.keepAhead, start + this.ahead + REDECODE_EXTRA_SECONDS * SAMPLE_RATE));
      const starving = playhead >= stream.finalizedEnd - END_SLACK_SECONDS * SAMPLE_RATE;
      const decoding = this.ingest.redecoding(timelineId, available, end) || this.ingest.decoding(timelineId, available, end);
      if (available <= required || available <= stream.finalizedEnd || !starving || decoding) {
        this.waitedForData = true;
        return null;
      }
      cut = available;
    }
    // The next block starts at finalizedEnd.
    const mixStart = Math.min(start, stream.finalizedEnd);
    const length = end - mixStart;
    if (this.mixL.length < length) {
      this.mixL = new Float32Array(length);
      this.mixR = new Float32Array(length);
    }
    const mixL = this.mixL.subarray(0, length);
    const mixR = this.mixR.subarray(0, length);
    const read = (cut ?? end) - mixStart;
    store.read(mixStart, read, mixL, mixR);
    mixL.fill(0, read);
    mixR.fill(0, read);
    const inputL = mixL.subarray(start - mixStart);
    const inputR = mixR.subarray(start - mixStart);
    return { timelineId, epoch: this.epoch, mixStart, mixL, mixR, inputL, inputR, emitFrom, cut };
  }

  /** Starts contiguous processing at the playhead; the blocks of the previous session are flushed. */
  private startSession(timelineId: number, playhead: number): void {
    if (this.streamTimeline === timelineId && this.sentBlocks) this.postWorklet({ type: 'flush', timelineId });
    this.sentBlocks = false;
    this.sessionStart = playhead;
    this.staleBefore = -Infinity;
    this.longestBlock = 0;
    this.seekSeen = false;
    this.waitedForData = false;
    this.restartStream(timelineId, playhead);
  }

  private restartStream(timelineId: number, origin: number): void {
    this.stream.reset(origin);
    this.origin = origin;
    this.streamTimeline = timelineId;
    this.cutAt = null;
    this.epoch++;
  }

  private async process(job: Job): Promise<void> {
    const t0 = this.now();
    this.inflight = { timelineId: job.timelineId, start: job.mixStart, end: job.mixStart + job.mixL.length };
    let block: MdxStreamBlock | null;
    try {
      block = await this.stream.processNext(job.inputL, job.inputR);
    } finally {
      this.inflight = null;
      this.armIdleRelease();
    }
    if (job.epoch !== this.epoch || this.disposed) return;
    this.pendingMs += this.now() - t0;
    if (this.stream.lastRanModel) this.pendingModel = true;
    if (!block) return;
    // Read before sendBlock(): posting the block transfers (detaches) its buffers.
    const samples = block.vocalsL.length;
    const blockEnd = block.start + samples;
    // Blocks stop where the decoded audio ends. When it ends after this block (in the chunk's
    // overlap with the next one), they stop at the block end: the overlap was computed with
    // silence after the cut and must not be overlap-added with real audio, so processing
    // restarts there with real context once more audio is decoded.
    if (job.cut !== null) this.cutAt = Math.min(job.cut, blockEnd);
    const start = Math.max(block.start, job.emitFrom);
    const end = Math.min(blockEnd, job.cut ?? blockEnd);
    if (end > start) this.sendBlock(job, block, start, end);
    this.failures = 0;
    this.measure(samples);
    this.producedBlock = true;
    this.updateStatus();
  }

  /** Posts speech = compensate · vocals and residual = mix − speech for [start, end). */
  private sendBlock(job: Job, block: MdxStreamBlock, start: number, end: number): void {
    const length = end - start;
    const offset = start - block.start;
    const whole = offset === 0 && length === block.vocalsL.length;
    const speechL = whole ? block.vocalsL : block.vocalsL.slice(offset, offset + length);
    const speechR = whole ? block.vocalsR : block.vocalsR.slice(offset, offset + length);
    const residualL = new Float32Array(length);
    const residualR = new Float32Array(length);
    // The mix the model saw, not the PCM store, which may have changed during the model run.
    const mixL = job.mixL.subarray(start - job.mixStart);
    const mixR = job.mixR.subarray(start - job.mixStart);
    const compensate = this.model.compensate;
    for (let i = 0; i < length; i++) {
      const l = compensate * speechL[i]!;
      const r = compensate * speechR[i]!;
      speechL[i] = l;
      speechR[i] = r;
      residualL[i] = mixL[i]! - l;
      residualR[i] = mixR[i]! - r;
    }
    this.postWorklet({ type: 'block', timelineId: job.timelineId, start, speechL, speechR, residualL, residualR }, [
      speechL.buffer as ArrayBuffer,
      speechR.buffer as ArrayBuffer,
      residualL.buffer as ArrayBuffer,
      residualR.buffer as ArrayBuffer,
    ]);
    this.sentBlocks = true;
    this.longestBlock = Math.max(this.longestBlock, length);
  }

  /**
   * Measures the real-time factor (model and DSP time / new audio) of a chunk that ran the model,
   * `samples` long; the time of chunks without a model run (silence) is added to the next one.
   * The first model run of a backend session (loading, shader compilation) is not counted. A
   * backend too slow for playback (median of the last chunks) stops look-ahead.
   */
  private measure(samples: number): void {
    if (!this.pendingModel) return;
    const elapsedMs = this.pendingMs;
    this.pendingMs = 0;
    this.pendingModel = false;
    if (this.warmup) {
      this.warmup = false;
      return;
    }
    if (samples <= 0) return;
    this.rtfs.push(elapsedMs / 1000 / (samples / SAMPLE_RATE));
    if (this.rtfs.length > RTF_WINDOW) this.rtfs.shift();
    this.rtf = median(this.rtfs);
    if (this.rtfs.length >= SPEED_CHECK_CHUNKS && this.rtf > this.maxRtf) this.stopTooSlow();
  }

  /** Stops look-ahead as too slow; it is tried again after tooSlowRetryMs (load from other tabs or apps may pass). */
  private stopTooSlow(): void {
    this.backendUnavailable = TOO_SLOW_REASON;
    this.releaseBackend();
    this.clearSlowTimer();
    this.slowTimer = setTimeout(() => {
      this.slowTimer = null;
      if (this.backendUnavailable !== TOO_SLOW_REASON) return;
      this.backendUnavailable = null;
      this.resetSpeed();
      this.updateStatus();
      this.kick();
    }, this.tooSlowRetryMs);
    this.updateStatus();
  }

  /** Forgets the speed measurements (the next ones decide afresh). */
  private resetSpeed(): void {
    this.rtfs.length = 0;
    this.rtf = undefined;
    this.behindRestarts = 0;
  }

  /** Frees the backend's session; the next run loads it again (and warms up). */
  private releaseBackend(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.backend.release?.();
    this.warmup = true;
  }

  /** Releases the backend once no model run has happened for idleReleaseMs. */
  private armIdleRelease(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // A run in flight re-arms the timer when it ends.
      if (!this.looping && !this.disposed) this.releaseBackend();
    }, this.idleReleaseMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearSuspendTimer(): void {
    if (this.suspendTimer !== null) clearTimeout(this.suspendTimer);
    this.suspendTimer = null;
  }

  private clearSlowTimer(): void {
    if (this.slowTimer !== null) clearTimeout(this.slowTimer);
    this.slowTimer = null;
  }

  // ───────────── probes ─────────────

  /** Finds where a probe (mono, ending at worklet frame frameEnd) lies in the active timeline. */
  private locateProbe(probe: Float32Array, frameEnd: number): ProbeMatch | null {
    const timelineId = this.active;
    const store = timelineId === null ? undefined : this.ingest.store(timelineId);
    if (!store || probe.length === 0) return null;
    let best: ProbeMatch | null = null;
    const last = this.lastMatch;
    if (last?.timelineId === timelineId) {
      best = this.searchProbe(store, probe, last.mediaEnd + (frameEnd - last.frameEnd), PREDICTION_WINDOW_SECONDS);
      if (best && best.score >= PREDICTION_ACCEPT_SCORE) return best;
    }
    const time = this.playheadNow();
    if (time !== null) {
      const match = this.searchProbe(store, probe, Math.round(time * SAMPLE_RATE), PROBE_WINDOW_SECONDS);
      if (match && (!best || match.score > best.score)) best = match;
    }
    return best;
  }

  /** Aligns the probe against the decoded mono mix with its end within ±windowSeconds of `around`. */
  private searchProbe(store: PcmStore, probe: Float32Array, around: number, windowSeconds: number): ProbeMatch | null {
    const window = Math.round(windowSeconds * SAMPLE_RATE);
    const start = around - window - probe.length;
    const length = probe.length + 2 * window;
    if (this.refMono.length < length) {
      this.refL = new Float32Array(length);
      this.refR = new Float32Array(length);
      this.refMono = new Float32Array(length);
    }
    const { refL, refR } = this;
    if (store.read(start, length, refL, refR) < probe.length) return null;
    const mono = this.refMono.subarray(0, length);
    for (let i = 0; i < length; i++) mono[i] = 0.5 * (refL[i]! + refR[i]!);
    const result = alignProbe(probe, mono);
    if (!result.found) return null;
    return { mediaEnd: start + result.offset + probe.length, gain: result.gain, score: result.score };
  }

  // ───────────── status ─────────────

  private currentStatus(): LookaheadStatus {
    if (this.workerMse) return { state: 'unavailable', reason: WORKER_MSE_REASON };
    if (!this.enabled) return { state: 'off' };
    if (this.backendUnavailable !== null) return { state: 'unavailable', reason: this.backendUnavailable };
    const active = this.active;
    const unsupported = active === null ? undefined : this.timelineUnsupported.get(active);
    if (unsupported !== undefined) return { state: 'unavailable', reason: unsupported };
    if (this.playhead !== null && this.playhead.rate !== 1) return { state: 'unavailable', reason: SPEED_REASON };
    if (this.failure !== null) return { state: 'error', reason: this.failure };
    const timelineError = active === null ? undefined : this.timelineErrors.get(active);
    if (timelineError !== undefined) return { state: 'error', reason: timelineError };
    const status: LookaheadStatus = { state: this.producedBlock ? 'ready' : 'loading', aheadSeconds: this.aheadSeconds() };
    if (this.rtf !== undefined) status.rtf = this.rtf;
    return status;
  }

  /** Seconds of processed audio ahead of the playhead of the active timeline. */
  private aheadSeconds(): number {
    const time = this.playheadNow();
    if (time === null || this.streamTimeline === null || this.streamTimeline !== this.active) return 0;
    return Math.max(0, this.processedEnd() / SAMPLE_RATE - time);
  }

  /** Reports the status, at most once per STATUS_INTERVAL_MS (later changes are sent at the end of the interval). */
  private updateStatus(): void {
    if (this.disposed || this.statusTimer !== null) return;
    const wait = Math.min(STATUS_INTERVAL_MS, this.lastStatusAt + STATUS_INTERVAL_MS - this.now());
    if (wait <= 0) {
      this.emitStatus();
      return;
    }
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (!this.disposed) this.emitStatus();
    }, wait);
  }

  private emitStatus(): void {
    const status = this.currentStatus();
    const key = `${status.state}|${status.reason ?? ''}|${status.rtf?.toFixed(3) ?? ''}|${status.aheadSeconds?.toFixed(2) ?? ''}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.lastStatusAt = this.now();
    this.onStatus(status);
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
