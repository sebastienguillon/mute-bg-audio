// The look-ahead model registry: every entry agrees with its codec, and with the build
// configuration (scripts/models.mjs) that packages its file.
import { describe, expect, it } from 'vitest';
import { KIM_VOCAL_2, LOOKAHEAD_MODELS, SCNET } from '../../src/lib/lookahead/models';
import { MDX_MODELS } from '../../src/lib/mdx/mdx';
import { LOOKAHEAD_MODELS as BUILD_MODELS, lookaheadBuild, MODELS } from '../../scripts/models.mjs';

describe('look-ahead models', () => {
  it.each(Object.entries(LOOKAHEAD_MODELS))('%s: chunk size and tensor shape are those of its codec', (_name, model) => {
    const codec = model.createCodec();
    expect(codec.chunkSize).toBe(model.chunkSize);
    expect(codec.dims).toEqual(model.dims);
    expect(codec.tensorSize).toBe(model.dims.reduce((a, b) => a * b, 1));
  });

  it('are the builds LOOKAHEAD_MODEL selects, each packaging its model file', () => {
    expect(Object.keys(LOOKAHEAD_MODELS)).toEqual([...BUILD_MODELS]);
    for (const [name, model] of Object.entries(LOOKAHEAD_MODELS)) {
      const build = lookaheadBuild(name);
      expect(build.file).toBe(model.file);
      expect(MODELS[build.file].build).toBe(name);
    }
    expect(lookaheadBuild(undefined)).toEqual({ name: 'kim', file: 'Kim_Vocal_2.onnx', suffix: '' });
    expect(lookaheadBuild('')).toEqual({ name: 'kim', file: 'Kim_Vocal_2.onnx', suffix: '' });
    expect(lookaheadBuild('scnet')).toEqual({ name: 'scnet', file: 'scnet_vocals.onnx', suffix: '-scnet' });
    expect(() => lookaheadBuild('SCNet')).toThrow('LOOKAHEAD_MODEL must be kim or scnet, not "SCNet".');
  });

  it('Kim_Vocal_2 keeps UVR\'s settings', () => {
    const cfg = MDX_MODELS.Kim_Vocal_2;
    expect(KIM_VOCAL_2).toMatchObject({ file: 'Kim_Vocal_2.onnx', sampleRate: 44100, chunkSize: 261120, compensate: cfg.compensate });
    expect(KIM_VOCAL_2.stream).toEqual({ overlap: 0.25, weights: 'hann', peakNormalize: true, trim: cfg.nFft / 2 });
  });

  it('SCNet: 10 s chunks of 432 frames, triangle weights, no peak normalisation, no level correction', () => {
    expect(SCNET).toMatchObject({ file: 'scnet_vocals.onnx', sampleRate: 44100, chunkSize: 441000, dims: [1, 4, 2049, 432], compensate: 1 });
    expect(SCNET.stream).toEqual({ overlap: 0.25, weights: 'triangle', peakNormalize: false, trim: 2048 });
  });
});
