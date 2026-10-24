import { describe, expect, it } from 'vitest';
import { FFT, RealFFT, isSmoothSize, nextSmoothSize } from '../../src/lib/dsp/fft';
import { rng, timeMs } from './helpers/dsp-audio';

/** Naive DFT bin k of a complex sequence (angles reduced exactly mod n). */
function dftBin(re: ArrayLike<number>, im: ArrayLike<number>, k: number, sign = -1): [number, number] {
  const n = re.length;
  let sr = 0;
  let si = 0;
  for (let j = 0; j < n; j++) {
    const a = (sign * 2 * Math.PI * ((j * k) % n)) / n;
    const c = Math.cos(a);
    const s = Math.sin(a);
    sr += re[j]! * c - im[j]! * s;
    si += re[j]! * s + im[j]! * c;
  }
  return [sr, si];
}

function randomComplex(n: number, seed: number): [Float64Array, Float64Array] {
  const r = rng(seed);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    re[i] = 2 * r() - 1;
    im[i] = 2 * r() - 1;
  }
  return [re, im];
}

/** Max |X - ref| over the given bins, relative to the RMS magnitude of the reference bins. */
function binError(re: Float64Array, im: Float64Array, x: [Float64Array, Float64Array], bins: number[], sign = -1): number {
  let maxErr = 0;
  let refEnergy = 0;
  for (const k of bins) {
    const [rr, ri] = dftBin(x[0], x[1], k, sign);
    maxErr = Math.max(maxErr, Math.hypot(re[k]! - rr, im[k]! - ri));
    refEnergy += rr * rr + ri * ri;
  }
  return maxErr / Math.sqrt(refEnergy / bins.length);
}

function spotBins(n: number, count: number, seed: number): number[] {
  const r = rng(seed);
  const bins = new Set([0, 1, n - 1, Math.floor(n / 2), Math.floor(n / 3)]);
  while (bins.size < Math.min(n, count)) bins.add(Math.floor(r() * n));
  return [...bins].filter((k) => k < n);
}

describe('FFT', () => {
  const allBins = (n: number) => Array.from({ length: n }, (_, k) => k);
  const fullSizes = [...Array.from({ length: 64 }, (_, i) => i + 1), 60, 120, 97, 210, 1000, 1024];

  it.each(fullSizes)('forward matches the naive DFT for n = %i', (n) => {
    const x = randomComplex(n, n);
    const re = x[0].slice();
    const im = x[1].slice();
    new FFT(n).forward(re, im);
    expect(binError(re, im, x, allBins(n))).toBeLessThan(1e-12);
  });

  it.each([7680, 65536, 3840, 262144, 7 * 1024, 4099])('forward matches the naive DFT on spot bins for n = %i', (n) => {
    const x = randomComplex(n, n);
    const re = x[0].slice();
    const im = x[1].slice();
    new FFT(n).forward(re, im);
    expect(binError(re, im, x, spotBins(n, 24, n))).toBeLessThan(1e-11);
  });

  it.each([1, 2, 7, 60, 1024, 7680, 65536, 1 << 18, 4099])('inverse(forward(x)) = n·x for n = %i', (n) => {
    const x = randomComplex(n, 7 * n);
    const re = x[0].slice();
    const im = x[1].slice();
    const fft = new FFT(n);
    fft.forward(re, im);
    fft.inverse(re, im);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.hypot(re[i]! / n - x[0][i]!, im[i]! / n - x[1][i]!));
    expect(err).toBeLessThan(1e-12);
  });

  it('inverse is the unscaled e^{+i} transform', () => {
    const n = 120;
    const x = randomComplex(n, 3);
    const re = x[0].slice();
    const im = x[1].slice();
    new FFT(n).inverse(re, im);
    expect(binError(re, im, x, allBins(n), +1)).toBeLessThan(1e-12);
  });

  it('rejects invalid sizes and short arrays', () => {
    expect(() => new FFT(0)).toThrow(RangeError);
    expect(() => new FFT(2.5)).toThrow(RangeError);
    expect(() => new FFT(8).forward(new Float64Array(4), new Float64Array(8))).toThrow(RangeError);
  });

  it('smooth size helpers', () => {
    expect(isSmoothSize(7680)).toBe(true);
    expect(isSmoothSize(7 * 1024)).toBe(false);
    expect(nextSmoothSize(7681)).toBe(7776);
    expect(nextSmoothSize(199999)).toBe(200000);
  });
});

describe('RealFFT', () => {
  it.each([2, 4, 6, 10, 12, 14, 30, 64, 120, 7680, 1 << 16, 2 * 4099])('matches the naive DFT for n = %i', (n) => {
    const r = rng(n);
    const input = new Float32Array(n).map(() => 2 * r() - 1);
    const zeros = new Float64Array(n);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    new RealFFT(n).forward(input, re, im);
    const bins = n <= 128 ? Array.from({ length: n / 2 + 1 }, (_, k) => k) : spotBins(n / 2 + 1, 24, n);
    expect(binError(re, im, [Float64Array.from(input), zeros], bins)).toBeLessThan(1e-11);
    expect(im[0]).toBe(0);
    expect(Math.abs(im[n / 2]!)).toBeLessThan(1e-12);
  });

  it.each([2, 6, 7680, 1 << 18])('inverse(forward(x)) = x for n = %i', (n) => {
    const r = rng(3 * n);
    const input = new Float64Array(n).map(() => 2 * r() - 1);
    const rfft = new RealFFT(n);
    const re = new Float64Array(rfft.bins);
    const im = new Float64Array(rfft.bins);
    const out = new Float64Array(n);
    rfft.forward(input, re, im);
    rfft.inverse(re, im, out);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(out[i]! - input[i]!));
    expect(err).toBeLessThan(1e-12);
  });

  it('inverse ignores the imaginary parts of the DC and Nyquist bins', () => {
    const n = 16;
    const rfft = new RealFFT(n);
    const re = new Float64Array(9);
    const im = new Float64Array(9);
    re[0] = 16;
    re[8] = 16;
    im[0] = 5;
    im[8] = -3;
    const out = new Float32Array(n);
    rfft.inverse(re, im, out);
    for (let j = 0; j < n; j++) expect(out[j]).toBeCloseTo(1 + (j % 2 === 0 ? 1 : -1), 6);
  });

  it('speed (logged)', () => {
    const report: string[] = [];
    for (const n of [7680, 1 << 16, 1 << 18]) {
      const rfft = new RealFFT(n);
      const input = new Float64Array(n).map((_, i) => Math.sin(i));
      const re = new Float64Array(rfft.bins);
      const im = new Float64Array(rfft.bins);
      const reps = Math.max(1, Math.round(2e6 / n));
      const ms = timeMs(() => {
        for (let r = 0; r < reps; r++) rfft.forward(input, re, im);
      }) / reps;
      report.push(`RealFFT(${n}) forward: ${(ms * 1000).toFixed(1)} µs`);
    }
    console.log(report.join('\n'));
  });
});
