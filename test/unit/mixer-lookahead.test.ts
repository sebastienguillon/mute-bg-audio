import { describe, expect, it } from 'vitest';
import { DEFAULT_LATENCY, QUANTUM } from '../../src/lib/constants';
import { FakeLookahead, FakeRealtime, type Media, MixerHarness, SR } from './helpers/mixer-harness';
import {
  allFinite,
  firstMismatch,
  makeMedia,
  maxError,
  maxStep,
  pausedSmoothMedia,
  playMedia,
} from './helpers/mixer-signals';

const L = DEFAULT_LATENCY;
const G = 0.3;
const FADE = 480;

interface Scenario {
  h: MixerHarness;
  la: FakeLookahead;
  rt: FakeRealtime;
  media: Media;
  inL: Float32Array;
  inR: Float32Array;
}

interface ScenarioOptions {
  gainAt?: (f: number) => number;
  /** Offset answered by the probes (default: the true one). */
  laOffsetAt?: (frameEnd: number) => number | null;
  /** MixerConfig.outputLatency (D). */
  outputLatency?: number;
  media?: Media;
  gapReduction?: boolean;
}

/**
 * Element playing `media` with `offsetAt`/`gainAt`; real-time worker answering speech = 0 (so its
 * output is g·x, easy to tell apart); look-ahead worker holding all blocks of the media.
 */
function scenario(frames: number, offsetAt: (f: number) => number, opts: ScenarioOptions = {}): Scenario {
  const media = opts.media ?? makeMedia(14 * SR, 42);
  const [inL, inR] = playMedia(media, frames, offsetAt, opts.gainAt);
  const h = new MixerHarness(inL, inR);
  const rt = new FakeRealtime(h, 'zero');
  const la = new FakeLookahead(h, media, 1, opts.laOffsetAt ?? offsetAt);
  h.connectRt(rt);
  h.connectLa(la);
  la.sendBlocks(0, media.speechL.length, 12345);
  h.config({
    residualGain: G,
    lookahead: true,
    outputLatency: opts.outputLatency ?? 0,
    gapReduction: opts.gapReduction ?? false,
  });
  return { h, la, rt, media, inL, inR };
}

/** Expected look-ahead output at output frame f: media index f + offset + D, element gain v. */
function laOut(media: Media, c: 0 | 1, offset: number, v: number, d = 0): (f: number) => number {
  const s = c === 0 ? media.speechL : media.speechR;
  const r = c === 0 ? media.residualL : media.residualR;
  return (f) => {
    const m = f + offset + d;
    return v * (s[m]! + G * r[m]!);
  };
}

/** Expected real-time output (speech = 0): g·x[f − L]. */
function rtOut(x: Float32Array): (f: number) => number {
  return (f) => Math.fround(G * x[f - L]!);
}

const zero = () => 0;

/**
 * Start of the crossfade from real-time to look-ahead output: the first frame in [from, to) that
 * is not real-time output (speech = 0) any more.
 */
function laStart(h: MixerHarness, inL: Float32Array, from: number, to: number): number {
  return firstMismatch(h.outL, from, to, rtOut(inL), 1e-6);
}

/** Start of the first run of 64 exact zeros in a[from…). */
function silenceFrom(a: Float32Array, from: number): number {
  let run = 0;
  for (let i = from; i < a.length; i++) {
    run = a[i] === 0 ? run + 1 : 0;
    if (run === 64) return i - 63;
  }
  return -1;
}

describe('MixerCore look-ahead path', () => {
  for (const d of [0, 2400]) {
    it(`locks and outputs v·(s + g·r) at media index f + offset + outputLatency (D = ${d})`, () => {
      const off = 2 * SR + 77;
      const { h, la, media, inL } = scenario(4 * SR, () => off, { outputLatency: d });
      h.runUntil(4 * SR);
      expect(la.probes).toBe(1);
      expect(h.core.lockState).toBe('locked');
      // Real-time until the lock (first probe at 4096 frames + 10 verified quanta) and then until
      // the planned switch: this speech has no pause, so the quietest moment within 1.5 s. Then a
      // crossfaded jump forward by L + D.
      const switchAt = laStart(h, inL, L + FADE, 4 * SR);
      expect(switchAt).toBeGreaterThanOrEqual(4096 + 10 * QUANTUM);
      expect(switchAt).toBeLessThan(4096 + 11 * QUANTUM + 1.5 * SR);
      expect(maxError(h.outL, switchAt + FADE, 4 * SR, laOut(media, 0, off, 1, d))).toBeLessThan(1e-5);
      expect(maxError(h.outR, switchAt + FADE, 4 * SR, laOut(media, 1, off, 1, d))).toBeLessThan(1e-5);
      const last = h.stats().at(-1)!;
      // In sync with the picture: no added latency is reported.
      expect(last).toMatchObject({ mode: 'lookahead', locked: true, latency: 0, underruns: 0, rtHealthy: true });
      // Stored ahead of the read position f + offset + D (stats are posted every 0.5 s).
      const ahead = 14 - (h.frame + off + d) / SR;
      expect(last.laAhead).toBeGreaterThan(ahead);
      expect(last.laAhead).toBeLessThan(ahead + 0.51);
    });
  }

  it('switches to real-time on a seek without output from the old position beyond the crossfade, then re-locks', () => {
    const d = 2400;
    const off1 = 2 * SR + 77;
    const off2 = -SR + 501;
    const seek = 4 * SR + 64; // mid-quantum
    const seekQuantum = seek - 64;
    const offsetAt = (f: number) => (f < seek ? off1 : off2);
    const { h, la, media, inL } = scenario(8 * SR, offsetAt, { outputLatency: d });

    h.runUntil(seek);
    expect(h.core.lockState).toBe('locked');
    expect(la.probes).toBe(1);
    h.runUntil(8 * SR);

    // Look-ahead output (leading by D) until the first bad input quantum: the one with the seek,
    // or the next one when the matching half of the seek quantum let it pass.
    const first = laStart(h, inL, L + FADE, seek);
    expect(first).toBeLessThan(2 * SR);
    expect(maxError(h.outL, first + FADE, seekQuantum, laOut(media, 0, off1, 1, d))).toBeLessThan(1e-5);
    const detected = silenceFrom(h.outL, seekQuantum) - FADE;
    expect([seekQuantum, seekQuantum + QUANTUM]).toContain(detected);
    expect(maxError(h.outL, seekQuantum, detected, laOut(media, 0, off1, 1, d))).toBeLessThan(1e-2);
    // After the 10 ms fade-out nothing from the old position: the delayed input before the seek
    // was already heard through look-ahead, so silence until real-time reaches the seek…
    expect(maxError(h.outL, detected + FADE, detected + L, zero)).toBe(0);
    expect(maxError(h.outR, detected + FADE, detected + L, zero)).toBe(0);
    // …then real-time output of the new position (after the fade-in) until the new lock…
    const rtFrom = detected + L + FADE;
    expect(maxError(h.outL, rtFrom, seek + 4096, rtOut(inL))).toBe(0);
    expect(la.probes).toBe(2);
    expect(h.core.lockState).toBe('locked');
    // …which waits for a probe window entirely after the seek and 10 verified quanta, then for
    // the planned switch (at most 1.5 s).
    const relock = laStart(h, inL, rtFrom, 8 * SR);
    expect(relock).toBeGreaterThanOrEqual(seekQuantum + 4096);
    expect(relock).toBeLessThan(seekQuantum + 4096 + 20 * QUANTUM + 1.5 * SR);
    expect(maxError(h.outL, relock + FADE, 8 * SR, laOut(media, 0, off2, 1, d))).toBeLessThan(1e-5);
    expect(maxError(h.outR, relock + FADE, 8 * SR, laOut(media, 1, off2, 1, d))).toBeLessThan(1e-5);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'lookahead', locked: true, underruns: 0 });
  });

  it('applies large outputLatency changes at speech-free moments, small ones at once (silence instead of repeats)', () => {
    const off = SR / 3;
    // Speech pauses of 0.4 s at media [k + 0.5 s, k + 0.9 s).
    const pauses = Array.from({ length: 12 }, (_, k): [number, number] => [(k + 0.5) * SR, (k + 0.9) * SR]);
    const media = pausedSmoothMedia(12 * SR, pauses);
    const { h } = scenario(9.5 * SR, () => off, { outputLatency: 1200, media });
    const set = (outputLatency: number) => h.config({ residualGain: G, lookahead: true, outputLatency });
    /** Largest |speech| of media [from, to): at most −20 dB of the speech (0.2) counts as none. */
    const speechPeak = (from: number, to: number) => maxError(media.speechL, from, to, zero);
    h.runUntil(2 * SR);
    expect(h.core.lockState).toBe('locked');
    expect(maxError(h.outL, 1.5 * SR, 2 * SR, laOut(media, 0, off, 1, 1200))).toBeLessThan(1e-5);

    // +75 ms: a jump forward, which skips the media [f + off + 1200, f + off + 4800): at the
    // first moment where that holds no speech, i.e. where the pause at 2.5 s begins.
    const t1 = h.frame;
    set(4800);
    h.runUntil(4 * SR);
    const jump = firstMismatch(h.outL, t1, 4 * SR, laOut(media, 0, off, 1, 1200), 1e-5);
    expect(jump).toBeGreaterThan(2.5 * SR - off - 1200 - 4 * 32);
    expect(jump).toBeLessThan(2.5 * SR - off - 1200 + 4 * 32);
    expect(speechPeak(jump + off + 1200 - 4, jump + off + 4800)).toBeLessThan(0.02);
    expect(maxError(h.outL, jump + FADE, 4 * SR, laOut(media, 0, off, 1, 4800))).toBeLessThan(1e-5);

    // −62.5 ms: that content was already heard, so fade out, silence, fade in, where the
    // content around the cut (f + off + 4800) holds no speech (the pause at 4.5 s).
    const t2 = h.frame;
    set(1800);
    h.runUntil(5.5 * SR);
    const cut = silenceFrom(h.outL, t2) - FADE;
    expect(maxError(h.outL, t2, cut, laOut(media, 0, off, 1, 4800))).toBeLessThan(1e-5);
    expect(cut).toBeGreaterThan(4.5 * SR - off - 4800);
    expect(cut).toBeLessThan(4.5 * SR - off - 4800 + 0.1 * SR);
    expect(speechPeak(cut + off + 4800 - FADE, cut + off + 4800 + FADE)).toBeLessThan(0.02);
    expect(maxError(h.outL, cut + FADE, cut + 3000, zero)).toBe(0);
    expect(maxError(h.outL, cut + 3000 + FADE, 5.5 * SR, laOut(media, 0, off, 1, 1800))).toBeLessThan(1e-5);

    // Steps of at most 50 ms are applied at once: +31 ms, a crossfaded jump forward…
    const t3 = h.frame;
    set(3300);
    h.runUntil(6 * SR);
    expect(maxError(h.outL, t3 + FADE, 6 * SR, laOut(media, 0, off, 1, 3300))).toBeLessThan(1e-5);
    // …−31 ms: fade out, 31 ms of silence, fade in…
    const t4 = h.frame;
    set(1800);
    h.runUntil(6.5 * SR);
    expect(maxError(h.outL, t4 + FADE, t4 + 1500, zero)).toBe(0);
    expect(maxError(h.outL, t4 + 1500 + FADE, 6.5 * SR, laOut(media, 0, off, 1, 1800))).toBeLessThan(1e-5);
    // …and a step within one crossfade is simply crossfaded.
    const t5 = h.frame;
    set(1600);
    h.runUntil(7 * SR);
    expect(maxError(h.outL, t5 + FADE, 7 * SR, laOut(media, 0, off, 1, 1600))).toBeLessThan(1e-5);

    // Clamped to 1 s: no pause is that long, so the quietest moment within 1.5 s.
    const t6 = h.frame;
    set(1e9);
    h.runUntil(9.5 * SR);
    const far = firstMismatch(h.outL, t6, 9.5 * SR, laOut(media, 0, off, 1, 1600), 1e-5);
    expect(far).toBeLessThan(t6 + 1.5 * SR + QUANTUM);
    expect(maxError(h.outL, far + FADE, 9.5 * SR, laOut(media, 0, off, 1, SR))).toBeLessThan(1e-5);
    expect(h.core.lockState).toBe('locked');
    expect(h.stats().at(-1)!.underruns).toBe(0);
    // A hard switch would step by up to ~0.5 here.
    expect(maxStep(h.outL, SR, 9.5 * SR)).toBeLessThan(0.015);
    expect(maxStep(h.outR, SR, 9.5 * SR)).toBeLessThan(0.015);
  });

  it('measures the element gain (input scaled by 0.5 → v ≈ 0.5) and tracks volume changes', () => {
    const off = SR + 999;
    const gainAt = (f: number) => (f < 3 * SR ? 0.5 : 0.4);
    const { h, la, media, inL } = scenario(5 * SR, () => off, { gainAt });
    la.gainError = 1.1; // the probe's estimate is 10 % off; verification refines it
    h.runUntil(5 * SR);
    expect(la.probes).toBe(1);
    expect(h.core.lockState).toBe('locked');
    const switchAt = laStart(h, inL, L + FADE, 2 * SR);
    expect(switchAt).toBeGreaterThan(0);
    expect(maxError(h.outL, switchAt + FADE, 3 * SR, laOut(media, 0, off, 0.5))).toBeLessThan(1e-5);
    // −2 dB volume change: still verified, v follows within ~0.5 s.
    expect(maxError(h.outL, 4 * SR, 5 * SR, laOut(media, 0, off, 0.4))).toBeLessThan(1e-4);
  });

  it('unlocks when the element pauses, idles without probing, and re-locks after resuming', () => {
    const off = SR + 5;
    const pause = 2 * SR + 200; // mid-quantum
    const pauseQuantum = pause - 72;
    const resume = 3 * SR;
    const pausedFor = resume - pause;
    // While paused the media position stands still; afterwards the offset is smaller.
    const offsetAt = (f: number) => (f < pause ? off : off - pausedFor);
    const gainAt = (f: number) => (f >= pause && f < resume ? 0 : 1);
    const { h, la, rt, media, inL } = scenario(5.5 * SR, offsetAt, { gainAt });
    h.runUntil(pause + 12 * QUANTUM);
    expect(h.core.lockState).toBe('unlocked');
    h.runUntil(resume);
    const first = laStart(h, inL, L + FADE, pause);
    expect(first).toBeLessThan(2 * SR);
    expect(maxError(h.outL, first + FADE, pauseQuantum, laOut(media, 0, off, 1))).toBeLessThan(1e-5);
    const detected = silenceFrom(h.outL, pauseQuantum) - FADE;
    expect([pauseQuantum, pauseQuantum + QUANTUM]).toContain(detected);
    // Silence from the fade-out on: the delayed input before the pause was already heard. (Only
    // the start of the pause quantum, which look-ahead did not play, returns within a fade-in.)
    expect(maxError(h.outL, detected + FADE, detected + L, zero)).toBe(0);
    expect(maxError(h.outL, detected + L + FADE, resume + L, zero)).toBe(0);
    expect(la.probes).toBe(1);
    // Idle 0.5 s after the input became digital silence: no hops.
    const idleFrom = pauseQuantum + QUANTUM + SR / 2;
    expect(rt.hopIndices.filter((i) => i >= idleFrom + QUANTUM)).toEqual([]);
    h.runUntil(5.5 * SR);
    expect(h.stats().map((st) => st.mode)).toContain('idle');
    // A new real-time session starts with the first quantum of sound.
    expect(rt.resets).toBe(2);
    expect(rt.hopIndices.find((i) => i >= idleFrom)).toBe(resume);
    expect(maxError(h.outL, resume + L + FADE, resume + 4096, rtOut(inL))).toBe(0);
    expect(la.probes).toBe(2);
    expect(h.core.lockState).toBe('locked');
    const relock = laStart(h, inL, resume + L + FADE, 5.5 * SR);
    expect(relock).toBeLessThan(resume + 4096 + 20 * QUANTUM + 1.5 * SR);
    expect(maxError(h.outL, relock + FADE, 5.5 * SR, laOut(media, 0, off - pausedFor, 1))).toBeLessThan(1e-5);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'lookahead', underruns: 0 });
    expect(h.core.latency).toBe(L);
  });

  it('does not use look-ahead output once the newest input quantum is bad', () => {
    const off = SR / 2 + 3;
    const glitch = 2 * SR; // quantum-aligned, 7 quanta (< 8: the lock is kept)
    const glitchEnd = glitch + 7 * QUANTUM;
    const { h, la, media, inL } = scenario(3 * SR, () => off);
    // A different signal for 7 quanta (e.g. a notification sound mixed in by the page).
    for (let f = glitch; f < glitchEnd; f++) inL[f] = 0.3 * Math.sin(f / 7);
    h.runUntil(3 * SR);
    expect(h.core.lockState).toBe('locked');
    expect(la.probes).toBe(1);
    const first = laStart(h, inL, L + FADE, glitch);
    expect(first).toBeLessThan(1.7 * SR);
    expect(maxError(h.outL, first + FADE, glitch, laOut(media, 0, off, 1))).toBeLessThan(1e-5);
    // Look-ahead output stops with the first bad quantum (it leads the input, so later verdicts
    // cannot vouch for it); the delayed input before the glitch was already heard.
    expect(maxError(h.outL, glitch + FADE, glitchEnd, zero)).toBe(0);
    expect(maxError(h.outL, glitchEnd + FADE, 3 * SR, laOut(media, 0, off, 1))).toBeLessThan(1e-5);
    expect(maxError(h.outL, glitch, 3 * SR, rtOut(inL))).toBeGreaterThan(0.01);
  });

  it('verifies at the sub-frame delay of the input: treble transients half a frame off keep the output, a seek still stops it', () => {
    // Chrome resamples the element's audio when the output device runs at another rate (e.g.
    // 44.1 kHz): the input then lies a fraction of a frame from the media. Here half a frame, with
    // 1 ms bursts at 9-13 kHz (a hi-hat) every 0.1 s: at whole frames each burst fails MATCH_RATIO.
    const frac = 0.5;
    const off = SR + 333;
    const off2 = -SR / 2 + 101;
    const seek = 4 * SR + 64; // mid-quantum
    const seekQuantum = seek - 64;
    const frames = 7 * SR;
    const d = 2400;
    const speech = (t: number, c: number) => {
      let s = 0;
      for (let k = 1; k <= 6; k++) s += Math.sin((2 * Math.PI * 150 * k * t) / SR + c * k) / k;
      return 0.08 * s;
    };
    const residual = (t: number, c: number) => {
      let r = 0.05 * Math.sin((2 * Math.PI * 220 * t) / SR + c) + 0.04 * Math.sin((2 * Math.PI * 330 * t) / SR + 2 * c);
      const k = Math.round(t / 4800);
      const u = t - k * 4800;
      if (Math.abs(u) < 200) r += 0.3 * Math.exp(-((u / 48) ** 2)) * Math.sin((2 * Math.PI * (9000 + 400 * (k % 11)) * u) / SR + c);
      return r;
    };
    const n = 14 * SR;
    const media: Media = {
      speechL: Float32Array.from({ length: n }, (_, m) => speech(m, 0)),
      speechR: Float32Array.from({ length: n }, (_, m) => speech(m, 0.6)),
      residualL: Float32Array.from({ length: n }, (_, m) => residual(m, 0)),
      residualR: Float32Array.from({ length: n }, (_, m) => residual(m, 1.3)),
    };
    const offsetAt = (f: number) => (f < seek ? off : off2);
    const at = (f: number, c: number) => {
      const t = f + offsetAt(f) + frac;
      return speech(t, c === 0 ? 0 : 0.6) + residual(t, c === 0 ? 0 : 1.3);
    };
    const inL = Float32Array.from({ length: frames }, (_, f) => at(f, 0));
    const inR = Float32Array.from({ length: frames }, (_, f) => at(f, 1));
    const h = new MixerHarness(inL, inR);
    const rt = new FakeRealtime(h, 'zero');
    const la = new FakeLookahead(h, media, 1, offsetAt);
    h.connectRt(rt);
    h.connectLa(la);
    la.sendBlocks(0, n, 12345);
    h.config({ residualGain: G, lookahead: true, outputLatency: d, gapReduction: false });
    h.runUntil(frames);
    expect(la.probes).toBe(2);
    expect(h.core.lockState).toBe('locked');
    // Look-ahead output from the planned switch to the seek quantum, without a single dropout (a
    // hold for one bad quantum dips the output by the whole signal, about 0.1).
    const first = laStart(h, inL, L + FADE, seek);
    expect(first).toBeLessThan(2 * SR);
    expect(maxError(h.outL, first + FADE, seekQuantum, laOut(media, 0, off, 1, d))).toBeLessThan(5e-3);
    expect(maxError(h.outR, first + FADE, seekQuantum, laOut(media, 1, off, 1, d))).toBeLessThan(5e-3);
    // The seek stops look-ahead output at once (the seek quantum or the next), as at whole frames…
    const detected = silenceFrom(h.outL, seekQuantum) - FADE;
    expect([seekQuantum, seekQuantum + QUANTUM]).toContain(detected);
    expect(maxError(h.outL, detected + FADE, detected + L, zero)).toBe(0);
    // …and the new lock outputs the new position through the bursts again.
    const relock = laStart(h, inL, detected + L + FADE, frames);
    expect(relock).toBeLessThan(seekQuantum + 4096 + 20 * QUANTUM + 1.5 * SR);
    expect(maxError(h.outL, relock + FADE, frames, laOut(media, 0, off2, 1, d))).toBeLessThan(5e-3);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'lookahead', locked: true, underruns: 0 });
  });

  it('follows a sub-frame delay that drifts past whole frames: the integer offset moves with it, without a dropout', () => {
    // The fraction drifts in real playback (about a frame per half hour); here 2 frames in 6 s,
    // over the same treble bursts as above.
    const off = SR + 333;
    const frames = 6 * SR;
    const d = 2400;
    const drift = (f: number) => (2 * f) / frames;
    const speech = (t: number, c: number) => {
      let s = 0;
      for (let k = 1; k <= 6; k++) s += Math.sin((2 * Math.PI * 150 * k * t) / SR + c * k) / k;
      return 0.08 * s;
    };
    const residual = (t: number, c: number) => {
      let r = 0.05 * Math.sin((2 * Math.PI * 220 * t) / SR + c) + 0.04 * Math.sin((2 * Math.PI * 330 * t) / SR + 2 * c);
      const k = Math.round(t / 4800);
      const u = t - k * 4800;
      if (Math.abs(u) < 200) r += 0.3 * Math.exp(-((u / 48) ** 2)) * Math.sin((2 * Math.PI * (9000 + 400 * (k % 11)) * u) / SR + c);
      return r;
    };
    const n = 9 * SR;
    const media: Media = {
      speechL: Float32Array.from({ length: n }, (_, m) => speech(m, 0)),
      speechR: Float32Array.from({ length: n }, (_, m) => speech(m, 0.6)),
      residualL: Float32Array.from({ length: n }, (_, m) => residual(m, 0)),
      residualR: Float32Array.from({ length: n }, (_, m) => residual(m, 1.3)),
    };
    const at = (f: number, c: number) => {
      const t = f + off + drift(f);
      return speech(t, c === 0 ? 0 : 0.6) + residual(t, c === 0 ? 0 : 1.3);
    };
    const inL = Float32Array.from({ length: frames }, (_, f) => at(f, 0));
    const inR = Float32Array.from({ length: frames }, (_, f) => at(f, 1));
    const h = new MixerHarness(inL, inR);
    const rt = new FakeRealtime(h, 'zero');
    const la = new FakeLookahead(h, media, 1, () => off);
    h.connectRt(rt);
    h.connectLa(la);
    la.sendBlocks(0, n, 12345);
    h.config({ residualGain: G, lookahead: true, outputLatency: d, gapReduction: false });
    h.runUntil(frames);
    // One lock for the whole run, and no hold (a hold outputs exact zeros for a quantum or more).
    expect(la.probes).toBe(1);
    const first = laStart(h, inL, L + FADE, frames);
    expect(first).toBeLessThan(2 * SR);
    expect(silenceFrom(h.outL, first + FADE)).toBe(-1);
    // At the end the delay is 2 frames, and the output reads the media 2 frames further on.
    expect(maxError(h.outL, frames - SR / 2, frames, laOut(media, 0, off + 2, 1, d))).toBeLessThan(5e-3);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'lookahead', locked: true, underruns: 0 });
  });

  it('falls back to real-time at once on a flush, and at a planned moment when look-ahead is turned off', () => {
    const off = SR / 2 + 11;
    const { h, la, media, inL } = scenario(7 * SR, () => off);
    h.runUntil(2 * SR);
    expect(h.core.lockState).toBe('locked');
    const first = laStart(h, inL, L + FADE, 2 * SR);
    expect(maxError(h.outL, first + FADE, 2 * SR, laOut(media, 0, off, 1))).toBeLessThan(1e-5);
    const flushAt = h.frame;
    h.core.onLa({ type: 'flush', timelineId: 1 });
    expect(h.core.lockState).toBe('unlocked');
    h.runUntil(3 * SR);
    // No blocks left: reflected fade-out, silence until real-time output reaches content that
    // look-ahead did not already play, then real-time output.
    expect(maxError(h.outL, flushAt + FADE, flushAt + L, zero)).toBe(0);
    expect(maxError(h.outL, flushAt + L + FADE, 3 * SR, rtOut(inL))).toBe(0);
    expect(la.probes).toBe(1); // no blocks → no probes

    la.sendBlocks(0, 14 * SR, SR);
    h.runUntil(5 * SR);
    expect(h.core.lockState).toBe('locked');
    const relock = laStart(h, inL, 3 * SR, 5 * SR);
    expect(maxError(h.outL, relock + FADE, 5 * SR, laOut(media, 0, off, 1))).toBeLessThan(1e-5);
    const offAt = h.frame;
    h.config({ residualGain: G, lookahead: false });
    // Not urgent: look-ahead output goes on until a planned moment (within 1.5 s)…
    expect(h.core.lockState).toBe('locked');
    h.runUntil(7 * SR);
    expect(h.core.lockState).toBe('unlocked');
    const leave = silenceFrom(h.outL, offAt) - FADE;
    expect(leave).toBeGreaterThan(offAt);
    expect(leave).toBeLessThan(offAt + 1.5 * SR + QUANTUM);
    expect(maxError(h.outL, offAt, leave, laOut(media, 0, off, 1))).toBeLessThan(1e-5);
    // …then silence until real-time output reaches content not heard yet (L), and real-time output.
    expect(maxError(h.outL, leave + FADE, leave + L, zero)).toBe(0);
    expect(maxError(h.outL, leave + L + FADE, 7 * SR, rtOut(inL))).toBe(0);
    expect(la.probes).toBe(2);
  });

  it('falls back to real-time when the blocks run out and re-locks when more arrive', () => {
    const off = SR / 2;
    const media = makeMedia(9 * SR, 21);
    const [inL, inR] = playMedia(media, 7.5 * SR, () => off);
    const h = new MixerHarness(inL, inR);
    h.connectRt(new FakeRealtime(h, 'zero'));
    const la = new FakeLookahead(h, media, 1, () => off);
    h.connectLa(la);
    la.sendBlocks(0, 3 * SR, SR / 2); // covers input frames up to 2.5 s
    h.config({ residualGain: G, lookahead: true });
    h.runUntil(2 * SR);
    expect(h.core.lockState).toBe('locked');
    const aheadNow = (3 * SR - (h.frame + off)) / SR;
    expect(h.stats().at(-1)!.laAhead).toBeGreaterThan(aheadNow);
    expect(h.stats().at(-1)!.laAhead).toBeLessThan(aheadNow + 0.51);
    h.runUntil(4 * SR);
    // Unlocked 0.5 s after the input ran past the stored blocks.
    expect(h.core.lockState).not.toBe('locked');
    // The quantum only partly covered by blocks is not verified: no look-ahead from its start.
    const end = Math.floor((2.5 * SR) / QUANTUM) * QUANTUM;
    const first = laStart(h, inL, L + FADE, end);
    expect(first).toBeLessThan(2 * SR);
    expect(maxError(h.outL, first + FADE, end, laOut(media, 0, off, 1))).toBeLessThan(1e-5);
    expect(maxError(h.outL, end + FADE, end + L, zero)).toBe(0);
    expect(maxError(h.outL, end + L + FADE, 4 * SR, rtOut(inL))).toBe(0);
    la.sendBlocks(3 * SR, 9 * SR, SR / 2);
    h.runUntil(7.5 * SR);
    expect(h.core.lockState).toBe('locked');
    const relock = laStart(h, inL, 4 * SR, 7.5 * SR);
    expect(relock).toBeLessThan(6 * SR);
    expect(maxError(h.outL, relock + FADE, 7.5 * SR, laOut(media, 0, off, 1))).toBeLessThan(1e-5);
  });

  it('keeps look-ahead output while the real-time worker is unhealthy, then bypasses', () => {
    const off = SR / 2 + 7;
    const { h, rt, media, inL } = scenario(5 * SR, () => off, { outputLatency: 960 });
    rt.delay = () => Infinity; // the worker never answers
    h.runUntil(3 * SR);
    expect(h.core.lockState).toBe('locked');
    // Delayed pass-through, bypass once the worker is unhealthy (1 s), look-ahead from the
    // planned switch on.
    const lookahead = laOut(media, 0, off, 1, 960);
    let from = 3 * SR;
    while (from > 0 && Math.abs(h.outL[from - 1]! - lookahead(from - 1)) <= 1e-5) from--;
    expect(from).toBeLessThan(2.6 * SR);
    expect(maxError(h.outL, from, 3 * SR, lookahead)).toBeLessThan(1e-5);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'lookahead', rtHealthy: false, underruns: 0 });
    const flushAt = h.frame;
    h.core.onLa({ type: 'flush' });
    h.runUntil(5 * SR);
    // Zero-latency bypass once the 20 ms (D) that look-ahead already played have passed.
    expect(maxError(h.outL, flushAt + FADE, flushAt + 960, zero)).toBe(0);
    expect(maxError(h.outL, flushAt + 960 + FADE, 5 * SR, (f) => inL[f]!)).toBe(0);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'passthrough', latency: 0, rtHealthy: false });
  });

  it('disabled during look-ahead output: holds D of silence, reports bypass once the output is the input', () => {
    const off = SR / 2 + 7;
    const d = 14400; // Bluetooth
    const { h, media, inL } = scenario(5 * SR, () => off, { outputLatency: d });
    h.runUntil(3 * SR);
    expect(maxError(h.outL, 2.5 * SR, 3 * SR, laOut(media, 0, off, 1, d))).toBeLessThan(1e-5);
    const offAt = h.frame;
    const before = h.main.length;
    h.config({ enabled: false, residualGain: G, lookahead: true, outputLatency: d });
    h.runUntil(5 * SR);
    const reports = h.main
      .slice(before)
      .flatMap((m, i) => (m.type === 'stats' ? [{ mode: m.stats.mode, at: h.mainFrames[before + i]! }] : []));
    // The first 'bypass' report comes with the quantum that ends the fade-in of the input…
    const bypass = reports.find((r) => r.mode === 'bypass')!;
    expect(bypass.at).toBe(offAt + Math.ceil((d + FADE) / QUANTUM) * QUANTUM);
    expect(reports.filter((r) => r.at < bypass.at).every((r) => r.mode !== 'bypass')).toBe(true);
    // …after the D of content look-ahead output already played (silence), and the output is
    // the input from then on: the controller can switch to the direct path seamlessly.
    expect(maxError(h.outL, offAt + FADE, offAt + d, zero)).toBe(0);
    expect(maxError(h.outL, bypass.at, 5 * SR, (f) => inL[f]!)).toBe(0);
    expect(maxError(h.outL, bypass.at - QUANTUM, bypass.at, (f) => inL[f]!)).toBeGreaterThan(0);
  });

  it('sends a new probe when the previous one timed out and ignores stale results', () => {
    const off = SR;
    const { h, la } = scenario(3 * SR, () => off);
    la.probeDelay = 2.5 * SR; // answers arrive after the 1 s timeout
    h.runUntil(3 * SR);
    // Probes at 4096 frames, then one per second (timeout); the late answers are ignored.
    expect(la.probes).toBe(3);
    expect(h.core.lockState).toBe('unlocked');
  });

  it('ignores probe results without a match and keeps probing at most every 250 ms', () => {
    const { h, la, inL } = scenario(3 * SR, () => SR, { laOffsetAt: () => null });
    h.runUntil(3 * SR);
    expect(h.core.lockState).toBe('unlocked');
    // First probe at PROBE_LENGTH frames, then one per 250 ms.
    expect(la.probes).toBe(Math.floor((3 * SR - 4096) / (SR / 4)) + 1);
    expect(maxError(h.outL, L + FADE, 3 * SR, rtOut(inL))).toBe(0);
  });

  it('records the undelayed input and the output of the same frames for debugging', () => {
    const off = SR / 2 + 3;
    const d = 1440;
    const { h, media, inL, inR } = scenario(3 * SR, () => off, { outputLatency: d });
    h.runUntil(2 * SR);
    const start = h.frame;
    h.core.onMain({ type: 'debug-record', seconds: 0.1 });
    h.runUntil(3 * SR);
    const rec = h.main.find((m) => m.type === 'debug-recording');
    if (rec?.type !== 'debug-recording') throw new Error('no recording');
    const n = SR / 10;
    expect(firstMismatch(rec.input[0], 0, n, (i) => inL[start + i]!, 0)).toBe(-1);
    expect(firstMismatch(rec.input[1], 0, n, (i) => inR[start + i]!, 0)).toBe(-1);
    expect(firstMismatch(rec.output[0], 0, n, (i) => h.outL[start + i]!, 0)).toBe(-1);
    // The output leads the recorded input by D.
    expect(maxError(rec.output[0], 0, n, (i) => laOut(media, 0, off, 1, d)(start + i))).toBeLessThan(1e-5);
  });
});

describe('MixerCore look-ahead with non-finite blocks', () => {
  /** Overwrites media [from, to) of the stored blocks with `value` (speech, and residual too if `both`). */
  function poison(s: Scenario, from: number, to: number, value: number, both: boolean): void {
    const { media } = s;
    const fill = (a: Float32Array) => a.slice(from, to).fill(value);
    s.h.core.onLa({
      type: 'block',
      timelineId: 1,
      start: from,
      speechL: fill(media.speechL),
      speechR: fill(media.speechR),
      residualL: both ? fill(media.residualL) : media.residualL.slice(from, to),
      residualR: both ? fill(media.residualR) : media.residualR.slice(from, to),
    });
  }

  for (const [label, value, both] of [
    ['NaN speech and residual', NaN, true],
    ['infinite speech', Infinity, false],
  ] as const) {
    it(`drops ${label}: finite output, lock kept, gate and gain unaffected afterwards`, () => {
      const off = SR / 2 + 9;
      const s = scenario(4 * SR, () => off, { gapReduction: true, outputLatency: 480 });
      const { h, media } = s;
      h.runUntil(SR);
      expect(h.core.lockState).toBe('locked');
      // 10 ms of broken model output 1 s ahead of the input (< 8 quanta: the lock survives).
      const bad = 2 * SR + off;
      poison(s, bad, bad + 480, value, both);
      h.runUntil(4 * SR);
      expect(allFinite(h.outL)).toBe(true);
      expect(allFinite(h.outR)).toBe(true);
      expect(h.core.lockState).toBe('locked');
      // Speech is present throughout, so with an intact gate the output is exactly v·(s + g·r).
      expect(maxError(h.outL, SR, 2 * SR - 480, laOut(media, 0, off, 1, 480))).toBeLessThan(1e-5);
      expect(maxError(h.outL, 2.5 * SR, 4 * SR, laOut(media, 0, off, 1, 480))).toBeLessThan(1e-5);
      expect(maxError(h.outR, 2.5 * SR, 4 * SR, laOut(media, 1, off, 1, 480))).toBeLessThan(1e-5);
      for (const st of h.stats()) expect(Number.isFinite(st.outRms)).toBe(true);
    });
  }

  it('never locks on blocks that are not finite', () => {
    const off = SR / 2 + 9;
    const s = scenario(3 * SR, () => off);
    // Everything after the first probe window is broken.
    poison(s, 4096 + off, 14 * SR, NaN, true);
    s.h.runUntil(3 * SR);
    expect(s.h.core.lockState).not.toBe('locked');
    expect(allFinite(s.h.outL)).toBe(true);
    expect(maxError(s.h.outL, L + FADE, 3 * SR, rtOut(s.inL))).toBe(0);
  });
});
