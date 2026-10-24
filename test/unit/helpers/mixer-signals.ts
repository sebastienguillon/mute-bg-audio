// Deterministic test signals and measurements for the MixerCore tests.
import { readFileSync } from 'node:fs';
import type { Media } from './mixer-harness';

/** mulberry32 PRNG returning floats in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** White noise in [−amp, amp). */
export function noise(n: number, amp: number, seed: number): Float32Array {
  const r = prng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * (2 * r() - 1);
  return out;
}

/** Sum of sines (frequencies in Hz at 48 kHz). */
export function tones(n: number, parts: readonly { freq: number; amp: number; phase?: number }[]): Float32Array {
  const out = new Float32Array(n);
  for (const { freq, amp, phase = 0 } of parts) {
    const w = (2 * Math.PI * freq) / 48000;
    for (let i = 0; i < n; i++) out[i]! += amp * Math.sin(w * i + phase);
  }
  return out;
}

/** Smooth stereo media (low-frequency sines) for click measurements. */
export function smoothMedia(n: number): Media {
  return {
    speechL: tones(n, [{ freq: 150, amp: 0.2 }]),
    speechR: tones(n, [{ freq: 150, amp: 0.2, phase: 0.7 }]),
    residualL: tones(n, [
      { freq: 80, amp: 0.15 },
      { freq: 230, amp: 0.1, phase: 1 },
    ]),
    residualR: tones(n, [
      { freq: 95, amp: 0.12 },
      { freq: 260, amp: 0.08, phase: 2 },
    ]),
  };
}

/**
 * smoothMedia whose speech is exactly 0 inside the `pauses` ([from, to) media indices), with
 * 10 ms raised-cosine ramps just outside them (so the media itself has no steps).
 */
export function pausedSmoothMedia(n: number, pauses: readonly [number, number][]): Media {
  const media = smoothMedia(n);
  const ramp = 480;
  const gain = (i: number) => {
    let g = 1;
    for (const [from, to] of pauses) {
      if (i >= from && i < to) return 0;
      const d = i < from ? from - i : i - to + 1;
      if (d <= ramp) g = Math.min(g, 0.5 - 0.5 * Math.cos((Math.PI * d) / ramp));
    }
    return g;
  };
  for (let i = 0; i < n; i++) {
    const g = gain(i);
    media.speechL[i]! *= g;
    media.speechR[i]! *= g;
  }
  return media;
}

/** True when every sample of a[from, to) is finite. */
export function allFinite(a: Float32Array, from = 0, to = a.length): boolean {
  for (let i = from; i < to; i++) if (!Number.isFinite(a[i]!)) return false;
  return true;
}

/**
 * Speech-like stereo media: a voiced harmonic source with syllable envelopes (present where
 * `speechOn(i)`) and a non-repeating stereo music residual (drifting chord + noise), so that two
 * different media positions never match.
 */
export function makeMedia(n: number, seed: number, speechOn: (i: number) => boolean = () => true): Media {
  const r = prng(seed);
  const voice = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f0 = 140 + 30 * Math.sin((2 * Math.PI * i) / 48000 / 1.7);
    phase += (2 * Math.PI * f0) / 48000;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(h * phase) / h;
    const syllable = 0.55 + 0.45 * Math.sin((2 * Math.PI * i) / 9600);
    voice[i] = speechOn(i) ? 0.12 * syllable * v : 0;
  }
  const residualL = new Float32Array(n);
  const residualR = new Float32Array(n);
  const freqs = [110, 164.8, 220, 277.2, 329.6];
  const phases = freqs.map(() => 2 * Math.PI * r());
  const drift = freqs.map(() => 0);
  for (let i = 0; i < n; i++) {
    let l = 0;
    let rr = 0;
    for (let k = 0; k < freqs.length; k++) {
      // Random-walk detuning (±2 %) so that the chord never repeats exactly.
      drift[k] = Math.max(-0.02, Math.min(0.02, drift[k]! + 2e-5 * (2 * r() - 1)));
      phases[k]! += (2 * Math.PI * freqs[k]! * (1 + drift[k]!)) / 48000;
      const s = Math.sin(phases[k]!);
      l += (0.05 - 0.008 * k) * s;
      rr += (0.02 + 0.008 * k) * s;
    }
    residualL[i] = l + 0.02 * (2 * r() - 1);
    residualR[i] = rr + 0.02 * (2 * r() - 1);
  }
  const speechR = new Float32Array(n);
  for (let i = 0; i < n; i++) speechR[i] = 0.9 * voice[i]!;
  return { speechL: voice, speechR, residualL, residualR };
}

/** Element input playing `media` with the media offset `offsetAt(f)` and gain `gainAt(f)`. */
export function playMedia(
  media: Media,
  frames: number,
  offsetAt: (f: number) => number,
  gainAt: (f: number) => number = () => 1,
): [Float32Array, Float32Array] {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const m = f + offsetAt(f);
    const g = gainAt(f);
    l[f] = g * (media.speechL[m]! + media.residualL[m]!);
    r[f] = g * (media.speechR[m]! + media.residualR[m]!);
  }
  return [l, r];
}

/** RMS of a[from, to). */
export function rms(a: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
}

/** Largest |a[i] − a[i−1]| for i in [from, to). */
export function maxStep(a: Float32Array, from: number, to: number): number {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(a[i]! - a[i - 1]!));
  return m;
}

/** Largest |a[i] − expected(i)| for i in [from, to). */
export function maxError(a: Float32Array, from: number, to: number, expected: (i: number) => number): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i]! - expected(i)));
  return m;
}

/** First i in [from, to) with |a[i] − expected(i)| > tol, or -1. */
export function firstMismatch(
  a: Float32Array,
  from: number,
  to: number,
  expected: (i: number) => number,
  tol: number,
): number {
  for (let i = from; i < to; i++) if (Math.abs(a[i]! - expected(i)) > tol) return i;
  return -1;
}

/** Reads a 32-bit float PCM WAV (as written by scripts/make-test-media.mjs). */
export function readWavFloat(path: string): { sampleRate: number; channels: Float32Array[] } {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 12;
  let sampleRate = 0;
  let numChannels = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      if (view.getUint16(body + 14, true) !== 32) throw new Error('expected 32-bit float WAV');
    } else if (id === 'data') {
      const frames = Math.floor(size / (4 * numChannels));
      const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < numChannels; c++) channels[c]![i] = view.getFloat32(body + 4 * (i * numChannels + c), true);
      }
      return { sampleRate, channels };
    }
    pos = body + size + (size & 1);
  }
  throw new Error(`no data chunk in ${path}`);
}
