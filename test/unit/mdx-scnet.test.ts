import { describe, expect, it } from 'vitest';
import { TorchStft } from '../../src/lib/dsp/stft';
import { SCNET_MODEL, ScnetChunkCodec, scnetFrames, scnetPadding } from '../../src/lib/mdx/scnet';
import { maxAbsDiff, noise, timeMs } from './helpers/dsp-audio';

describe('ScnetChunkCodec', () => {
  const codec = new ScnetChunkCodec(SCNET_MODEL);
  const bins = 2049;
  const frames = 432;
  const plane = bins * frames;

  it('pads chunks like SCNet.forward: a multiple of hop with an odd number of hops', () => {
    // 441000 = 430 · 1024 + 680: + 344 gives 431 hops.
    expect(scnetPadding(441000, 1024)).toBe(344);
    // 882000 + 688 = 862 hops (even): one hop more.
    expect(scnetPadding(882000, 1024)).toBe(688 + 1024);
    // Already a multiple with an odd count: a whole hop is still added, as in SCNet.forward.
    expect(scnetPadding(3 * 1024, 1024)).toBe(2048);
    expect(scnetFrames(SCNET_MODEL)).toBe(frames);
    expect(codec.chunkSize).toBe(441000);
    expect(codec.dims).toEqual([1, 4, bins, frames]);
    expect(codec.tensorSize).toBe(4 * plane);
  });

  it('writes [L.re, L.im, R.re, R.im] planes of the zero-padded chunk, all bins, bin-major', () => {
    const left = noise(codec.chunkSize, 0.5, 21);
    const right = noise(codec.chunkSize, 0.5, 22);
    const tensor = codec.encode(left, right);
    // The same STFT of each channel padded by hand.
    const stft = new TorchStft(4096, 1024, { window: 'rect', normalized: true });
    for (const [c, x] of [
      [0, left],
      [1, right],
    ] as const) {
      const padded = new Float32Array(441344);
      padded.set(x);
      const re = new Float32Array(plane);
      const im = new Float32Array(plane);
      stft.forward(padded, re, im);
      expect(maxAbsDiff(tensor.subarray(2 * c * plane, (2 * c + 1) * plane), re)).toBe(0);
      expect(maxAbsDiff(tensor.subarray((2 * c + 1) * plane, (2 * c + 2) * plane), im)).toBe(0);
    }
    // A cosine at an exact bin: |X| = nFft / 2 · nFft^−½ = 32 in the interior frames, nothing is zeroed.
    const k0 = 200;
    const tone = new Float32Array(codec.chunkSize);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.cos((2 * Math.PI * k0 * i) / 4096) + 0.25;
    const t2 = codec.encode(tone, tone);
    for (const t of [10, 200, 400]) {
      expect(Math.hypot(t2[k0 * frames + t]!, t2[plane + k0 * frames + t]!)).toBeCloseTo(32, 3);
      // DC: 0.25 · 4096 / 64.
      expect(t2[t]).toBeCloseTo(16, 3);
    }
    // The last frames reach into the zero padding (the chunk ends 344 samples before the padded end).
    expect(Math.hypot(t2[k0 * frames + frames - 1]!, t2[plane + k0 * frames + frames - 1]!)).toBeLessThan(32);
  });

  it('with an identity model, decode(encode(x)) = x (all bins, rectangular window)', () => {
    const left = noise(codec.chunkSize, 0.9, 23);
    const right = noise(codec.chunkSize, 0.9, 24);
    const [l, r] = codec.decode(codec.encode(left, right));
    expect(l.length).toBe(codec.chunkSize);
    expect(maxAbsDiff(l, left)).toBeLessThan(1e-5);
    expect(maxAbsDiff(r, right)).toBeLessThan(1e-5);
  });

  it('reuses its tensor and output buffers, and rejects other sizes', () => {
    const x = noise(codec.chunkSize, 0.5, 25);
    const tensor = codec.encode(x, x);
    expect(codec.encode(x, x)).toBe(tensor);
    const [l, r] = codec.decode(tensor);
    expect(codec.decode(tensor)[0]).toBe(l);
    expect(l).not.toBe(r);
    expect(() => codec.encode(new Float32Array(10), new Float32Array(10))).toThrow(RangeError);
    expect(() => codec.decode(new Float32Array(10))).toThrow(RangeError);
  });

  it('speed: encode + decode of one chunk (logged)', () => {
    const x = noise(codec.chunkSize, 0.5, 26);
    const enc = timeMs(() => codec.encode(x, x), 3);
    const tensor = codec.encode(x, x);
    const dec = timeMs(() => codec.decode(tensor), 3);
    console.log(`ScnetChunkCodec: encode ${enc.toFixed(1)} ms, decode ${dec.toFixed(1)} ms per stereo chunk`);
  });
});
