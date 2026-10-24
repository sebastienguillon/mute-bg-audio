// Test helpers for the DSP / MDX modules: WAV I/O, metrics, deterministic noise.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealFFT } from '../../../src/lib/dsp/fft';
import { cached } from './fixtures';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = join(ROOT, 'test/fixtures/generated');

export interface Wav {
  sampleRate: number;
  channels: Float32Array[];
}

/** Reads a PCM16 or float32 WAV file into planar channels. */
export function readWav(path: string): Wav {
  const b = readFileSync(path);
  let p = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), sampleRate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    } else if (id === 'data') {
      data = b.subarray(p + 8, p + 8 + size);
    }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: not a WAV file`);
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  const float = fmt.format === 3 || (fmt.format === 0xfffe && fmt.bits === 32);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      channels[c]![i] = float ? data.readFloatLE(o) : data.readInt16LE(o) / 32768;
    }
  }
  return { sampleRate: fmt.sampleRate, channels };
}

/** Reads a generated test fixture (made by the global setup). */
export function readFixture(name: string): Wav {
  return readWav(join(FIXTURES, name));
}

/** Decodes any media file to a 48 kHz stereo float WAV with ffmpeg (cached under test/fixtures/generated/<dir>). */
export function decodeWithFfmpeg(input: string, dir: string, name: string): Wav {
  const out = cached(join(FIXTURES, dir, name), (tmp) => {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(FIXTURES, input), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', tmp]);
  });
  return readWav(out);
}

/** Deterministic xorshift32 PRNG returning floats in [0, 1). */
export function rng(seed = 0x12345678): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Uniform white noise in [-amp, amp). */
export function noise(n: number, amp = 1, seed = 1): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (2 * r() - 1);
  return out;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>, start = 0, end = a.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += a[i]! * b[i]!;
  return s;
}

/** Scale-invariant SDR in dB of estimate vs reference over [start, end). */
export function siSdr(estimate: ArrayLike<number>, reference: ArrayLike<number>, start = 0, end = reference.length): number {
  const alpha = dot(estimate, reference, start, end) / dot(reference, reference, start, end);
  let target = 0;
  let err = 0;
  for (let i = start; i < end; i++) {
    const t = alpha * reference[i]!;
    const e = estimate[i]! - t;
    target += t * t;
    err += e * e;
  }
  return 10 * Math.log10(target / err);
}

/** Error energy of a vs b relative to the energy of b, in dB, over [start, end). */
export function errorDb(a: ArrayLike<number>, b: ArrayLike<number>, start = 0, end = b.length): number {
  let err = 0;
  let ref = 0;
  for (let i = start; i < end; i++) {
    const d = a[i]! - b[i]!;
    err += d * d;
    ref += b[i]! * b[i]!;
  }
  return 10 * Math.log10(err / ref);
}

export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>, start = 0, end = Math.min(a.length, b.length)): number {
  let m = 0;
  for (let i = start; i < end; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

export function rms(a: ArrayLike<number>, start = 0, end = a.length): number {
  return Math.sqrt(dot(a, a, start, end) / (end - start));
}

/** Median wall time in ms of `runs` calls of fn (after one warm-up call). */
export function timeMs(fn: () => void, runs = 5): number {
  fn();
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)]!;
}

/** signal[start..end) with zeros outside the array (like a caller filling unavailable audio). */
export function sliceZeroFilled(signal: Float32Array, start: number, end: number): Float32Array {
  const out = new Float32Array(end - start);
  const from = Math.max(0, start);
  const to = Math.min(signal.length, end);
  if (to > from) out.set(signal.subarray(from, to), from - start);
  return out;
}

/**
 * Circular FFT band-pass keeping [lo, hi] Hz with raised-cosine edges `taper` Hz wide.
 * signal.length must be even and 2,3,5-smooth.
 */
export function bandLimit(signal: Float32Array, rate: number, lo: number, hi: number, taper = 20): Float32Array {
  const n = signal.length;
  const rfft = new RealFFT(n);
  const re = new Float64Array(rfft.bins);
  const im = new Float64Array(rfft.bins);
  rfft.forward(signal, re, im);
  for (let k = 0; k < rfft.bins; k++) {
    const f = (k * rate) / n;
    let g = 1;
    if (f < lo - taper || f > hi + taper) g = 0;
    else if (f < lo) g = 0.5 - 0.5 * Math.cos((Math.PI * (f - lo + taper)) / taper);
    else if (f > hi) g = 0.5 + 0.5 * Math.cos((Math.PI * (f - hi)) / taper);
    re[k] = re[k]! * g;
    im[k] = im[k]! * g;
  }
  const out = new Float32Array(n);
  rfft.inverse(re, im, out);
  return out;
}

/** Applies raised-cosine fades of `fade` samples at both ends, in place. */
export function fadeEnds(signal: Float32Array, fade: number): Float32Array {
  const n = signal.length;
  for (let i = 0; i < fade; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    signal[i] = signal[i]! * g;
    signal[n - 1 - i] = signal[n - 1 - i]! * g;
  }
  return signal;
}
