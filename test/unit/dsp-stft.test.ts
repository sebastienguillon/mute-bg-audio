import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TorchStft } from '../../src/lib/dsp/stft';
import { maxAbsDiff, noise, ROOT, timeMs } from './helpers/dsp-audio';

/** A case of test/fixtures/torch-stft-rect.json (vendor/scnet/stft_reference.py). */
interface TorchCase {
  nFft: number;
  hop: number;
  length: number;
  frames: number;
  /** Bins of `re` / `im` (bin-major, `frames` values each). */
  bins: number[];
  x: number[];
  re: number[];
  im: number[];
  /** torch.istft(length) of the spectrogram inverseRe/inverseIm (all bins), when present. */
  inverseRe?: number[];
  inverseIm?: number[];
  inverse?: number[];
}

describe('TorchStft', () => {
  it('frameCount = 1 + floor(length / hop)', () => {
    const stft = new TorchStft(7680, 1024);
    expect(stft.frameCount(261120)).toBe(256);
    expect(stft.frameCount(1023)).toBe(1);
    expect(stft.frameCount(1024)).toBe(2);
  });

  it('reflect padding and periodic Hann match a hand-computed example (x = 1..8, nFft = 4, hop = 2)', () => {
    // Reflect padding by 2: [3, 2, | 1 2 3 4 5 6 7 8 | 7, 6]; frames start every 2 samples:
    //   t0 [3 2 1 2]  t1 [1 2 3 4]  t2 [3 4 5 6]  t3 [5 6 7 8]  t4 [7 8 7 6]
    // Periodic Hann(4) = [0, .5, 1, .5]; windowed frames:
    //   t0 [0 1 1 1]  t1 [0 1 3 2]  t2 [0 2 5 3]  t3 [0 3 7 4]  t4 [0 4 7 3]
    // rfft of [a b c d]: X0 = a+b+c+d, X1 = (a-c) + i(d-b), X2 = a-b+c-d.
    const expectedRe = [
      [3, 6, 10, 14, 14], // bin 0, frames 0..4
      [-1, -3, -5, -7, -7], // bin 1
      [-1, 0, 0, 0, 0], // bin 2
    ];
    const expectedIm = [
      [0, 0, 0, 0, 0],
      [0, 1, 1, 1, -1],
      [0, 0, 0, 0, 0],
    ];
    const stft = new TorchStft(4, 2);
    const x = Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const frames = stft.frameCount(x.length);
    expect(frames).toBe(5);
    const re = new Float32Array(3 * frames);
    const im = new Float32Array(3 * frames);
    stft.forward(x, re, im);
    for (let b = 0; b < 3; b++) {
      for (let t = 0; t < frames; t++) {
        expect(re[b * frames + t]).toBeCloseTo(expectedRe[b]![t]!, 6);
        expect(im[b * frames + t]).toBeCloseTo(expectedIm[b]![t]!, 6);
      }
    }
    expect(Array.from(stft.inverse(re, im, 3, frames, 8))).toEqual(Array.from(x).map((v) => expect.closeTo(v, 5)));
  });

  it('a cosine at an exact bin has magnitude nFft/4 and the expected phase', () => {
    const nFft = 256;
    const hop = 64;
    const k0 = 20;
    const phi = 0.7;
    const length = 4096;
    const x = new Float32Array(length);
    for (let i = 0; i < length; i++) x[i] = Math.cos((2 * Math.PI * k0 * i) / nFft + phi);
    const stft = new TorchStft(nFft, hop);
    const frames = stft.frameCount(length);
    const bins = stft.bins;
    const re = new Float32Array(bins * frames);
    const im = new Float32Array(bins * frames);
    stft.forward(x, re, im);
    // Interior frames (no reflection inside the window): frame t is x[t*hop - nFft/2 ...].
    for (let t = 2; t < frames - 2; t++) {
      const i = k0 * frames + t;
      expect(Math.hypot(re[i]!, im[i]!)).toBeCloseTo(nFft / 4, 3);
      const phase = phi + (2 * Math.PI * k0 * (t * hop - nFft / 2)) / nFft;
      expect(Math.cos(Math.atan2(im[i]!, re[i]!) - phase)).toBeCloseTo(1, 6);
      // Hann leaks -nFft/8 into the neighbours and nothing further away.
      expect(Math.hypot(re[i - frames]!, im[i - frames]!)).toBeCloseTo(nFft / 8, 3);
      expect(Math.hypot(re[i + frames]!, im[i + frames]!)).toBeCloseTo(nFft / 8, 3);
      expect(Math.hypot(re[i + 5 * frames]!, im[i + 5 * frames]!)).toBeLessThan(1e-3);
    }
  });

  it.each([
    [4, 1, 50],
    [8, 2, 101],
    [64, 16, 1000],
    [512, 128, 10007],
    [2048, 512, 44100],
    [7680, 1024, 100000],
    [7680, 1024, 261120],
  ])('istft(stft(x)) = x for nFft %i, hop %i, length %i', (nFft, hop, length) => {
    const stft = new TorchStft(nFft, hop);
    const x = noise(length, 0.9, nFft + length);
    const frames = stft.frameCount(length);
    const re = new Float32Array(stft.bins * frames);
    const im = new Float32Array(stft.bins * frames);
    stft.forward(x, re, im);
    const y = stft.inverse(re, im, stft.bins, frames, length);
    expect(y.length).toBe(length);
    expect(maxAbsDiff(y, x)).toBeLessThan(1e-5);
  });

  it('inverse treats bins >= `bins` as zero and pads beyond the available length with zeros', () => {
    const stft = new TorchStft(64, 16);
    const length = 640;
    const frames = stft.frameCount(length);
    const x = new Float32Array(length);
    for (let i = 0; i < length; i++) x[i] = Math.cos((2 * Math.PI * 3 * i) / 64) + Math.cos((2 * Math.PI * 25 * i) / 64);
    const re = new Float32Array(10 * frames);
    const im = new Float32Array(10 * frames);
    stft.forward(x, re, im, 10);
    const y = stft.inverse(re, im, 10, frames, length + 100);
    // Only the low cosine survives (away from the reflected edges).
    for (let i = 64; i < length - 64; i++) expect(y[i]).toBeCloseTo(Math.cos((2 * Math.PI * 3 * i) / 64), 4);
    // torch pads with zeros past nFft + hop*(frames-1) - nFft/2 samples.
    const available = 64 + 16 * (frames - 1) - 32;
    for (let i = available; i < length + 100; i++) expect(y[i]).toBe(0);
  });

  it('rejects signals too short for reflect padding', () => {
    const stft = new TorchStft(8, 2);
    expect(() => stft.forward(new Float32Array(4), new Float32Array(25), new Float32Array(25))).toThrow(RangeError);
  });

  describe('with a rectangular window and normalized=True (SCNet)', () => {
    const { cases } = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/torch-stft-rect.json'), 'utf8')) as { cases: TorchCase[] };

    it.each(cases.map((c) => [c.nFft, c.hop, c.length, c] as const))('matches torch.stft for nFft %i, hop %i, length %i', (nFft, hop, _length, c) => {
      const stft = new TorchStft(nFft, hop, { window: 'rect', normalized: true });
      expect(stft.frameCount(c.length)).toBe(c.frames);
      const re = new Float32Array(stft.bins * c.frames);
      const im = new Float32Array(stft.bins * c.frames);
      stft.forward(Float32Array.from(c.x), re, im);
      let worst = 0;
      c.bins.forEach((bin, b) => {
        for (let t = 0; t < c.frames; t++) {
          worst = Math.max(worst, Math.abs(re[bin * c.frames + t]! - c.re[b * c.frames + t]!), Math.abs(im[bin * c.frames + t]! - c.im[b * c.frames + t]!));
        }
      });
      expect(worst).toBeLessThan(1e-5);
    });

    it.each(cases.filter((c) => c.inverse).map((c) => [c.nFft, c.hop, c.length, c] as const))(
      'matches torch.istft for nFft %i, hop %i, length %i',
      (nFft, hop, length, c) => {
        const stft = new TorchStft(nFft, hop, { window: 'rect', normalized: true });
        const y = stft.inverse(c.inverseRe!, c.inverseIm!, stft.bins, c.frames, length);
        expect(maxAbsDiff(y, c.inverse!)).toBeLessThan(1e-5);
      },
    );

    it('istft(stft(x)) = x for SCNet\'s nFft 4096, hop 1024', () => {
      const stft = new TorchStft(4096, 1024, { window: 'rect', normalized: true });
      const x = noise(441344, 0.9, 77);
      const frames = stft.frameCount(x.length);
      const re = new Float32Array(stft.bins * frames);
      const im = new Float32Array(stft.bins * frames);
      stft.forward(x, re, im);
      expect(maxAbsDiff(stft.inverse(re, im, stft.bins, frames, x.length), x)).toBeLessThan(1e-5);
    });
  });

  it('speed for one MDX channel (logged)', () => {
    const stft = new TorchStft(7680, 1024);
    const x = noise(261120, 0.5, 9);
    const re = new Float32Array(3072 * 256);
    const im = new Float32Array(3072 * 256);
    const fwd = timeMs(() => stft.forward(x, re, im, 3072));
    const out = new Float32Array(261120);
    const inv = timeMs(() => stft.inverse(re, im, 3072, 256, 261120, out));
    console.log(`TorchStft(7680, 1024) on 261120 samples: forward ${fwd.toFixed(1)} ms, inverse ${inv.toFixed(1)} ms`);
  });
});
