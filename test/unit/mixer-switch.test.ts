import { describe, expect, it } from 'vitest';
import { DEFAULT_LATENCY, QUANTUM } from '../../src/lib/constants';
import { FakeLookahead, FakeRealtime, type Media, MixerHarness, SR } from './helpers/mixer-harness';
import { firstMismatch, makeMedia, maxError, playMedia } from './helpers/mixer-signals';

// Planned switches into and out of look-ahead output: they skip or hold content, so they wait
// (at most 1.5 s) for content where that falls on no speech.

const L = DEFAULT_LATENCY;
const G = 0.3;
const FADE = 480;
const SEARCH = 1.5 * SR;

/** Element playing `media` at a constant offset; real-time speech = 0; every block stored. */
function scenario(frames: number, off: number, media: Media, outputLatency: number) {
  const [inL, inR] = playMedia(media, frames, () => off);
  const h = new MixerHarness(inL, inR);
  const la = new FakeLookahead(h, media, 1, () => off);
  h.connectRt(new FakeRealtime(h, 'zero'));
  h.connectLa(la);
  la.sendBlocks(0, media.speechL.length, 12345);
  h.config({ residualGain: G, lookahead: true, outputLatency });
  return { h, la, inL };
}

/** Runs quantum by quantum until the lock is acquired; returns that frame. */
function runUntilLocked(h: MixerHarness, limit: number): number {
  while (h.core.lockState !== 'locked' && h.frame < limit) h.runUntil(h.frame + QUANTUM);
  expect(h.core.lockState).toBe('locked');
  return h.frame;
}

/** Look-ahead output at frame f (media index f + off + D). */
function laOut(media: Media, off: number, d: number): (f: number) => number {
  return (f) => media.speechL[f + off + d]! + G * media.residualL[f + off + d]!;
}

/** Real-time output with speech = 0. */
function rtOut(x: Float32Array): (f: number) => number {
  return (f) => Math.fround(G * x[f - L]!);
}

/** Σ speech² of media [from, to). */
function speechEnergy(media: Media, from: number, to: number): number {
  let e = 0;
  for (let i = from; i < to; i++) e += media.speechL[i]! ** 2 + media.speechR[i]! ** 2;
  return e;
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

describe('MixerCore planned switch into look-ahead output', () => {
  for (const d of [0, 2400, 14400]) {
    it(`skips no speech when a pause of L + D lies within 1.5 s (D = ${d})`, () => {
      const off = SR / 4 + 3;
      // Speech everywhere except a pause of L + D (+ 64 frames) at input frames [0.5 s, …).
      const pauseFrom = SR / 2;
      const pauseTo = pauseFrom + L + d + 64;
      const media = makeMedia(6 * SR, 8, (i) => i - off < pauseFrom || i - off >= pauseTo);
      const { h, inL } = scenario(3 * SR, off, media, d);
      const lockedAt = runUntilLocked(h, SR);
      expect(lockedAt).toBeLessThan(pauseFrom);
      h.runUntil(3 * SR);
      // Real-time output until the switch, then look-ahead output.
      const at = firstMismatch(h.outL, L + FADE, 3 * SR, rtOut(inL), 1e-6);
      expect(maxError(h.outL, at + FADE, 3 * SR, laOut(media, off, d))).toBeLessThan(1e-5);
      // The content never output, [at − L, at + D), lies inside the pause.
      expect(at - L).toBeGreaterThanOrEqual(pauseFrom);
      expect(at + d).toBeLessThanOrEqual(pauseTo);
      expect(speechEnergy(media, at - L + off, at + d + off)).toBe(0);
    });
  }

  it('without such a pause, switches at the quietest moment within 1.5 s', () => {
    const off = SR / 3;
    const d = 2400; // L + D is a whole number of 32-frame cells
    const media = makeMedia(6 * SR, 9);
    const { h, inL } = scenario(4 * SR, off, media, d);
    const lockedAt = runUntilLocked(h, SR);
    h.runUntil(4 * SR);
    const at = firstMismatch(h.outL, lockedAt, 4 * SR, rtOut(inL), 1e-6);
    expect(at).toBeGreaterThan(lockedAt);
    expect(at).toBeLessThan(lockedAt + SEARCH + QUANTUM);
    expect(maxError(h.outL, at + FADE, 4 * SR, laOut(media, off, d))).toBeLessThan(1e-5);
    // The search ends long before 0.3 s: every candidate (32 frames apart) from then on was
    // available, and none skips less speech.
    const skipped = (f: number) => speechEnergy(media, f - L + off, f + d + off);
    let quietest = Infinity;
    for (let f = at - 32 * Math.floor((at - lockedAt - 0.3 * SR) / 32); f <= lockedAt + SEARCH - QUANTUM; f += 32) {
      quietest = Math.min(quietest, skipped(f));
    }
    expect(skipped(at)).toBeLessThanOrEqual(quietest * (1 + 1e-9));
    // Continuous speech: some is skipped.
    expect(skipped(at)).toBeGreaterThan(0);
  });

  it('switches at once when the stored blocks hold no speech at all', () => {
    const off = SR / 4;
    const media = makeMedia(4 * SR, 10, () => false); // music only
    const { h, inL } = scenario(2 * SR, off, media, 4800);
    const lockedAt = runUntilLocked(h, SR);
    h.runUntil(2 * SR);
    const at = firstMismatch(h.outL, lockedAt, 2 * SR, rtOut(inL), 1e-6);
    // As soon as the scan has covered the preroll and the first span (≈ 15 ms).
    expect(at).toBeLessThan(lockedAt + 30 * QUANTUM);
    expect(maxError(h.outL, at + FADE, 2 * SR, laOut(media, off, 4800))).toBeLessThan(1e-5);
  });

  it('gives up the planned switch when playback stops meanwhile', () => {
    const off = SR / 4;
    const media = makeMedia(4 * SR, 11);
    const { h, inL } = scenario(2 * SR, off, media, 2400);
    const lockedAt = runUntilLocked(h, SR);
    h.runUntil(lockedAt + 4 * QUANTUM);
    h.core.onMain({ type: 'playback', playing: false }); // e.g. the speed changed
    expect(h.core.lockState).toBe('unlocked');
    h.runUntil(2 * SR);
    // Never any look-ahead output: real-time output throughout.
    expect(maxError(h.outL, L + FADE, 2 * SR, rtOut(inL))).toBe(0);
  });
});

describe('MixerCore planned switch out of look-ahead output', () => {
  it('turning look-ahead off holds the silence (L + D) inside a speech pause', () => {
    const off = SR / 4;
    const d = 2400;
    // A short pause (40 ms) at input frames [2.6 s, …): enough for the cut, not for entering.
    const pauseFrom = 2.6 * SR;
    const pauseTo = pauseFrom + 1920;
    const media = makeMedia(7 * SR, 12, (i) => i - off < pauseFrom || i - off >= pauseTo);
    const { h, inL } = scenario(5 * SR, off, media, d);
    h.runUntil(2.2 * SR);
    expect(h.core.lockState).toBe('locked');
    const offAt = h.frame;
    h.config({ residualGain: G, lookahead: false, outputLatency: d });
    h.runUntil(5 * SR);
    expect(h.core.lockState).toBe('unlocked');
    // Look-ahead output until the cut, whose content f + D lies inside the pause…
    const cut = silenceFrom(h.outL, offAt) - FADE;
    expect(maxError(h.outL, offAt, cut, laOut(media, off, d))).toBeLessThan(1e-5);
    expect(cut + d - FADE).toBeGreaterThanOrEqual(pauseFrom);
    expect(cut + d + FADE).toBeLessThanOrEqual(pauseTo);
    // …then silence until real-time output reaches content not heard yet, real-time output.
    expect(maxError(h.outL, cut + FADE, cut + L + d, () => 0)).toBe(0);
    expect(maxError(h.outL, cut + L + d + FADE, 5 * SR, rtOut(inL))).toBe(0);
  });

  it('turning look-ahead back on before the cut keeps the lock and its output', () => {
    const off = SR / 4;
    const media = makeMedia(6 * SR, 13); // no pause: the cut would wait
    const { h } = scenario(3.5 * SR, off, media, 960);
    h.runUntil(2 * SR);
    const offAt = h.frame;
    h.config({ residualGain: G, lookahead: false, outputLatency: 960 });
    h.runUntil(offAt + 2 * QUANTUM);
    h.config({ residualGain: G, lookahead: true, outputLatency: 960 });
    h.runUntil(3.5 * SR);
    expect(h.core.lockState).toBe('locked');
    expect(maxError(h.outL, offAt - SR / 2, 3.5 * SR, laOut(media, off, 960))).toBeLessThan(1e-5);
  });
});
