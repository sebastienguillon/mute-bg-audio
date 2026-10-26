/**
 * STFT / inverse STFT with the exact semantics of
 *   torch.stft(x, nFft, hop, window=torch.hann_window(nFft, periodic=True), center=True,
 *              pad_mode='reflect', normalized=False, onesided=True)
 * and the matching torch.istft(..., center=True, length=L). Options select a rectangular window
 * (torch's window=None) and normalized=True (spectrum · nFft^−½, and · nFft^½ before the inverse).
 *
 * Spectrograms use a bin-major layout, `re[bin * frames + frame]`, which is the layout of one
 * channel plane of the models' input tensors [1, 4, bins, frames].
 */
import { RealFFT } from './fft';

/** torch.istft's NOLA threshold: the window-squared envelope must exceed this everywhere kept. */
const NOLA_EPS = 1e-11;

export interface TorchStftOptions {
  /** 'hann': periodic Hann (default); 'rect': rectangular, torch's window=None. */
  window?: 'hann' | 'rect';
  /** torch's normalized=True (default false). */
  normalized?: boolean;
}

export class TorchStft {
  readonly nFft: number;
  readonly hop: number;
  /** Bins of the one-sided spectrum, nFft/2 + 1. */
  readonly bins: number;
  private readonly pad: number;
  private readonly rfft: RealFFT;
  private readonly window: Float64Array;
  /** Factor of the forward spectrum (normalized: nFft^−½, else 1). */
  private readonly scale: number;
  private readonly frame: Float64Array;
  private readonly specRe: Float64Array;
  private readonly specIm: Float64Array;
  private padded = new Float64Array(0);
  private ola = new Float64Array(0);
  /** 1 / Σ w² over the overlap-add buffer, cached for `envelopeFrames` frames. */
  private invEnvelope = new Float64Array(0);
  private envelopeFrames = -1;
  /** First index >= nFft/2 where the cached envelope violates NOLA (or its length). */
  private nolaEnd = 0;

  constructor(nFft: number, hop: number, opts: TorchStftOptions = {}) {
    if (!Number.isInteger(nFft) || nFft < 2 || nFft % 2 !== 0) throw new RangeError(`nFft must be even, got ${nFft}`);
    if (!Number.isInteger(hop) || hop < 1 || hop > nFft) throw new RangeError(`hop must be in [1, nFft], got ${hop}`);
    this.nFft = nFft;
    this.hop = hop;
    this.bins = nFft / 2 + 1;
    this.pad = nFft / 2;
    this.rfft = new RealFFT(nFft);
    this.window = new Float64Array(nFft);
    if (opts.window === 'rect') this.window.fill(1);
    else for (let i = 0; i < nFft; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
    this.scale = opts.normalized ? 1 / Math.sqrt(nFft) : 1;
    this.frame = new Float64Array(nFft);
    this.specRe = new Float64Array(this.bins);
    this.specIm = new Float64Array(this.bins);
  }

  /** Number of frames torch.stft(center=True) produces for a signal of `length` samples. */
  frameCount(length: number): number {
    return 1 + Math.floor(length / this.hop);
  }

  /**
   * Writes the first `bins` bins of every frame of x into outRe/outIm at [bin * frames + frame].
   * Requires x.length > nFft/2 (reflect padding).
   */
  forward(x: ArrayLike<number>, outRe: Float32Array, outIm: Float32Array, bins = this.bins): void {
    const { nFft, hop, pad, window, frame, specRe, specIm, scale } = this;
    const length = x.length;
    const frames = this.frameCount(length);
    if (length <= pad) throw new RangeError(`reflect padding needs more than ${pad} samples, got ${length}`);
    if (bins < 1 || bins > this.bins) throw new RangeError(`bins must be in [1, ${this.bins}], got ${bins}`);
    if (outRe.length < bins * frames || outIm.length < bins * frames) {
      throw new RangeError(`outputs need ${bins * frames} elements`);
    }
    const padded = this.paddedBuffer(length + 2 * pad);
    for (let i = 0; i < length; i++) padded[pad + i] = x[i]!;
    for (let i = 1; i <= pad; i++) {
      padded[pad - i] = x[i]!;
      padded[pad + length - 1 + i] = x[length - 1 - i]!;
    }
    for (let t = 0; t < frames; t++) {
      const offset = t * hop;
      for (let i = 0; i < nFft; i++) frame[i] = padded[offset + i]! * window[i]!;
      this.rfft.forward(frame, specRe, specIm);
      for (let b = 0, o = t; b < bins; b++, o += frames) {
        outRe[o] = specRe[b]! * scale;
        outIm[o] = specIm[b]! * scale;
      }
    }
  }

  /**
   * torch.istft(center=True, length) of a spectrogram in the forward() layout. Bins >= `bins`
   * are treated as zero. Returns `length` samples (written into `out` when given).
   */
  inverse(
    re: ArrayLike<number>,
    im: ArrayLike<number>,
    bins: number,
    frames: number,
    length: number,
    out: Float32Array = new Float32Array(length),
  ): Float32Array {
    const { nFft, hop, pad, window, frame, specRe, specIm } = this;
    if (bins < 1 || bins > this.bins) throw new RangeError(`bins must be in [1, ${this.bins}], got ${bins}`);
    if (re.length < bins * frames || im.length < bins * frames) throw new RangeError(`inputs need ${bins * frames} elements`);
    if (out.length < length) throw new RangeError(`output needs ${length} samples`);
    const olaLength = nFft + hop * (frames - 1);
    const ola = this.olaBuffer(olaLength);
    specRe.fill(0, bins);
    specIm.fill(0, bins);
    for (let t = 0; t < frames; t++) {
      for (let b = 0, o = t; b < bins; b++, o += frames) {
        specRe[b] = re[o]!;
        specIm[b] = im[o]!;
      }
      this.rfft.inverse(specRe, specIm, frame);
      const offset = t * hop;
      for (let i = 0; i < nFft; i++) ola[offset + i] = ola[offset + i]! + frame[i]! * window[i]!;
    }
    const kept = Math.min(length, olaLength - pad);
    const invEnvelope = this.envelope(frames);
    if (pad + kept > this.nolaEnd) throw new RangeError('window overlap-add is not invertible (NOLA)');
    for (let i = 0; i < kept; i++) out[i] = ola[pad + i]! * invEnvelope[pad + i]!;
    out.fill(0, kept, length);
    return out;
  }

  private paddedBuffer(size: number): Float64Array {
    if (this.padded.length < size) this.padded = new Float64Array(size);
    return this.padded;
  }

  private olaBuffer(size: number): Float64Array {
    if (this.ola.length < size) this.ola = new Float64Array(size);
    this.ola.fill(0, 0, size);
    return this.ola;
  }

  /**
   * Reciprocal window-squared envelope for `frames` frames (cached), and its NOLA limit. It also
   * undoes the forward normalisation (normalized: · nFft^½).
   */
  private envelope(frames: number): Float64Array {
    if (this.envelopeFrames === frames) return this.invEnvelope;
    const { nFft, hop, pad, window, scale } = this;
    const size = nFft + hop * (frames - 1);
    const env = new Float64Array(size);
    for (let t = 0; t < frames; t++) {
      for (let i = 0; i < nFft; i++) env[t * hop + i] = env[t * hop + i]! + window[i]! * window[i]!;
    }
    this.nolaEnd = size;
    for (let i = 0; i < size; i++) {
      if (i >= pad && env[i]! < NOLA_EPS && this.nolaEnd === size) this.nolaEnd = i;
      env[i] = 1 / (scale * env[i]!);
    }
    this.invEnvelope = env;
    this.envelopeFrames = frames;
    return env;
  }
}
