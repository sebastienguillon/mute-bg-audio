/**
 * SCNet (starrytong/SCNet, base model, vocals stem) pre/post-processing around the exported graph
 * (vendor/scnet/), matching SCNet.forward: a stereo chunk of chunkSize samples at 44.1 kHz is
 * zero-padded at the end to a multiple of hop with an odd number of hops, and becomes a
 * [1, 4, nFft/2 + 1, frames] tensor [L.re, L.im, R.re, R.im] of torch.stft(center=True, reflect,
 * rectangular window, normalized=True), all bins. The graph's vocals (same layout) are inverted
 * with torch.istft and cut to chunkSize. The graph normalises each chunk itself (mean and standard
 * deviation of its spectrogram), so chunks need no peak normalisation; the residual is
 * mix − vocals.
 */
import { TorchStft } from '../dsp/stft';
import type { ChunkCodec } from './mdx';

export interface ScnetModelConfig {
  name: string;
  /** Model file name (under the extension's models directory). */
  file: string;
  nFft: number;
  hop: number;
  /** Samples per channel and chunk; the graph's fixed frame count follows from it (scnetFrames). */
  chunkSize: number;
  /** Model sample rate in Hz. */
  sampleRate: number;
}

/** The exported graph: 10 s chunks (432 frames). SCNet's own inference uses 20 s segments. */
export const SCNET_MODEL: ScnetModelConfig = {
  name: 'SCNet',
  file: 'scnet_vocals.onnx',
  nFft: 4096,
  hop: 1024,
  chunkSize: 441000,
  sampleRate: 44100,
};

/** SCNet.forward's end padding of a chunk: up to a multiple of hop with an odd number of hops. */
export function scnetPadding(length: number, hop: number): number {
  let padding = hop - (length % hop);
  if (((length + padding) / hop) % 2 === 0) padding += hop;
  return padding;
}

/** STFT frames of a padded chunk: the graph's time dimension. */
export function scnetFrames(cfg: ScnetModelConfig): number {
  return 1 + (cfg.chunkSize + scnetPadding(cfg.chunkSize, cfg.hop)) / cfg.hop;
}

export class ScnetChunkCodec implements ChunkCodec {
  readonly chunkSize: number;
  /** [1, 4, nFft/2 + 1, frames]. */
  readonly dims: readonly number[];
  /** Floats per tensor: 4 · bins · frames. */
  readonly tensorSize: number;
  private readonly stft: TorchStft;
  private readonly frames: number;
  /** One channel of the chunk, zero-padded at the end. */
  private readonly padded: Float32Array;
  private readonly tensor: Float32Array;
  private readonly outL: Float32Array;
  private readonly outR: Float32Array;

  constructor(cfg: ScnetModelConfig) {
    this.stft = new TorchStft(cfg.nFft, cfg.hop, { window: 'rect', normalized: true });
    if (!Number.isInteger(cfg.chunkSize) || cfg.chunkSize <= cfg.nFft / 2) throw new RangeError(`chunkSize must be an integer > ${cfg.nFft / 2}`);
    this.chunkSize = cfg.chunkSize;
    this.padded = new Float32Array(cfg.chunkSize + scnetPadding(cfg.chunkSize, cfg.hop));
    this.frames = this.stft.frameCount(this.padded.length);
    this.dims = [1, 4, this.stft.bins, this.frames];
    this.tensorSize = 4 * this.stft.bins * this.frames;
    this.tensor = new Float32Array(this.tensorSize);
    this.outL = new Float32Array(this.chunkSize);
    this.outR = new Float32Array(this.chunkSize);
  }

  encode(left: Float32Array, right: Float32Array): Float32Array {
    if (left.length !== this.chunkSize || right.length !== this.chunkSize) {
      throw new RangeError(`SCNet chunks must have ${this.chunkSize} samples per channel`);
    }
    const plane = this.stft.bins * this.frames;
    const { tensor, padded } = this;
    // The padding after the chunk stays zero.
    padded.set(left);
    this.stft.forward(padded, tensor.subarray(0, plane), tensor.subarray(plane, 2 * plane));
    padded.set(right);
    this.stft.forward(padded, tensor.subarray(2 * plane, 3 * plane), tensor.subarray(3 * plane));
    return tensor;
  }

  decode(out: Float32Array): [Float32Array, Float32Array] {
    if (out.length !== this.tensorSize) throw new RangeError(`SCNet tensors must have ${this.tensorSize} elements`);
    const { bins } = this.stft;
    const { frames, chunkSize } = this;
    const plane = bins * frames;
    // istft of the padded length, cut to the chunk: the first chunkSize samples of it.
    const left = this.stft.inverse(out.subarray(0, plane), out.subarray(plane, 2 * plane), bins, frames, chunkSize, this.outL);
    const right = this.stft.inverse(out.subarray(2 * plane, 3 * plane), out.subarray(3 * plane), bins, frames, chunkSize, this.outR);
    return [left, right];
  }
}
