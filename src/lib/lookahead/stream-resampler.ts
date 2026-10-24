/**
 * Block-wise resampling of a continuous stereo stream with exact seams: the concatenated output
 * of consecutive push() calls equals a single resampleRange() pass over the whole run. A short
 * history of input samples (the filter margin) is kept between blocks.
 */
import { resampleInputRange, resampleOutputEnd, resampleRange } from '../dsp/resample';

/**
 * Receives output samples [start, start + left.length). The arrays are scratch views that are
 * only valid during the call.
 */
export type ResampledSink = (start: number, left: Float32Array, right: Float32Array) => void;

/** ceil(a / b) for integers a and b > 0, exact for |a| < 2^53. */
function ceilDiv(a: number, b: number): number {
  let q = Math.ceil(a / b);
  const r = a - q * b;
  if (r > 0) q++;
  else if (r <= -b) q--;
  return q;
}

export class StreamResampler {
  readonly fromRate: number;
  readonly toRate: number;
  /** Input samples [histStart, histStart + histLength) still needed for future output. */
  private histL = new Float32Array(0);
  private histR = new Float32Array(0);
  private histStart = 0;
  private histLength = 0;
  /** Output index up to which samples have been emitted. */
  private outEnd = 0;
  private active = false;
  private outL = new Float32Array(0);
  private outR = new Float32Array(0);

  constructor(fromRate: number, toRate: number) {
    this.fromRate = fromRate;
    this.toRate = toRate;
  }

  /** Input index that continues the current run, or null when no run is active. */
  get nextInput(): number | null {
    return this.active ? this.histStart + this.histLength : null;
  }

  /**
   * Feeds input samples starting at input index `start` and emits every output sample that has
   * become computable. A block that does not continue the current run first finishes it.
   */
  push(start: number, left: Float32Array, right: Float32Array, sink: ResampledSink): void {
    const n = left.length;
    if (right.length !== n) throw new RangeError('StreamResampler.push: channels differ in length');
    if (n === 0) return;
    if (this.active && start !== this.histStart + this.histLength) this.finish(sink);
    if (!this.active) {
      this.active = true;
      this.histStart = start;
      this.histLength = 0;
      // First output sample at or after the time of the first input sample.
      this.outEnd = ceilDiv(start * this.toRate, this.fromRate);
    }
    this.append(left, right);
    this.emit(resampleOutputEnd(this.fromRate, this.toRate, this.histStart + this.histLength), sink);
    const keepFrom = resampleInputRange(this.fromRate, this.toRate, this.outEnd, 1).start;
    const drop = Math.min(this.histLength, Math.max(0, keepFrom - this.histStart));
    if (drop > 0) {
      this.histL.copyWithin(0, drop, this.histLength);
      this.histR.copyWithin(0, drop, this.histLength);
      this.histStart += drop;
      this.histLength -= drop;
    }
  }

  /**
   * Emits the rest of the current run (output samples whose time precedes the end of the input),
   * treating the input after it as silence, and ends the run.
   */
  finish(sink: ResampledSink): void {
    if (!this.active) return;
    // Output samples j with j / toRate < inputEnd / fromRate.
    this.emit(ceilDiv((this.histStart + this.histLength) * this.toRate, this.fromRate), sink);
    this.active = false;
    this.histLength = 0;
  }

  private append(left: Float32Array, right: Float32Array): void {
    const needed = this.histLength + left.length;
    if (needed > this.histL.length) {
      const capacity = Math.max(needed, 2 * this.histL.length);
      const l = new Float32Array(capacity);
      const r = new Float32Array(capacity);
      l.set(this.histL.subarray(0, this.histLength));
      r.set(this.histR.subarray(0, this.histLength));
      this.histL = l;
      this.histR = r;
    }
    this.histL.set(left, this.histLength);
    this.histR.set(right, this.histLength);
    this.histLength = needed;
  }

  /** Computes and emits output samples [outEnd, end). */
  private emit(end: number, sink: ResampledSink): void {
    const length = end - this.outEnd;
    if (length <= 0) return;
    if (this.outL.length < length) {
      this.outL = new Float32Array(Math.max(length, 2 * this.outL.length));
      this.outR = new Float32Array(this.outL.length);
    }
    const inL = this.histL.subarray(0, this.histLength);
    const inR = this.histR.subarray(0, this.histLength);
    resampleRange(inL, this.histStart, this.fromRate, this.toRate, this.outEnd, length, this.outL);
    resampleRange(inR, this.histStart, this.fromRate, this.toRate, this.outEnd, length, this.outR);
    sink(this.outEnd, this.outL.subarray(0, length), this.outR.subarray(0, length));
    this.outEnd = end;
  }
}
