import { describe, expect, it } from 'vitest';
import {
  resampleInputRange,
  resampleMargin,
  resampleOutputEnd,
  resampleRange,
} from '../../src/lib/dsp/resample';
import { maxAbsDiff, noise, rng } from './helpers/dsp-audio';

function sine(n: number, rate: number, freq: number, start = 0, amp = 1, phase = 0): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * (start + i)) / rate + phase);
  return out;
}

/** Amplitude of the component at `freq` (least squares fit of a sine and a cosine). */
function toneAmplitude(x: Float32Array, rate: number, freq: number, from: number, to: number): number {
  let xs = 0;
  let xc = 0;
  let ss = 0;
  let cc = 0;
  let sc = 0;
  for (let i = from; i < to; i++) {
    const a = (2 * Math.PI * freq * i) / rate;
    const s = Math.sin(a);
    const c = Math.cos(a);
    xs += x[i]! * s;
    xc += x[i]! * c;
    ss += s * s;
    cc += c * c;
    sc += s * c;
  }
  const det = ss * cc - sc * sc;
  return Math.hypot((xs * cc - xc * sc) / det, (xc * ss - xs * sc) / det);
}

function snrDb(estimate: Float32Array, reference: Float32Array, from: number, to: number): number {
  let e = 0;
  let r = 0;
  for (let i = from; i < to; i++) {
    e += (estimate[i]! - reference[i]!) ** 2;
    r += reference[i]! ** 2;
  }
  return 10 * Math.log10(r / e);
}

describe('resampleRange', () => {
  it('48 kHz -> 44.1 kHz matches the analytic sine at the output instants (zero phase)', () => {
    const x = sine(48000, 48000, 1000, 0, 0.8, 0.3);
    const y = resampleRange(x, 0, 48000, 44100, 0, 44100);
    const ref = sine(44100, 44100, 1000, 0, 0.8, 0.3);
    expect(snrDb(y, ref, 500, 43600)).toBeGreaterThan(95);
  });

  it('1 kHz sine 48 kHz -> 44.1 kHz -> 48 kHz keeps SNR > 80 dB', () => {
    const x = sine(96000, 48000, 1000, 0, 0.9);
    const y = resampleRange(x, 0, 48000, 44100, 0, 88200);
    const z = resampleRange(y, 0, 44100, 48000, 0, 96000);
    const snr = snrDb(z, x, 1000, 95000);
    console.log(`1 kHz round trip 48k->44.1k->48k SNR: ${snr.toFixed(1)} dB`);
    expect(snr).toBeGreaterThan(80);
  });

  it.each([
    [48000, 44100],
    [44100, 48000],
  ])('passband %i -> %i is flat to 0.9 x lower Nyquist', (from, to) => {
    const edge = 0.9 * (Math.min(from, to) / 2);
    for (const f of [50, 1000, 10000, 17640, edge]) {
      const x = sine(from / 2, from, f, 0, 1);
      const y = resampleRange(x, 0, from, to, 0, to / 2);
      const gain = toneAmplitude(y, to, f, 400, to / 2 - 400);
      expect(Math.abs(gain - 1)).toBeLessThan(2e-4);
    }
  });

  it('48 kHz -> 44.1 kHz rejects everything above 22.05 kHz by more than 90 dB (no aliasing)', () => {
    let worst = -Infinity;
    for (const f of [22100, 22500, 23000, 23500, 23990]) {
      const x = sine(48000, 48000, f, 0, 1);
      const y = resampleRange(x, 0, 48000, 44100, 0, 44100);
      // Whatever leaks through appears at the alias frequency 44100 - f.
      let energy = 0;
      for (let i = 400; i < 43700; i++) energy += y[i]! * y[i]!;
      const level = 10 * Math.log10(energy / (43300 * 0.5));
      worst = Math.max(worst, level);
    }
    console.log(`48k->44.1k worst stopband leakage: ${worst.toFixed(1)} dB`);
    expect(worst).toBeLessThan(-90);
  });

  it('44.1 kHz -> 48 kHz suppresses images by more than 90 dB', () => {
    let worst = -Infinity;
    for (const f of [1000, 15000, 20000, 21500]) {
      const x = sine(44100, 44100, f, 0, 1);
      const y = resampleRange(x, 0, 44100, 48000, 0, 48000);
      const image = 44100 - f;
      if (image >= 24000) continue;
      worst = Math.max(worst, 20 * Math.log10(toneAmplitude(y, 48000, image, 400, 47600)));
    }
    console.log(`44.1k->48k worst image: ${worst.toFixed(1)} dB`);
    expect(worst).toBeLessThan(-90);
  });

  it('non-rational ratios use interpolated phases with high accuracy', () => {
    const x = sine(48000, 48000, 3000, 0, 0.7);
    const y = resampleRange(x, 0, 48000, 44101, 0, 44101);
    expect(snrDb(y, sine(44101, 44101, 3000, 0, 0.7), 500, 43600)).toBeGreaterThan(85);
  });

  it('equal rates copy with zero fill', () => {
    const x = Float32Array.from([1, 2, 3]);
    expect(Array.from(resampleRange(x, 10, 48000, 48000, 9, 5))).toEqual([0, 1, 2, 3, 0]);
    expect(resampleMargin(48000, 48000)).toBe(0);
  });

  it.each([
    [48000, 44100],
    [44100, 48000],
    [48000, 44101],
  ])('blocks with margins concatenate to the single-block result (%i -> %i)', (from, to) => {
    const inputStart = -1234;
    const signal = noise(3 * from, 0.5, from + to);
    const outStart = Math.ceil((inputStart * to) / from) + 200;
    const total = 2 * to;
    const whole = resampleRange(signal, inputStart, from, to, outStart, total);
    const r = rng(5);
    const joined = new Float32Array(total);
    for (let k = 0; k < total; ) {
      const len = Math.min(total - k, 1 + Math.floor(r() * 9000));
      const { start, end } = resampleInputRange(from, to, outStart + k, len);
      const block = signal.slice(start - inputStart, end - inputStart);
      joined.set(resampleRange(block, start, from, to, outStart + k, len), k);
      k += len;
    }
    expect(maxAbsDiff(joined, whole)).toBeLessThan(1e-6);
  });

  it('resampleOutputEnd and resampleInputRange are consistent', () => {
    for (const [from, to] of [
      [48000, 44100],
      [44100, 48000],
    ] as const) {
      const margin = resampleMargin(from, to);
      for (const inputEnd of [-50, 0, 1, 1000, 123457]) {
        const end = resampleOutputEnd(from, to, inputEnd);
        expect(resampleInputRange(from, to, end - 1, 1).end).toBeLessThanOrEqual(inputEnd);
        expect(resampleInputRange(from, to, end, 1).end).toBeGreaterThan(inputEnd);
        const range = resampleInputRange(from, to, end - 1, 1);
        expect(range.end - range.start).toBe(2 * margin);
      }
    }
  });

  // Target >= 100x real time (measured ~150x on an M4 Max); the assertion leaves room for a loaded machine.
  it('speed: stereo 48 kHz -> 44.1 kHz and back (logged)', () => {
    const seconds = 20;
    const left = noise(48000 * seconds, 0.5, 1);
    const right = noise(48000 * seconds, 0.5, 2);
    const out = new Float32Array(44100 * seconds);
    const back = new Float32Array(48000 * seconds);
    resampleRange(left, 0, 48000, 44100, 0, 44100);
    // Best of 3: the other test files run in parallel and can steal the CPU for a while.
    let down = Infinity;
    let up = Infinity;
    for (let run = 0; run < 3; run++) {
      let t = performance.now();
      resampleRange(left, 0, 48000, 44100, 0, out.length, out);
      resampleRange(right, 0, 48000, 44100, 0, out.length, out);
      down = Math.min(down, performance.now() - t);
      t = performance.now();
      resampleRange(out, 0, 44100, 48000, 0, back.length, back);
      resampleRange(out, 0, 44100, 48000, 0, back.length, back);
      up = Math.min(up, performance.now() - t);
    }
    const downX = (seconds * 1000) / down;
    const upX = (seconds * 1000) / up;
    console.log(
      `stereo 48k->44.1k: ${downX.toFixed(0)}x real time (taps ${2 * resampleMargin(48000, 44100)}); ` +
        `stereo 44.1k->48k: ${upX.toFixed(0)}x (taps ${2 * resampleMargin(44100, 48000)})`,
    );
    expect(downX).toBeGreaterThan(50);
  });
});
