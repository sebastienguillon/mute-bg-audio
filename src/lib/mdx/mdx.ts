/**
 * MDX-Net (UVR) pre/post-processing, matching python-audio-separator's MDXSeparator:
 * a stereo chunk of hop·(dimT − 1) samples at 44.1 kHz becomes a [1, 4, dimF, dimT] tensor
 * [L.re, L.im, R.re, R.im] of torch.stft(center=True, reflect, periodic Hann) bins 0..dimF-1
 * with bins 0..2 zeroed; the model output (same layout, vocals) is zero-padded to nFft/2 + 1
 * bins and inverted with torch.istft. The residual is mix − compensate · vocals.
 */
import { TorchStft } from '../dsp/stft';

export interface MdxModelConfig {
  name: string;
  /** Model file name (under the extension's models directory). */
  file: string;
  nFft: number;
  hop: number;
  dimF: number;
  dimT: number;
  /** Vocal level correction used for the residual: residual = mix − compensate · vocals. */
  compensate: number;
  /** Model sample rate in Hz. */
  sampleRate: number;
}

export type MdxModelName = 'Kim_Vocal_2' | 'UVR-MDX-NET-Voc_FT';

/** UVR vocal models (primary stem: vocals), parameters from UVR's model data. */
export const MDX_MODELS: Record<MdxModelName, MdxModelConfig> = {
  Kim_Vocal_2: {
    name: 'Kim_Vocal_2',
    file: 'Kim_Vocal_2.onnx',
    nFft: 7680,
    hop: 1024,
    dimF: 3072,
    dimT: 256,
    compensate: 1.009,
    sampleRate: 44100,
  },
  'UVR-MDX-NET-Voc_FT': {
    name: 'UVR-MDX-NET-Voc_FT',
    file: 'UVR-MDX-NET-Voc_FT.onnx',
    nFft: 7680,
    hop: 1024,
    dimF: 3072,
    dimT: 256,
    compensate: 1.021,
    sampleRate: 44100,
  },
};

/** Runs the separation model on one input tensor. */
export interface MdxBackend {
  /**
   * input: 4·dimF·dimT floats in [1, 4, dimF, dimT] layout, valid until the returned promise
   * settles (callers reuse the buffer); resolves to vocals in the same layout.
   */
  run(input: Float32Array): Promise<Float32Array>;
  /** Frees the model's resources (GPU memory) while it is not needed; the next run() reloads it. */
  release?(): void;
}

/** The backend can never run on this device (no usable GPU, model missing): retrying does not help. */
export class BackendUnavailableError extends Error {
  override name = 'BackendUnavailableError';
}

export const TOO_SLOW_REASON = 'This computer is too slow for look-ahead processing. Using real-time mode.';

/**
 * The backend is far too slow for playback (a run took several times the audio it processes):
 * retrying soon does not help, much later it may (another tab or app may have used the GPU).
 */
export class BackendTooSlowError extends BackendUnavailableError {
  override name = 'BackendTooSlowError';

  constructor() {
    super(TOO_SLOW_REASON);
  }
}

/** Lowest bins zeroed in the model input (spek[:, :, :3, :] = 0). */
const ZEROED_BINS = 3;

/**
 * Converts stereo chunks to model tensors and model output tensors back to stereo chunks. The
 * returned arrays are buffers of the codec, overwritten by the next call of the same method.
 */
export class MdxChunkCodec {
  /** Samples per channel and chunk: hop · (dimT − 1). */
  readonly chunkSize: number;
  /** Floats per tensor: 4 · dimF · dimT. */
  readonly tensorSize: number;
  private readonly stft: TorchStft;
  private readonly dimF: number;
  private readonly dimT: number;
  private readonly tensor: Float32Array;
  private readonly outL: Float32Array;
  private readonly outR: Float32Array;

  constructor(cfg: MdxModelConfig) {
    this.stft = new TorchStft(cfg.nFft, cfg.hop);
    this.dimF = cfg.dimF;
    this.dimT = cfg.dimT;
    this.chunkSize = cfg.hop * (cfg.dimT - 1);
    this.tensorSize = 4 * cfg.dimF * cfg.dimT;
    if (this.stft.frameCount(this.chunkSize) !== cfg.dimT) throw new RangeError('hop · (dimT − 1) must give dimT STFT frames');
    if (cfg.dimF > this.stft.bins || cfg.dimF <= ZEROED_BINS) throw new RangeError(`dimF must be in (${ZEROED_BINS}, ${this.stft.bins}]`);
    this.tensor = new Float32Array(this.tensorSize);
    this.outL = new Float32Array(this.chunkSize);
    this.outR = new Float32Array(this.chunkSize);
  }

  /** Model input tensor for one chunk (left/right: chunkSize samples each). */
  encode(left: Float32Array, right: Float32Array): Float32Array {
    if (left.length !== this.chunkSize || right.length !== this.chunkSize) {
      throw new RangeError(`MDX chunks must have ${this.chunkSize} samples per channel`);
    }
    const plane = this.dimF * this.dimT;
    const tensor = this.tensor;
    this.stft.forward(left, tensor.subarray(0, plane), tensor.subarray(plane, 2 * plane), this.dimF);
    this.stft.forward(right, tensor.subarray(2 * plane, 3 * plane), tensor.subarray(3 * plane), this.dimF);
    for (let c = 0; c < 4; c++) tensor.fill(0, c * plane, c * plane + ZEROED_BINS * this.dimT);
    return tensor;
  }

  /** Stereo waveform (chunkSize samples per channel) of a model output tensor. */
  decode(out: Float32Array): [Float32Array, Float32Array] {
    if (out.length !== this.tensorSize) throw new RangeError(`MDX tensors must have ${this.tensorSize} elements`);
    const plane = this.dimF * this.dimT;
    const { dimF, dimT, chunkSize } = this;
    const left = this.stft.inverse(out.subarray(0, plane), out.subarray(plane, 2 * plane), dimF, dimT, chunkSize, this.outL);
    const right = this.stft.inverse(out.subarray(2 * plane, 3 * plane), out.subarray(3 * plane), dimF, dimT, chunkSize, this.outR);
    return [left, right];
  }
}
