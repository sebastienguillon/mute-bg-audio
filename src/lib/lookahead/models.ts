/**
 * The look-ahead models a build can ship. A build packages one of them (LOOKAHEAD_MODEL, see
 * wxt.config.ts); LookaheadCore and the look-ahead worker take everything model-specific from its
 * entry: the file, the chunk codec and tensor shape, how the chunks are scheduled and overlap-added
 * (MdxStream), and the vocal level correction of the residual.
 */
import { MDX_MODELS, MdxChunkCodec, type ChunkCodec, type MdxBackend, type MdxModelName } from '../mdx/mdx';
import { MdxStream, type MdxStreamOptions } from '../mdx/mdx-stream';
import { SCNET_MODEL, ScnetChunkCodec, scnetFrames, type ScnetModelConfig } from '../mdx/scnet';

/** Values of LOOKAHEAD_MODEL. */
export type LookaheadModelName = 'kim' | 'scnet';

export interface LookaheadModel {
  /** Name in messages and logs. */
  name: string;
  /** Model file name (under the extension's models directory). */
  file: string;
  /** Model sample rate in Hz. */
  sampleRate: number;
  /** Samples per channel and chunk at the model rate (createCodec().chunkSize). */
  chunkSize: number;
  /** Shape of the model's input and output tensors (createCodec().dims). */
  dims: readonly number[];
  /** Vocal level correction used for the residual: residual = mix − compensate · vocals. */
  compensate: number;
  /** Chunk scheduling and overlap-add (MdxStream). */
  stream: Omit<MdxStreamOptions, 'modelRate' | 'inputRate'>;
  createCodec(): ChunkCodec;
}

/** An MDX-Net vocal model with UVR's settings: 25 % overlap, Hann weights, peak-normalised chunks. */
export function mdxModel(name: MdxModelName): LookaheadModel {
  const cfg = MDX_MODELS[name];
  return {
    name: cfg.name,
    file: cfg.file,
    sampleRate: cfg.sampleRate,
    chunkSize: cfg.hop * (cfg.dimT - 1),
    dims: [1, 4, cfg.dimF, cfg.dimT],
    compensate: cfg.compensate,
    stream: { overlap: 0.25, weights: 'hann', peakNormalize: true, trim: cfg.nFft / 2 },
    createCodec: () => new MdxChunkCodec(cfg),
  };
}

/**
 * SCNet (base, vocals stem) with demucs apply_model()'s triangle weights, and no peak normalisation
 * (the graph normalises each chunk). 25 % overlap instead of SCNet's 50 %: a third fewer model
 * runs, for less than 0.1 dB of speech SI-SDR on the test mix (22.03 dB, 22.09 dB at 50 %).
 */
export function scnetModel(cfg: ScnetModelConfig): LookaheadModel {
  return {
    name: cfg.name,
    file: cfg.file,
    sampleRate: cfg.sampleRate,
    chunkSize: cfg.chunkSize,
    dims: [1, 4, cfg.nFft / 2 + 1, scnetFrames(cfg)],
    compensate: 1,
    stream: { overlap: 0.25, weights: 'triangle', peakNormalize: false, trim: cfg.nFft / 2 },
    createCodec: () => new ScnetChunkCodec(cfg),
  };
}

/** UVR MDX-Net Kim_Vocal_2 (the default build). */
export const KIM_VOCAL_2: LookaheadModel = /* @__PURE__ */ mdxModel('Kim_Vocal_2');

/** SCNet base (the SCNet build). */
export const SCNET: LookaheadModel = /* @__PURE__ */ scnetModel(SCNET_MODEL);

export const LOOKAHEAD_MODELS: Readonly<Record<LookaheadModelName, LookaheadModel>> = { kim: KIM_VOCAL_2, scnet: SCNET };

/** The stream that separates with `model` through `backend` (input and output at inputRate, default 48 kHz). */
export function createModelStream(model: LookaheadModel, backend: MdxBackend, inputRate?: number): MdxStream {
  return new MdxStream(model.createCodec(), backend, {
    ...model.stream,
    modelRate: model.sampleRate,
    ...(inputRate !== undefined ? { inputRate } : {}),
  });
}
