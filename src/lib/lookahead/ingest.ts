/**
 * Turns the MSE hook messages of a page into decoded 48 kHz PCM, one PcmStore per timeline
 * (MediaSource). Each audio SourceBuffer gets a demuxer; its frames go to a decoder "run" that
 * lasts while the frame timestamps are contiguous. A discontinuity (seek, overlapping append) or
 * a configuration change retires the run (flush, then close) and starts a new decoder, so that
 * every run's output timestamps are anchored on its own first frame.
 *
 * The encoded frames are kept as well (FrameStore, bounded), so that PCM evicted from a store can
 * be decoded again on demand (redecode()): the page does not append them again when the user
 * seeks back into what it still buffers, or replays the media.
 *
 * A decoder needs pre-roll: its first ~35 ms differ from a continuous decode, and it holds back
 * its last samples (the Opus codec delay) until it gets a next frame. A run that starts right
 * after stored frames therefore decodes the last 100 ms of them first (which also completes the
 * end of the previous run), and output that has not settled does not replace stored audio unless
 * the audio is new (see PcmWriter). Identical audio appended again (overlapping re-appends, gaps
 * filled after seeks, the hook's replay) thus gives the same PCM and reports no change.
 */
import { SAMPLE_RATE } from '../constants';
import { createDemuxer, type AudioCodecConfig, type Demuxer, type EncodedAudioFrame } from '../demux/index';
import type { HookMessage } from '../protocol';
import { FrameStore, type StoredFrame } from './frame-store';
import { PcmStore, type PcmRange } from './pcm-store';
import { PcmWriter, hasStereoDownmix, type DecodedAudio } from './pcm-writer';

/** The subset of WebCodecs' AudioDecoder used by the look-ahead worker. */
export interface AudioDecoderLike {
  /** Decodes one frame; `timestamp` is its media time in seconds (pts + timestampOffset). */
  decode(frame: EncodedAudioFrame, timestamp: number): void;
  /** Resolves once every output of the frames decoded so far has been delivered. */
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

/** Creates a configured decoder delivering outputs and errors through the callbacks. */
export type DecoderFactory = (
  config: AudioCodecConfig,
  onOutput: (audio: DecodedAudio) => void,
  onError: (message: string) => void,
) => AudioDecoderLike;

export interface IngestListener {
  /** PCM was stored for the timeline. */
  onData(timelineId: number): void;
  /**
   * Demuxing or decoding failed for the timeline. Decoding resumes with the next frames, unless
   * the decoder failed repeatedly (then it waits for the next initialization segment).
   */
  onError(timelineId: number, message: string): void;
  /** The timeline's audio cannot be used for look-ahead (a channel layout without stereo downmix). */
  onUnsupported(timelineId: number, reason: string): void;
  /** Stored PCM of [start, end) was removed by the page or replaced with audibly different audio. */
  onPcmChanged(timelineId: number, start: number, end: number): void;
  /** The last audio SourceBuffer of the timeline went away; its PCM has been dropped. */
  onTimelineGone(timelineId: number): void;
}

export interface IngestOptions {
  decoderFactory: DecoderFactory;
  listener: IngestListener;
  /** Size bound of each timeline's PcmStore, in samples per channel. */
  maxSamplesPerTimeline: number;
  /** Encoded audio kept per SourceBuffer for re-decoding, in bytes (default 24 MB). */
  maxEncodedBytes?: number;
  /** Clock in milliseconds (default performance.now). */
  now?: () => number;
}

/** Frames whose start deviates from the previous frame's end by more than this start a new run. */
const MIN_GAP_TOLERANCE_SECONDS = 0.002;
/** Fraction of the previous frame's duration tolerated as timestamp jitter. */
const GAP_TOLERANCE_FRACTION = 0.25;
const DEFAULT_MAX_ENCODED_BYTES = 24 * 1024 * 1024;
/** This many decoder errors within ERROR_WINDOW_MS stop decoding until the next initialization segment. */
const MAX_DECODER_ERRORS = 3;
const ERROR_WINDOW_MS = 10_000;
/** A decoder starting after stored frames (and a re-decode) first decodes this much audio before. */
const DECODER_PREROLL_SECONDS = 0.1;
/**
 * A decoder's output is taken as settled this long after its first sample (RFC 7845 recommends
 * 80 ms of Opus pre-roll; Chrome's decoder differs from a continuous decode for about 35 ms).
 */
const SETTLE_SAMPLES = Math.round(0.08 * SAMPLE_RATE);
/**
 * Frames decoded after the end of a gap. A new decoder holds back its last samples (the Opus codec
 * delay, 312 samples) until it gets the next frame, so decoding must run a little past the gap for
 * its end to be written. There the re-decode also replaces provisional samples (the unsettled
 * start of the run after the gap); it never replaces settled ones.
 */
const REDECODE_TAIL_SECONDS = 0.1;
/** A finished re-decode is not repeated for the same range within this time (it may stay undecodable). */
const REDECODE_RETRY_MS = 5000;
/** Re-decodes that stored nothing are repeated after doubling waits, up to this one. */
const REDECODE_MAX_BACKOFF_MS = 80_000;
/** Frames appended more recently than this may still be in the live decoder: they are not decoded again. */
const REDECODE_MIN_AGE_MS = 1000;

interface DecodeRun {
  readonly decoder: AudioDecoderLike;
  readonly writer: PcmWriter;
  /** Expected timestamp of the next frame (NaN: unknown, accept anything). */
  nextTime: number;
  tolerance: number;
  /**
   * Where the next frame's output lands (seconds): the writer makes a run's outputs contiguous, so
   * this is the run's first timestamp plus the durations so far (timestamps may jitter around it).
   */
  nextPosition: number;
  /** Set once the decoder failed or was closed: outputs are ignored. */
  dead: boolean;
}

/** A decoder run over retained frames that fills the missing PCM of `range`. */
interface Redecode {
  readonly range: PcmRange;
  readonly run: DecodeRun;
}

interface Track {
  readonly timelineId: number;
  mime: string;
  demuxer: Demuxer | null;
  config: AudioCodecConfig | null;
  run: DecodeRun | null;
  /**
   * Decoding stopped after repeated decoder errors, or for good for an unusable configuration,
   * until the next initialization segment.
   */
  failed: boolean;
  /** Times (ms) of the recent decoder errors. */
  errorTimes: number[];
  /** The last run failed: the next one starts without pre-roll (a corrupt frame there would fail it again). */
  runFailed: boolean;
  readonly frames: FrameStore;
  readonly redecodes: Set<Redecode>;
  /** Last finished re-decode: repeating it waits until `retryAt` (ms), see recentlyRedecoded(). */
  lastRedecode: { start: number; end: number; wrote: boolean; retryAt: number } | null;
  /** Wait after the next re-decode that stores nothing (doubles each time, reset by one that stores something). */
  redecodeBackoffMs: number;
}

interface Timeline {
  readonly store: PcmStore;
  readonly tracks: Set<Track>;
}

export class MseAudioIngest {
  private readonly decoderFactory: DecoderFactory;
  private readonly listener: IngestListener;
  private readonly maxSamples: number;
  private readonly maxEncodedBytes: number;
  private readonly now: () => number;
  private readonly tracks = new Map<string, Track>();
  private readonly timelines = new Map<number, Timeline>();
  private suspended = false;
  private disposed = false;

  constructor(opts: IngestOptions) {
    this.decoderFactory = opts.decoderFactory;
    this.listener = opts.listener;
    this.maxSamples = opts.maxSamplesPerTimeline;
    this.maxEncodedBytes = opts.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_BYTES;
    this.now = opts.now ?? (() => performance.now());
  }

  /** PCM of a timeline, if any audio SourceBuffer of it is known. */
  store(timelineId: number): PcmStore | undefined {
    return this.timelines.get(timelineId)?.store;
  }

  /** Ids of the timelines with at least one audio SourceBuffer. */
  timelineIds(): IterableIterator<number> {
    return this.timelines.keys();
  }

  /** Bytes of encoded audio retained for a timeline. */
  encodedBytes(timelineId: number): number {
    let total = 0;
    for (const track of this.timelines.get(timelineId)?.tracks ?? []) total += track.frames.bytes;
    return total;
  }

  /** Handles one hook message ('ms-url' and 'ms-worker' are ignored here). */
  handle(msg: HookMessage): void {
    if (this.disposed) return;
    switch (msg.type) {
      case 'sb-add':
        this.addTrack(msg.msId, msg.sbId, msg.mime);
        break;
      case 'sb-append': {
        const track = this.tracks.get(trackKey(msg.msId, msg.sbId));
        if (!track?.demuxer) break;
        // A failed append resets the SourceBuffer's parser and adds nothing.
        if (!msg.ok) {
          track.demuxer.reset();
          break;
        }
        this.ingestBytes(track, new Uint8Array(msg.data), msg.timestampOffset, msg.appendWindowStart, msg.appendWindowEnd);
        break;
      }
      case 'sb-abort':
        this.tracks.get(trackKey(msg.msId, msg.sbId))?.demuxer?.reset();
        break;
      case 'sb-change-type': {
        const track = this.tracks.get(trackKey(msg.msId, msg.sbId));
        if (track) this.changeType(track, msg.mime);
        break;
      }
      case 'sb-remove':
        this.removeRange(msg.msId, msg.start, msg.end);
        break;
      case 'sb-gone':
        this.removeTrack(msg.msId, msg.sbId);
        break;
      default:
        break;
    }
  }

  /**
   * Decodes the retained frames again where the PCM of [start, end) is missing (evicted).
   * Asynchronous: onData reports the PCM as it is stored. Parts being decoded already, decoded
   * within the last few seconds, or that the retained frames cannot fill are skipped.
   */
  redecode(timelineId: number, start: number, end: number): void {
    const timeline = this.timelines.get(timelineId);
    if (this.disposed || this.suspended || !timeline || !(end > start)) return;
    const now = this.now();
    for (const gap of missingRanges(timeline.store, start, end)) {
      for (const track of timeline.tracks) {
        if (track.failed || this.redecoding(timelineId, gap.start, gap.end) || recentlyRedecoded(track, gap, now)) continue;
        const frames = track.frames.overlapping(
          gap.start / SAMPLE_RATE - DECODER_PREROLL_SECONDS,
          gap.end / SAMPLE_RATE + REDECODE_TAIL_SECONDS,
        );
        // Frames the live decoder may still be decoding.
        if (frames.some((f) => now - f.addedAt < REDECODE_MIN_AGE_MS)) continue;
        for (const group of contiguousGroups(frames)) {
          // A decoder's output starts at its first frame and ends before the samples it holds back
          // (the codec delay) for want of a next frame: at the live edge, where the gap starts
          // there, nothing could be written (the live decoder writes it with the next append).
          const first = group[0]!;
          const last = group[group.length - 1]!;
          const writableEnd = Math.round((last.position + last.frame.duration) * SAMPLE_RATE) - holdBack(last);
          if (Math.min(gap.end, writableEnd) > Math.max(gap.start, Math.round(first.position * SAMPLE_RATE))) {
            this.startRedecode(track, timeline.store, gap, group);
          }
        }
      }
    }
  }

  /** True while a re-decode writing into [start, end) of the timeline is running. */
  redecoding(timelineId: number, start: number, end: number): boolean {
    for (const track of this.timelines.get(timelineId)?.tracks ?? []) {
      for (const r of track.redecodes) if (r.range.start < end && r.range.end > start) return true;
    }
    return false;
  }

  /**
   * Media time (seconds) of the timeline's playhead: the retained frames and the PCM farthest from
   * it go first when their bounds are reached.
   */
  setFocus(timelineId: number, time: number): void {
    const timeline = this.timelines.get(timelineId);
    if (!timeline) return;
    timeline.store.setFocus(Math.round(time * SAMPLE_RATE));
    for (const track of timeline.tracks) track.frames.setFocus(time);
  }

  /** Drops the PCM and the retained frames of a timeline (later appends are ingested as usual). */
  release(timelineId: number): void {
    const timeline = this.timelines.get(timelineId);
    if (!timeline) return;
    for (const track of timeline.tracks) {
      this.cancelRedecodes(track);
      track.frames.clear();
    }
    timeline.store.clear();
  }

  /** Stops decoding and drops all PCM and retained frames; appends are only parsed until resume(). */
  suspend(): void {
    if (this.suspended || this.disposed) return;
    this.suspended = true;
    for (const track of this.tracks.values()) {
      this.kill(track.run);
      track.run = null;
      this.cancelRedecodes(track);
      track.frames.clear();
    }
    for (const timeline of this.timelines.values()) timeline.store.clear();
  }

  /** Decodes the following appends again (see suspend()). */
  resume(): void {
    this.suspended = false;
  }

  /** Closes every decoder and drops all PCM. */
  dispose(): void {
    this.disposed = true;
    for (const track of this.tracks.values()) {
      this.kill(track.run);
      this.cancelRedecodes(track);
      track.frames.clear();
    }
    this.tracks.clear();
    for (const timeline of this.timelines.values()) timeline.store.clear();
    this.timelines.clear();
  }

  private addTrack(msId: number, sbId: number, mime: string): void {
    const key = trackKey(msId, sbId);
    const known = this.tracks.get(key);
    if (known) {
      // The hook announces its SourceBuffers again when it reconnects, then replays their init
      // segment and recent appends: keep what is stored and parse the replayed bytes afresh.
      if (mime === known.mime) known.demuxer?.reset();
      else this.changeType(known, mime);
      return;
    }
    const demuxer = createDemuxer(mime);
    if (!demuxer) return;
    let timeline = this.timelines.get(msId);
    if (!timeline) {
      timeline = { store: new PcmStore({ maxSamples: this.maxSamples }), tracks: new Set() };
      this.timelines.set(msId, timeline);
    }
    const track: Track = {
      timelineId: msId,
      mime,
      demuxer,
      config: null,
      run: null,
      failed: false,
      errorTimes: [],
      runFailed: false,
      frames: new FrameStore(this.maxEncodedBytes),
      redecodes: new Set(),
      lastRedecode: null,
      redecodeBackoffMs: REDECODE_RETRY_MS,
    };
    timeline.tracks.add(track);
    this.tracks.set(key, track);
  }

  private removeTrack(msId: number, sbId: number): void {
    const key = trackKey(msId, sbId);
    const track = this.tracks.get(key);
    if (!track) return;
    this.kill(track.run);
    track.run = null;
    this.cancelRedecodes(track);
    track.frames.clear();
    this.tracks.delete(key);
    const timeline = this.timelines.get(msId);
    if (!timeline) return;
    timeline.tracks.delete(track);
    if (timeline.tracks.size > 0) return;
    timeline.store.clear();
    this.timelines.delete(msId);
    this.listener.onTimelineGone(msId);
  }

  /** SourceBuffer.remove(): drops the frames and PCM of [startSeconds, endSeconds). */
  private removeRange(msId: number, startSeconds: number, endSeconds: number): void {
    const timeline = this.timelines.get(msId);
    if (!timeline) return;
    const start = Math.round(startSeconds * SAMPLE_RATE);
    const end = Math.round(endSeconds * SAMPLE_RATE);
    for (const track of timeline.tracks) {
      track.frames.remove(startSeconds, endSeconds);
      for (const r of track.redecodes) {
        if (r.range.start >= end || r.range.end <= start) continue;
        this.kill(r.run);
        track.redecodes.delete(r);
      }
    }
    const stored = (timeline.store.nextCovered(start) ?? end) < end;
    timeline.store.remove(start, end);
    if (stored) this.listener.onPcmChanged(msId, start, end);
  }

  private ingestBytes(track: Track, bytes: Uint8Array, timestampOffset: number, windowStart: number, windowEnd: number): void {
    for (const event of track.demuxer!.push(bytes)) {
      if (event.type === 'config') this.configure(track, event.config);
      else if (event.type === 'error') this.listener.onError(track.timelineId, event.message);
      else this.decode(track, event.frames, timestampOffset, windowStart, windowEnd);
    }
  }

  /** SourceBuffer.changeType(): the next appends are parsed for `mime`. */
  private changeType(track: Track, mime: string): void {
    this.retire(track);
    track.mime = mime;
    track.demuxer = createDemuxer(mime);
    track.config = null;
    track.failed = false;
    track.errorTimes = [];
  }

  private configure(track: Track, config: AudioCodecConfig): void {
    // A repeated initialization segment also lifts a decoding failure (retry).
    track.failed = false;
    track.errorTimes = [];
    if (track.config && sameConfig(track.config, config)) return;
    this.retire(track);
    if (!hasStereoDownmix(config.channels)) {
      track.config = null;
      this.unsupported(track, config.channels);
      return;
    }
    track.config = config;
  }

  private decode(track: Track, frames: EncodedAudioFrame[], timestampOffset: number, windowStart: number, windowEnd: number): void {
    if (this.suspended) return;
    const addedAt = this.now();
    for (const frame of frames) {
      const config = track.config;
      if (track.failed || !config) return;
      const time = frame.pts + timestampOffset;
      // Like MSE's coded frame processing: frames outside the append window are dropped.
      if (time + frame.duration <= windowStart || time >= windowEnd) continue;
      let run = track.run;
      if (run && Math.abs(time - run.nextTime) > run.tolerance) {
        this.retire(track);
        run = null;
      }
      if (!run) {
        const tolerance = Math.max(MIN_GAP_TOLERANCE_SECONDS, GAP_TOLERANCE_FRACTION * frame.duration);
        const before = track.frames.preceding(time, DECODER_PREROLL_SECONDS, tolerance, config);
        const previous = before[before.length - 1];
        // A frame appended again (overlapping re-append) is placed where it was stored before,
        // and one continuing stored frames right after them, so the same audio gives the same
        // PCM (container timestamps can jitter by a millisecond).
        const position = track.frames.at(time, tolerance)?.position ?? (previous ? previous.position + previous.frame.duration : time);
        const preroll = track.runFailed ? [] : before;
        track.runFailed = false;
        run = this.startRun(track, config, position, preroll);
      }
      const position = run?.nextPosition ?? time;
      // Re-decoding later uses the position of the frame's output.
      track.frames.add({ frame, time, position, config, addedAt });
      if (!run) continue;
      try {
        // Stamped with the contiguous position: the run's outputs follow each other exactly.
        run.decoder.decode(frame, position);
      } catch (e) {
        // The next frame starts a new decoder (unless the errors repeat).
        this.fail(track, run, errorMessage(e));
        continue;
      }
      run.nextTime = frame.duration > 0 ? time + frame.duration : NaN;
      run.nextPosition += Math.max(0, frame.duration);
      run.tolerance = Math.max(MIN_GAP_TOLERANCE_SECONDS, GAP_TOLERANCE_FRACTION * frame.duration);
    }
  }

  /**
   * Starts a decoder run whose next frame's output lands at `position` (seconds), after decoding
   * `preroll` (the stored frames leading up to it) where they were stored.
   */
  private startRun(track: Track, config: AudioCodecConfig, position: number, preroll: readonly StoredFrame[]): DecodeRun | null {
    const timeline = this.timelines.get(track.timelineId);
    if (!timeline) return null;
    const writer = new PcmWriter(timeline.store, {
      settledFrom: Math.round((preroll[0]?.position ?? position) * SAMPLE_RATE) + SETTLE_SAMPLES,
      replaceFrom: Math.round(position * SAMPLE_RATE),
      onChange: (start, end) => this.listener.onPcmChanged(track.timelineId, start, end),
    });
    let run: DecodeRun | null = null;
    const onOutput = (audio: DecodedAudio) => {
      if (run?.dead !== false || this.disposed) return;
      if (!writer.write(audio)) {
        this.kill(run);
        this.unsupported(track, audio.channels.length);
        return;
      }
      this.listener.onData(track.timelineId);
    };
    const onError = (message: string) => {
      if (!run || run.dead) return;
      // A retired run failing while it flushes does not affect the track's current run.
      if (track.run === run) this.fail(track, run, message);
      else this.kill(run);
    };
    try {
      const decoder = this.decoderFactory(config, onOutput, onError);
      run = { decoder, writer, nextTime: NaN, tolerance: 0, nextPosition: position, dead: false };
    } catch (e) {
      // The configuration cannot be decoded: no retry before the next initialization segment.
      track.failed = true;
      this.listener.onError(track.timelineId, `Audio decoder: ${errorMessage(e)}`);
      return null;
    }
    track.run = run;
    try {
      for (const f of preroll) run.decoder.decode(f.frame, f.position);
    } catch (e) {
      this.fail(track, run, errorMessage(e));
      return null;
    }
    return run;
  }

  /**
   * Starts a decoder over retained frames (contiguous, one configuration) for the missing PCM of
   * `range`. From the start of the range on, its output only completes missing samples, or
   * provisional ones once settled.
   */
  private startRedecode(track: Track, store: PcmStore, range: PcmRange, frames: StoredFrame[]): void {
    const writer = new PcmWriter(store, {
      clip: { start: range.start, end: Infinity },
      settledFrom: Math.round(frames[0]!.position * SAMPLE_RATE) + SETTLE_SAMPLES,
      replaceFrom: Infinity,
    });
    let redecode: Redecode | null = null;
    let wrote = false;
    /** Runs a write and reports onData when it stored new samples. */
    const tracked = (write: () => boolean): boolean => {
      const before = store.size;
      const ok = write();
      if (store.size > before) {
        wrote = true;
        this.listener.onData(track.timelineId);
      }
      return ok;
    };
    const end = () => {
      if (!redecode || !track.redecodes.delete(redecode)) return false;
      const wait = wrote ? REDECODE_RETRY_MS : track.redecodeBackoffMs;
      track.redecodeBackoffMs = wrote ? REDECODE_RETRY_MS : Math.min(REDECODE_MAX_BACKOFF_MS, 2 * track.redecodeBackoffMs);
      track.lastRedecode = { start: range.start, end: range.end, wrote, retryAt: this.now() + wait };
      this.kill(redecode.run);
      return true;
    };
    const onOutput = (audio: DecodedAudio) => {
      if (redecode?.run.dead !== false || this.disposed) return;
      if (!tracked(() => writer.write(audio))) {
        end();
        this.unsupported(track, audio.channels.length);
      }
    };
    const onError = (message: string) => {
      if (end()) this.noteError(track, message);
    };
    let decoder: AudioDecoderLike;
    try {
      decoder = this.decoderFactory(frames[0]!.config, onOutput, onError);
    } catch (e) {
      this.noteError(track, errorMessage(e));
      return;
    }
    redecode = { range, run: { decoder, writer, nextTime: NaN, tolerance: 0, nextPosition: NaN, dead: false } };
    track.redecodes.add(redecode);
    let flushed: Promise<void>;
    try {
      // Stamped where the live run put each frame's output, so the PCM lines up with what remains.
      for (const { frame, position } of frames) decoder.decode(frame, position);
      flushed = decoder.flush();
    } catch (e) {
      onError(errorMessage(e));
      return;
    }
    const run = redecode.run;
    flushed.then(
      () => {
        if (run.dead || this.disposed) return;
        tracked(() => {
          writer.finish();
          return true;
        });
        end();
      },
      () => end(),
    );
  }

  /** Ends the track's current run once its pending outputs have been delivered. */
  private retire(track: Track): void {
    const run = track.run;
    track.run = null;
    if (!run || run.dead) return;
    let flushed: Promise<void>;
    try {
      flushed = run.decoder.flush();
    } catch {
      this.kill(run);
      return;
    }
    flushed.then(
      () => {
        if (run.dead || this.disposed) return;
        run.writer.finish();
        this.kill(run);
        this.listener.onData(track.timelineId);
      },
      () => this.kill(run),
    );
  }

  /** A decoder error of the track's current run: the next frame starts a new run. */
  private fail(track: Track, run: DecodeRun, message: string): void {
    this.kill(run);
    if (track.run === run) track.run = null;
    track.runFailed = true;
    this.noteError(track, message);
  }

  /** Reports a decoder error; repeated errors stop decoding until the next initialization segment. */
  private noteError(track: Track, message: string): void {
    const now = this.now();
    track.errorTimes = track.errorTimes.filter((t) => now - t < ERROR_WINDOW_MS);
    track.errorTimes.push(now);
    if (track.errorTimes.length >= MAX_DECODER_ERRORS) {
      track.failed = true;
      this.cancelRedecodes(track);
    }
    this.listener.onError(track.timelineId, `Audio decoder: ${message}`);
  }

  /** The track's channel layout has no stereo downmix: look-ahead cannot use the timeline. */
  private unsupported(track: Track, channels: number): void {
    this.kill(track.run);
    track.run = null;
    track.failed = true;
    this.cancelRedecodes(track);
    track.frames.clear();
    this.listener.onUnsupported(track.timelineId, `Look-ahead does not support ${channels}-channel audio. Using real-time mode.`);
  }

  private cancelRedecodes(track: Track): void {
    for (const r of track.redecodes) this.kill(r.run);
    track.redecodes.clear();
  }

  private kill(run: DecodeRun | null): void {
    if (!run || run.dead) return;
    run.dead = true;
    try {
      run.decoder.close();
    } catch {
      // Already closed (WebCodecs closes a decoder itself after an error).
    }
  }
}

function trackKey(msId: number, sbId: number): string {
  return `${msId}/${sbId}`;
}

/**
 * True while a repeat of the track's last re-decode for `gap` must wait. One that stored
 * something is not repeated for the same range; one that stored nothing blocks every range it
 * overlaps, with growing waits.
 */
function recentlyRedecoded(track: Track, gap: PcmRange, now: number): boolean {
  const previous = track.lastRedecode;
  if (!previous || now >= previous.retryAt) return false;
  if (previous.wrote) return previous.start <= gap.start && previous.end >= gap.end;
  return previous.start < gap.end && previous.end > gap.start;
}

/** Samples (48 kHz) a decoder holds back at the end of its frames: the codec delay, else one frame. */
function holdBack(stored: StoredFrame): number {
  return stored.config.codecDelaySamples ?? Math.round(stored.frame.duration * SAMPLE_RATE);
}

/** Sub-ranges of [start, end) without stored PCM. */
function missingRanges(store: PcmStore, start: number, end: number): PcmRange[] {
  const out: PcmRange[] = [];
  for (let pos = start; pos < end; ) {
    const covered = store.contiguousEnd(pos);
    if (covered > pos) {
      pos = covered;
      continue;
    }
    const next = Math.min(store.nextCovered(pos) ?? end, end);
    out.push({ start: pos, end: next });
    pos = next;
  }
  return out;
}

/** Splits time-ordered frames where the timestamps jump or the configuration changes (one decoder each). */
function contiguousGroups(frames: StoredFrame[]): StoredFrame[][] {
  const groups: StoredFrame[][] = [];
  let group: StoredFrame[] = [];
  let next = NaN;
  let tolerance = 0;
  for (const stored of frames) {
    const previous = group[group.length - 1];
    if (previous && (stored.config !== previous.config || Math.abs(stored.time - next) > tolerance)) {
      groups.push(group);
      group = [];
    }
    group.push(stored);
    const { duration } = stored.frame;
    next = duration > 0 ? stored.time + duration : NaN;
    tolerance = Math.max(MIN_GAP_TOLERANCE_SECONDS, GAP_TOLERANCE_FRACTION * duration);
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

function sameConfig(a: AudioCodecConfig, b: AudioCodecConfig): boolean {
  if (a.codec !== b.codec || a.sampleRate !== b.sampleRate || a.channels !== b.channels) return false;
  if (a.codecDelaySamples !== b.codecDelaySamples) return false;
  const da = a.description;
  const db = b.description;
  if (!da || !db) return da === db;
  if (da.length !== db.length) return false;
  for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) return false;
  return true;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
