/**
 * Streaming separator for the chunked spectrogram models (MDX-Net, SCNet): python-audio-separator's
 * demix() or demucs' apply_model() run incrementally, with input-rate (48 kHz) audio in and out.
 *
 * Chunk k covers model-rate samples [k·step − trim, k·step − trim + chunkSize) of a grid anchored
 * at the origin, where step = int((1 − overlap) · chunkSize). Each chunk's vocals are weighted by
 * np.hanning(chunkSize) (demix) or apply_model()'s triangle and overlap-added with a divider
 * (Σ weights), so a sample is final once every chunk containing it has run: after chunk k, all
 * model-rate samples j < (k + 1)·step − trim. Final samples are resampled back to the input
 * rate; enough of their tail is kept so that block seams are exact.
 *
 * Unlike demix(), chunks can be peak-normalised before the model (UVR-style, MDX-Net), and the
 * context before the origin is real audio instead of zeros. Returned vocals are the raw model
 * estimate: the residual is mix − compensate · vocals (see LookaheadModel.compensate).
 */
import { SAMPLE_RATE } from '../constants';
import { resampleInputRange, resampleMargin, resampleOutputEnd, resampleRange } from '../dsp/resample';
import type { ChunkCodec, MdxBackend } from './mdx';

/** Chunks whose peak is below this (−80 dBFS) skip the model and yield silent vocals. */
const SILENCE_PEAK = 1e-4;

/** Overlap-add weights: np.hanning (demix()) or demucs apply_model()'s triangle. */
export type OlaWeights = 'hann' | 'triangle';

export interface MdxStreamOptions {
  /** Model sample rate in Hz: the rate of the codec's chunks. */
  modelRate: number;
  /**
   * Model-rate samples of context before the origin, where the first chunk starts (nFft / 2: the
   * samples within half an STFT window of a chunk edge are the least accurate).
   */
  trim: number;
  /** Fraction of a chunk shared with the next one, in (0, 1) (default 0.25). */
  overlap?: number;
  /** Weights of the overlap-add (default 'hann'). */
  weights?: OlaWeights;
  /** Each chunk is scaled to peak 1 before the model and its vocals scaled back (default true). */
  peakNormalize?: boolean;
  /** Sample rate of the input and output audio (default SAMPLE_RATE, 48 kHz). */
  inputRate?: number;
}

/** Newly finalized vocals for input-rate indices [start, start + vocalsL.length). */
export interface MdxStreamBlock {
  start: number;
  vocalsL: Float32Array;
  vocalsR: Float32Array;
}

export class MdxStream {
  private readonly codec: ChunkCodec;
  private readonly backend: MdxBackend;
  private readonly inputRate: number;
  private readonly modelRate: number;
  private readonly chunkSize: number;
  private readonly step: number;
  private readonly trim: number;
  private readonly peakNormalize: boolean;
  private readonly window: Float64Array;
  /** Model-rate input of the current chunk. */
  private readonly chunkL: Float32Array;
  private readonly chunkR: Float32Array;
  /** Weighted sums and divider for model-rate samples [chunkStart, chunkStart + chunkSize). */
  private readonly accL: Float64Array;
  private readonly accR: Float64Array;
  private readonly accW: Float64Array;
  /** Final model-rate vocals [vocStart, vocStart + vocLength) still needed for resampling. */
  private readonly vocL: Float32Array;
  private readonly vocR: Float32Array;
  private vocStart = 0;
  private vocLength = 0;
  private origin = 0;
  private chunkIndex = 0;
  /** Input-rate index (relative to origin) up to which vocals have been returned. */
  private outEnd = 0;
  /** Incremented by reset() so that a chunk in flight during a reset is discarded. */
  private generation = 0;
  private busy = false;
  private ranModel = false;

  constructor(codec: ChunkCodec, backend: MdxBackend, opts: MdxStreamOptions) {
    const overlap = opts.overlap ?? 0.25;
    if (!(overlap > 0 && overlap < 1)) throw new RangeError(`overlap must be in (0, 1), got ${overlap}`);
    this.codec = codec;
    this.backend = backend;
    this.inputRate = opts.inputRate ?? SAMPLE_RATE;
    this.modelRate = opts.modelRate;
    this.chunkSize = codec.chunkSize;
    this.step = Math.floor((1 - overlap) * this.chunkSize);
    this.trim = opts.trim;
    this.peakNormalize = opts.peakNormalize ?? true;
    const outMargin = resampleMargin(this.modelRate, this.inputRate);
    if (outMargin >= this.trim || this.step < 1) throw new RangeError('chunk geometry too small for the resampler');
    this.window = olaWeights(opts.weights ?? 'hann', this.chunkSize);
    const n = this.chunkSize;
    this.chunkL = new Float32Array(n);
    this.chunkR = new Float32Array(n);
    this.accL = new Float64Array(n);
    this.accR = new Float64Array(n);
    this.accW = new Float64Array(n);
    // After each chunk at most 2·outMargin + 1 old samples remain, then `step` are appended.
    this.vocL = new Float32Array(this.step + 2 * outMargin + 2);
    this.vocR = new Float32Array(this.step + 2 * outMargin + 2);
    this.reset(0);
  }

  /** Input-rate index (absolute) up to which vocals have been returned. */
  get finalizedEnd(): number {
    return this.origin + this.outEnd;
  }

  /** Seconds of audio each chunk finalizes after the first (one step of the chunk grid). */
  get stepSeconds(): number {
    return this.step / this.modelRate;
  }

  /** True when the last processNext() ran the model (false: a silent chunk, which skips it). */
  get lastRanModel(): boolean {
    return this.ranModel;
  }

  /**
   * Starts a new chunk grid. origin48 (input-rate media index) is the first sample that will be
   * finalized; audio before it only serves as context.
   */
  reset(origin48: number): void {
    if (!Number.isInteger(origin48)) throw new RangeError(`origin must be an integer, got ${origin48}`);
    this.origin = origin48;
    this.chunkIndex = 0;
    this.outEnd = 0;
    this.accL.fill(0);
    this.accR.fill(0);
    this.accW.fill(0);
    this.vocStart = resampleInputRange(this.modelRate, this.inputRate, 0, 1).start;
    this.vocLength = 0;
    this.generation++;
  }

  /**
   * Input-rate index range [start, end) of the mix needed for the next chunk, including the
   * resampler margins and the trim context before the origin.
   */
  nextInputRange(): { start: number; end: number } {
    const { start, end } = resampleInputRange(this.inputRate, this.modelRate, this.chunkStart(), this.chunkSize);
    return { start: this.origin + start, end: this.origin + end };
  }

  /**
   * Separates the next chunk. inputL/inputR must cover exactly nextInputRange() (callers fill
   * unavailable samples with zeros). Resolves to the newly finalized vocals, contiguous with the
   * previous result, or null when nothing new is final (or reset() was called meanwhile).
   * Calls must not overlap.
   */
  async processNext(inputL: Float32Array, inputR: Float32Array): Promise<MdxStreamBlock | null> {
    if (this.busy) throw new Error('MdxStream.processNext() is already running');
    const range = this.nextInputRange();
    const length = range.end - range.start;
    if (inputL.length !== length || inputR.length !== length) {
      throw new RangeError(`MdxStream input must cover [${range.start}, ${range.end}) (${length} samples)`);
    }
    const { chunkL, chunkR, chunkSize, inputRate, modelRate } = this;
    const chunkStart = this.chunkStart();
    const localStart = range.start - this.origin;
    resampleRange(inputL, localStart, inputRate, modelRate, chunkStart, chunkSize, chunkL);
    resampleRange(inputR, localStart, inputRate, modelRate, chunkStart, chunkSize, chunkR);
    let peak = 0;
    for (let i = 0; i < chunkSize; i++) peak = Math.max(peak, Math.abs(chunkL[i]!), Math.abs(chunkR[i]!));

    let vocals: [Float32Array, Float32Array] | null = null;
    this.ranModel = peak >= SILENCE_PEAK;
    const gain = this.peakNormalize ? peak : 1;
    if (this.ranModel) {
      if (this.peakNormalize) {
        const scale = 1 / peak;
        for (let i = 0; i < chunkSize; i++) {
          chunkL[i] = chunkL[i]! * scale;
          chunkR[i] = chunkR[i]! * scale;
        }
      }
      const generation = this.generation;
      this.busy = true;
      try {
        vocals = this.codec.decode(await this.backend.run(this.codec.encode(chunkL, chunkR)));
      } finally {
        this.busy = false;
      }
      if (generation !== this.generation) return null;
    }
    this.accumulate(vocals, gain);
    this.chunkIndex++;
    return this.emit();
  }

  /** First model-rate sample (relative to the origin) of the next chunk. */
  private chunkStart(): number {
    return this.chunkIndex * this.step - this.trim;
  }

  /** Overlap-adds the chunk's vocals (· gain), moves the final samples to the vocal buffer and shifts by step. */
  private accumulate(vocals: [Float32Array, Float32Array] | null, gain: number): void {
    const { accL, accR, accW, window, chunkSize, step, vocL, vocR } = this;
    if (vocals) {
      const [vl, vr] = vocals;
      for (let i = 0; i < chunkSize; i++) {
        const w = window[i]! * gain;
        accL[i] = accL[i]! + w * vl[i]!;
        accR[i] = accR[i]! + w * vr[i]!;
      }
    }
    for (let i = 0; i < chunkSize; i++) accW[i] = accW[i]! + window[i]!;
    const chunkStart = this.chunkStart();
    const finalEnd = chunkStart + step;
    let j = this.vocStart + this.vocLength;
    if (finalEnd - j > vocL.length - this.vocLength) throw new Error('MdxStream vocal buffer overflow');
    for (; j < finalEnd; j++) {
      const i = j - chunkStart;
      const inv = 1 / accW[i]!;
      vocL[this.vocLength] = accL[i]! * inv;
      vocR[this.vocLength] = accR[i]! * inv;
      this.vocLength++;
    }
    accL.copyWithin(0, step);
    accR.copyWithin(0, step);
    accW.copyWithin(0, step);
    accL.fill(0, chunkSize - step);
    accR.fill(0, chunkSize - step);
    accW.fill(0, chunkSize - step);
  }

  /** Resamples the newly computable vocals to the input rate and drops what is no longer needed. */
  private emit(): MdxStreamBlock | null {
    const { modelRate, inputRate } = this;
    const end = resampleOutputEnd(modelRate, inputRate, this.vocStart + this.vocLength);
    if (end <= this.outEnd) return null;
    const length = end - this.outEnd;
    const sourceL = this.vocL.subarray(0, this.vocLength);
    const sourceR = this.vocR.subarray(0, this.vocLength);
    const block: MdxStreamBlock = {
      start: this.origin + this.outEnd,
      vocalsL: resampleRange(sourceL, this.vocStart, modelRate, inputRate, this.outEnd, length),
      vocalsR: resampleRange(sourceR, this.vocStart, modelRate, inputRate, this.outEnd, length),
    };
    this.outEnd = end;
    const keepFrom = resampleInputRange(modelRate, inputRate, end, 1).start;
    const drop = Math.min(this.vocLength, keepFrom - this.vocStart);
    if (drop > 0) {
      this.vocL.copyWithin(0, drop, this.vocLength);
      this.vocR.copyWithin(0, drop, this.vocLength);
      this.vocLength -= drop;
      this.vocStart += drop;
    }
    return block;
  }
}

/** Overlap-add weights of an n-sample chunk. */
function olaWeights(weights: OlaWeights, n: number): Float64Array {
  const w = new Float64Array(n);
  if (weights === 'hann') {
    // np.hanning(n): symmetric Hann.
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }
  // apply_model(): cat(arange(1, n//2 + 1), arange(n − n//2, 0, −1)) / max.
  const half = Math.floor(n / 2);
  const max = Math.max(half, n - half);
  for (let i = 0; i < half; i++) w[i] = (i + 1) / max;
  for (let i = half; i < n; i++) w[i] = (n - i) / max;
  return w;
}
