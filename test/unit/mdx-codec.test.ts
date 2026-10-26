import { describe, expect, it } from 'vitest';
import { MDX_MODELS, MdxChunkCodec } from '../../src/lib/mdx/mdx';
import { maxAbsDiff, rng, timeMs } from './helpers/dsp-audio';

const cfg = MDX_MODELS.Kim_Vocal_2;
const RATE = 44100;

/** Sum of sines with random frequencies in [lo, hi] Hz and random phases. */
function multitone(n: number, lo: number, hi: number, count: number, seed: number): Float32Array {
  const r = rng(seed);
  const tones = Array.from({ length: count }, () => ({ f: lo + (hi - lo) * r(), phase: 2 * Math.PI * r(), amp: 0.5 / count + r() * (0.5 / count) }));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const t of tones) v += t.amp * Math.sin((2 * Math.PI * t.f * i) / RATE + t.phase);
    out[i] = v;
  }
  return out;
}

describe('MdxChunkCodec', () => {
  const codec = new MdxChunkCodec(cfg);
  const plane = cfg.dimF * cfg.dimT;

  it('has the python-audio-separator geometry', () => {
    expect(codec.chunkSize).toBe(261120);
    expect(codec.dims).toEqual([1, 4, 3072, 256]);
    expect(codec.tensorSize).toBe(4 * 3072 * 256);
    expect(MDX_MODELS['UVR-MDX-NET-Voc_FT']).toMatchObject({ compensate: 1.021, file: 'UVR-MDX-NET-Voc_FT.onnx', nFft: 7680, dimF: 3072, dimT: 256 });
    expect(MDX_MODELS.Kim_Vocal_2).toMatchObject({ compensate: 1.009, file: 'Kim_Vocal_2.onnx', hop: 1024, sampleRate: 44100 });
  });

  it('writes [L.re, L.im, R.re, R.im] planes, bin-major, with bins 0..2 zeroed', () => {
    const n = codec.chunkSize;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    const k0 = 100; // exact bin: frequency k0 * 44100 / 7680
    for (let i = 0; i < n; i++) {
      left[i] = Math.cos((2 * Math.PI * k0 * i) / cfg.nFft) + 0.25;
      right[i] = 0.5 * Math.sin((2 * Math.PI * (2 * k0) * i) / cfg.nFft);
    }
    const tensor = codec.encode(left, right);
    const mag = (c: number, bin: number, frame: number) =>
      Math.hypot(tensor[c * plane + bin * cfg.dimT + frame]!, tensor[(c + 1) * plane + bin * cfg.dimT + frame]!);
    for (const t of [10, 128, 245]) {
      expect(mag(0, k0, t)).toBeCloseTo(cfg.nFft / 4, 0);
      expect(mag(0, 2 * k0, t)).toBeLessThan(1e-2);
      expect(mag(2, 2 * k0, t)).toBeCloseTo(cfg.nFft / 8, 0);
      expect(mag(2, k0, t)).toBeLessThan(1e-2);
    }
    for (let c = 0; c < 4; c++) {
      for (let i = 0; i < 3 * cfg.dimT; i++) expect(tensor[c * plane + i]).toBe(0);
    }
  });

  it('with an identity model, decode(encode(x)) = x for audio inside 17.2 kHz without bins 0..2', () => {
    const n = codec.chunkSize;
    const trim = cfg.nFft / 2;
    const left = multitone(n, 200, 16000, 40, 1);
    const right = multitone(n, 200, 16000, 40, 2);
    const [l, r] = codec.decode(codec.encode(left, right));
    // The reflected edges are not band-limited; demix() trims / down-weights them.
    expect(maxAbsDiff(l, left, trim, n - trim)).toBeLessThan(1e-4);
    expect(maxAbsDiff(r, right, trim, n - trim)).toBeLessThan(1e-4);
    expect(maxAbsDiff(l, left, 2 * cfg.nFft, n - 2 * cfg.nFft)).toBeLessThan(1e-6);
  });

  it('removes DC and content above dimF bins (17.64 kHz)', () => {
    const n = codec.chunkSize;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.3 + 0.5 * Math.sin((2 * Math.PI * 18500 * i) / RATE);
    const [l] = codec.decode(codec.encode(x, x));
    let peak = 0;
    for (let i = 8000; i < n - 8000; i++) peak = Math.max(peak, Math.abs(l[i]!));
    expect(peak).toBeLessThan(1e-3);
  });

  it('reuses its tensor and output buffers (one chunk at a time)', () => {
    const left = multitone(codec.chunkSize, 200, 16000, 8, 5);
    const tensor = codec.encode(left, left);
    expect(codec.encode(left, left)).toBe(tensor);
    const [l, r] = codec.decode(tensor);
    const [l2, r2] = codec.decode(tensor);
    expect(l2).toBe(l);
    expect(r2).toBe(r);
    expect(l).not.toBe(r);
  });

  it('speed: encode + decode of one chunk (logged)', () => {
    const left = multitone(codec.chunkSize, 200, 16000, 8, 3);
    const enc = timeMs(() => codec.encode(left, left));
    const tensor = codec.encode(left, left);
    const dec = timeMs(() => codec.decode(tensor));
    console.log(`MdxChunkCodec: encode ${enc.toFixed(1)} ms, decode ${dec.toFixed(1)} ms per stereo chunk`);
  });
});
