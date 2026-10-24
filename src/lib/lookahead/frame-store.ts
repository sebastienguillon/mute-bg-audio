/**
 * Encoded audio frames of one SourceBuffer, kept so that decoded PCM evicted from the PcmStore
 * can be decoded again (a seek backwards, or a replay, within what the page still buffers: the
 * page does not append those frames again). Sorted by media time and non-overlapping: a frame
 * replaces the stored frames it overlaps, like MSE's coded frame processing. Bounded in bytes;
 * the frames farthest from the focus (the playhead) go first.
 */
import type { AudioCodecConfig, EncodedAudioFrame } from '../demux/index';

/** One retained frame. */
export interface StoredFrame {
  readonly frame: EncodedAudioFrame;
  /** Media time in seconds (pts + timestampOffset). */
  readonly time: number;
  /** Where the frame's decoded output was stored (seconds): `time` without timestamp jitter. */
  readonly position: number;
  readonly config: AudioCodecConfig;
  /** When the frame was appended (ms, the ingest's clock). */
  readonly addedAt: number;
}

/** Bookkeeping cost charged per frame on top of its bytes (object and ArrayBuffer headers). */
const FRAME_OVERHEAD_BYTES = 128;
/** Frames whose ranges overlap by less than this (timestamp rounding) do not replace each other. */
const OVERLAP_TOLERANCE_SECONDS = 0.002;

export class FrameStore {
  private readonly maxBytes: number;
  private frames: StoredFrame[] = [];
  private totalBytes = 0;
  /** See setFocus() (NaN: unknown, the earliest frames go first). */
  private focusTime = NaN;
  /**
   * Frames starting at or after `rejectFrom` (or ending at or before `rejectTo`) are not stored:
   * the bound evicted frames there, so later ones would leave holes. Reset when the focus moves.
   */
  private rejectFrom = Infinity;
  private rejectTo = -Infinity;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  /** Bytes charged for the stored frames. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Sets the media time (seconds) around which frames are kept when the bound is reached. */
  setFocus(time: number): void {
    this.focusTime = time;
    this.rejectFrom = Infinity;
    this.rejectTo = -Infinity;
  }

  /** Stores a frame, replacing the frames it overlaps; then enforces the size bound. */
  add(stored: StoredFrame): void {
    const { time } = stored;
    const end = time + stored.frame.duration;
    if (time >= this.rejectFrom || end <= this.rejectTo) return;
    const frames = this.frames;
    const first = this.firstEndingAfter(time + OVERLAP_TOLERANCE_SECONDS);
    let last = first;
    while (last < frames.length && frames[last]!.time < end - OVERLAP_TOLERANCE_SECONDS) last++;
    // A frame without duration replaces a frame starting at the same time.
    if (last === first && first < frames.length && Math.abs(frames[first]!.time - time) < OVERLAP_TOLERANCE_SECONDS) last++;
    for (let k = first; k < last; k++) this.totalBytes -= cost(frames[k]!);
    if (last === frames.length && first === last) frames.push(stored);
    else frames.splice(first, last - first, stored);
    this.totalBytes += cost(stored);
    if (this.totalBytes > this.maxBytes) this.enforceBound();
  }

  /** Drops the frames starting in [start, end) (seconds; bounds may be infinite), like SourceBuffer.remove(). */
  remove(start: number, end: number): void {
    if (!(end > start)) return;
    const frames = this.frames;
    let first = this.firstEndingAfter(start);
    if (first < frames.length && frames[first]!.time < start) first++;
    let last = first;
    while (last < frames.length && frames[last]!.time < end) last++;
    if (last === first) return;
    for (let k = first; k < last; k++) this.totalBytes -= cost(frames[k]!);
    frames.splice(first, last - first);
  }

  /** The stored frame starting within `tolerance` seconds of `time`, if any. */
  at(time: number, tolerance: number): StoredFrame | undefined {
    const frames = this.frames;
    for (let k = this.firstEndingAfter(time - tolerance); k < frames.length && frames[k]!.time <= time + tolerance; k++) {
      if (Math.abs(frames[k]!.time - time) <= tolerance) return frames[k];
    }
    return undefined;
  }

  /**
   * The stored frames of `config` that lead up to `time` (seconds) without a gap (timestamps
   * within `tolerance`), at most the last `seconds` of them, in time order: the pre-roll of a
   * decoder that starts at `time`.
   */
  preceding(time: number, seconds: number, tolerance: number, config: AudioCodecConfig): StoredFrame[] {
    const frames = this.frames;
    const out: StoredFrame[] = [];
    let start = time;
    for (let k = this.firstEndingAfter(time + tolerance) - 1; k >= 0 && time - start < seconds; k--) {
      const f = frames[k]!;
      // A (short) frame starting at `time` itself is the one appended again, not pre-roll.
      if (f.time >= time - tolerance) continue;
      if (f.config !== config || !(f.frame.duration > 0) || Math.abs(f.time + f.frame.duration - start) > tolerance) break;
      out.push(f);
      start = f.time;
    }
    return out.reverse();
  }

  /** The frames overlapping [start, end) (seconds), in time order. */
  overlapping(start: number, end: number): StoredFrame[] {
    const frames = this.frames;
    const out: StoredFrame[] = [];
    for (let k = this.firstEndingAfter(start); k < frames.length && frames[k]!.time < end; k++) out.push(frames[k]!);
    return out;
  }

  clear(): void {
    this.frames = [];
    this.totalBytes = 0;
    this.rejectFrom = Infinity;
    this.rejectTo = -Infinity;
  }

  /** Index of the first frame ending after `time` (frames.length when none). */
  private firstEndingAfter(time: number): number {
    const frames = this.frames;
    let lo = 0;
    let hi = frames.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const f = frames[mid]!;
      if (f.time + Math.max(f.frame.duration, 0) > time) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  /** Drops frames from the end farther from the focus (the earliest when unknown) until the bound holds. */
  private enforceBound(): void {
    const frames = this.frames;
    let lo = 0;
    let hi = frames.length;
    const focus = this.focusTime;
    while (this.totalBytes > this.maxBytes && hi - lo > 1) {
      const head = frames[lo]!;
      const tail = frames[hi - 1]!;
      if (Number.isNaN(focus) || focus - head.time >= tail.time - focus) {
        this.totalBytes -= cost(head);
        this.rejectTo = Math.max(this.rejectTo, head.time + Math.max(head.frame.duration, 0));
        lo++;
      } else {
        this.totalBytes -= cost(tail);
        this.rejectFrom = Math.min(this.rejectFrom, tail.time);
        hi--;
      }
    }
    if (hi < frames.length) frames.length = hi;
    if (lo > 0) frames.splice(0, lo);
  }
}

function cost(stored: StoredFrame): number {
  return stored.frame.data.byteLength + FRAME_OVERHEAD_BYTES;
}
