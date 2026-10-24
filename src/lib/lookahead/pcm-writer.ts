/**
 * Writes the output of one audio decoder into a 48 kHz PcmStore. A decoder's output is one
 * continuous signal (the browser plays it back to back), so an output starting within
 * SNAP_SECONDS of the end of the previous one continues it exactly; this absorbs container
 * timestamp rounding (WebM stores milliseconds, WebCodecs microseconds) and priming trims.
 * Other rates are resampled with a StreamResampler so block seams are exact.
 *
 * Multichannel output is downmixed to stereo like Web Audio's 'speakers' channel interpretation,
 * so the stored mix is what the worklet receives from the media element.
 *
 * A decoder's first output has not settled yet (Opus needs about 80 ms of pre-roll): it differs
 * from what a continuous decode gives there. Output of frames decoded before (pre-roll) only
 * completes missing samples (provisional ones while unsettled). Unsettled output of new frames is
 * held until 10 ms of settled output tell whether the audio differs from what is stored: then it
 * is new audio and written like the rest, otherwise it only fills missing samples. So a decoder
 * never overwrites settled audio with its own start, and identical audio appended again is not
 * reported as a change.
 */
import { SAMPLE_RATE } from '../constants';
import type { PcmRange, PcmStore } from './pcm-store';
import { StreamResampler } from './stream-resampler';

/** One decoder output. */
export interface DecodedAudio {
  /** Seconds on the media timeline (container pts + SourceBuffer.timestampOffset). */
  timestamp: number;
  sampleRate: number;
  /** Planar samples in Chrome's decoder order: L, R, C, LFE, SL, SR (see stereoDownmix). */
  channels: Float32Array[];
}

export interface PcmWriterOptions {
  /** Only media indices inside this range are written (default: everything). */
  clip?: PcmRange;
  /** Called after a write replaced stored samples with audibly different audio. */
  onChange?: (start: number, end: number) => void;
  /**
   * Output before this media index has not settled (the decoder's start). It is stored as
   * provisional samples, and only where nothing is stored unless the settled output after it
   * differs from the stored audio (default: −Infinity, all output is settled).
   */
  settledFrom?: number;
  /**
   * Output before this media index is pre-roll (frames whose audio was stored before): it only
   * completes missing samples, or provisional ones once settled. From it on, writes replace
   * stored audio and report audible changes (default: −Infinity).
   */
  replaceFrom?: number;
}

/** Outputs starting this close (in seconds) to the end of the previous one continue it exactly. */
const SNAP_SECONDS = 0.01;
/** Settled samples compared with the stored audio to decide about the unsettled output before them. */
const DECIDE_SAMPLES = 480;
/** −3 dB: weight of the centre and surround channels in Web Audio's stereo downmix. */
const SQRT_HALF = Math.SQRT1_2;

/** Channel counts with a Web Audio 'speakers' downmix to stereo: mono, stereo, quad and 5.1. */
export function hasStereoDownmix(channels: number): boolean {
  return channels === 1 || channels === 2 || channels === 4 || channels === 6;
}

/**
 * Stereo version of planar channels with Web Audio's 'speakers' matrices: mono L = R = M;
 * quad (L, R, SL, SR) L = ½(L + SL), R = ½(R + SR); 5.1 (L, R, C, LFE, SL, SR)
 * L = L + √½(C + SL), R = R + √½(C + SR), LFE dropped. Mono and stereo return the inputs; the
 * other layouts are written into `scratch` (grown as needed). Null for other layouts. All
 * channels must have the same length.
 */
export function stereoDownmix(
  channels: readonly Float32Array[],
  scratch: { left: Float32Array; right: Float32Array },
): [Float32Array, Float32Array] | null {
  if (!hasStereoDownmix(channels.length)) return null;
  const n = channels[0]!.length;
  if (channels.length <= 2) return [channels[0]!, channels[channels.length - 1]!];
  if (scratch.left.length < n) {
    scratch.left = new Float32Array(n);
    scratch.right = new Float32Array(n);
  }
  const left = scratch.left.subarray(0, n);
  const right = scratch.right.subarray(0, n);
  if (channels.length === 4) {
    const [l, r, sl, sr] = channels as [Float32Array, Float32Array, Float32Array, Float32Array];
    for (let i = 0; i < n; i++) {
      left[i] = 0.5 * (l[i]! + sl[i]!);
      right[i] = 0.5 * (r[i]! + sr[i]!);
    }
  } else {
    const [l, r, c, , sl, sr] = channels as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
    for (let i = 0; i < n; i++) {
      left[i] = l[i]! + SQRT_HALF * (c[i]! + sl[i]!);
      right[i] = r[i]! + SQRT_HALF * (c[i]! + sr[i]!);
    }
  }
  return [left, right];
}

export class PcmWriter {
  private readonly store: PcmStore;
  private readonly clip: PcmRange | null;
  private readonly onChange: ((start: number, end: number) => void) | null;
  private readonly settledFrom: number;
  private readonly replaceFrom: number;
  /**
   * New output from the unsettled start on, held until DECIDE_SAMPLES settled samples follow it
   * (null: nothing held). `decided` is set once that has happened, or was never needed.
   */
  private held: { start: number; left: Float32Array[]; right: Float32Array[]; length: number } | null = null;
  private decided: boolean;
  /** Next 48 kHz index of a contiguous 48 kHz output (null: none yet). */
  private next48: number | null = null;
  private resampler: StreamResampler | null = null;
  private readonly scratch = { left: new Float32Array(0), right: new Float32Array(0) };
  private readonly sink = (start: number, left: Float32Array, right: Float32Array) => this.put(start, left, right);

  constructor(store: PcmStore, opts: PcmWriterOptions = {}) {
    this.store = store;
    this.clip = opts.clip ?? null;
    this.onChange = opts.onChange ?? null;
    this.settledFrom = opts.settledFrom ?? -Infinity;
    this.replaceFrom = opts.replaceFrom ?? -Infinity;
    this.decided = this.replaceFrom >= this.settledFrom;
  }

  /**
   * Stores one decoder output. Returns false (and stores nothing) when its channel layout has no
   * stereo downmix (see hasStereoDownmix).
   */
  write(audio: DecodedAudio): boolean {
    const n = audio.channels[0]?.length ?? 0;
    // Malformed outputs (no samples, channels of different lengths) are skipped.
    if (n === 0 || !Number.isFinite(audio.timestamp) || audio.channels.some((c) => c.length !== n)) return true;
    const stereo = stereoDownmix(audio.channels, this.scratch);
    if (!stereo) return false;
    const [left, right] = stereo;
    const rate = audio.sampleRate;
    if (rate === SAMPLE_RATE) {
      this.finishResampler();
      const start = snap(Math.round(audio.timestamp * SAMPLE_RATE), this.next48, SAMPLE_RATE);
      this.put(start, left, right);
      this.next48 = start + left.length;
      return true;
    }
    if (!(rate > 0) || !Number.isInteger(rate)) return true;
    this.next48 = null;
    if (this.resampler?.fromRate !== rate) {
      this.finishResampler();
      this.resampler = new StreamResampler(rate, SAMPLE_RATE);
    }
    const start = snap(Math.round(audio.timestamp * rate), this.resampler.nextInput, rate);
    this.resampler.push(start, left, right, this.sink);
    return true;
  }

  /** Writes the pending resampler tail and the held output (call once no further contiguous output will arrive). */
  finish(): void {
    this.finishResampler();
    this.release();
    this.next48 = null;
  }

  private finishResampler(): void {
    this.resampler?.finish(this.sink);
  }

  /** Writes 48 kHz samples at `start`, limited to the clip range (see the file comment). */
  private put(start: number, left: Float32Array, right: Float32Array): void {
    let from = start;
    let to = start + left.length;
    if (this.clip) {
      from = Math.max(from, this.clip.start);
      to = Math.min(to, this.clip.end);
      if (to <= from) return;
    }
    const part = (a: number, b: number): [Float32Array, Float32Array] => [left.subarray(a - start, b - start), right.subarray(a - start, b - start)];
    // Pre-roll: completes what is missing.
    const prerollEnd = Math.min(to, Math.max(from, this.replaceFrom));
    const settled = Math.min(prerollEnd, Math.max(from, this.settledFrom));
    if (settled > from) this.store.fill(from, ...part(from, settled), true);
    if (prerollEnd > settled) this.store.fill(settled, ...part(settled, prerollEnd), false);
    if (to <= prerollEnd) return;
    // New output (the held part must stay contiguous).
    if (this.held && this.held.start + this.held.length !== prerollEnd) this.release();
    if (this.decided) {
      this.replace(prerollEnd, ...part(prerollEnd, to));
      return;
    }
    const [l, r] = part(prerollEnd, to);
    this.held ??= { start: prerollEnd, left: [], right: [], length: 0 };
    this.held.left.push(l.slice());
    this.held.right.push(r.slice());
    this.held.length += l.length;
    if (this.held.start + this.held.length >= this.settledFrom + DECIDE_SAMPLES) this.release();
  }

  /**
   * Stores the held output: all of it like settled output when its settled part differs from the
   * stored audio (it is new audio), otherwise the unsettled part only where nothing is stored.
   */
  private release(): void {
    const held = this.held;
    this.held = null;
    this.decided = true;
    if (!held) return;
    const left = concat(held.left, held.length);
    const right = concat(held.right, held.length);
    const split = Math.min(held.length, Math.max(0, this.settledFrom - held.start));
    const settledL = left.subarray(split);
    const settledR = right.subarray(split);
    if (settledL.length > 0 && this.store.differs(held.start + split, settledL, settledR)) {
      this.replace(held.start, left, right);
      return;
    }
    this.store.fill(held.start, left.subarray(0, split), right.subarray(0, split), true);
    this.replace(held.start + split, settledL, settledR);
  }

  /** Writes over the stored samples and reports an audible change. */
  private replace(start: number, left: Float32Array, right: Float32Array): void {
    if (left.length === 0) return;
    const changed = this.onChange !== null && this.store.differs(start, left, right);
    this.store.write(start, left, right);
    if (changed) this.onChange!(start, start + left.length);
  }
}

function concat(parts: readonly Float32Array[], length: number): Float32Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Float32Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function snap(index: number, expected: number | null, rate: number): number {
  return expected !== null && Math.abs(index - expected) <= SNAP_SECONDS * rate ? expected : index;
}
