import { describe, expect, it } from 'vitest';
import { DEFAULT_LATENCY, PROBE_LENGTH, QUANTUM } from '../../src/lib/constants';
import { FakeLookahead, FakeRealtime, type Media, MixerHarness, SR } from './helpers/mixer-harness';
import { firstMismatch, makeMedia, maxError, playMedia } from './helpers/mixer-signals';

// Look-ahead output follows the element's playback state: silence in the content keeps the lock,
// a pause, seek or speed change ('playback' message, or verification as a fallback) drops it.

const L = DEFAULT_LATENCY;
const G = 0.3;
const FADE = 480;
const UNLOCK_FRAMES = 8 * QUANTUM;

/** Sets media [from, to) of every channel to `scale` times its value (0: digital silence). */
function scaleMedia(media: Media, from: number, to: number, scale: number): void {
  for (const a of [media.speechL, media.speechR, media.residualL, media.residualR]) {
    for (let i = from; i < to; i++) a[i]! *= scale;
  }
}

interface Pause {
  /** Input frame (quantum-aligned) where the element stops, and where it plays again. */
  at: number;
  resume: number;
  /** Send the 'playback' messages (false: only the input tells, as with a late message). */
  message: boolean;
}

/** Element playing `media` from media index `off`, optionally paused once (the media position stands still). */
function scenario(frames: number, off: number, media: Media, d: number, pause?: Pause) {
  const offsetAt = (f: number) => (pause === undefined || f < pause.at ? off : off - (pause.resume - pause.at));
  const [inL, inR] = playMedia(media, frames, offsetAt);
  if (pause !== undefined) {
    inL.fill(0, pause.at, pause.resume);
    inR.fill(0, pause.at, pause.resume);
  }
  const h = new MixerHarness(inL, inR);
  const la = new FakeLookahead(h, media, 1, offsetAt);
  h.connectRt(new FakeRealtime(h, 'zero'));
  h.connectLa(la);
  la.sendBlocks(0, media.speechL.length, 12345);
  h.config({ residualGain: G, lookahead: true, outputLatency: d });
  const run = () => {
    if (pause?.message) {
      h.runUntil(pause.at);
      h.core.onMain({ type: 'playback', playing: false });
      h.runUntil(pause.resume);
      h.core.onMain({ type: 'playback', playing: true });
    }
    h.runUntil(frames);
  };
  return { h, la, inL, run };
}

function laOut(media: Media, off: number, d: number): (f: number) => number {
  return (f) => media.speechL[f + off + d]! + G * media.residualL[f + off + d]!;
}

function rtOut(x: Float32Array): (f: number) => number {
  return (f) => Math.fround(G * x[f - L]!);
}

/** Number of samples of a[from, to) louder than 0.01. */
function loud(a: Float32Array, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (Math.abs(a[i]!) > 0.01) n++;
  return n;
}

describe('MixerCore look-ahead through silence in the content', () => {
  for (const d of [0, 14400]) {
    for (const gap of [0.55, 1.2]) {
      it(`keeps the lock through a ${gap} s digital-silence gap: no skip, no hold (D = ${d})`, () => {
        const off = SR / 4;
        const media = makeMedia(10 * SR, 42);
        const gapFrom = 3 * SR + off;
        scaleMedia(media, gapFrom, gapFrom + gap * SR, 0);
        const { h, la, inL, run } = scenario(6 * SR, off, media, d);
        run();
        const at = firstMismatch(h.outL, L + FADE, 3 * SR, rtOut(inL), 1e-6);
        expect(at).toBeLessThan(2 * SR);
        // Look-ahead output all along: through the gap, its end (heard in sync, D early) and on.
        expect(maxError(h.outL, at + FADE, 6 * SR, laOut(media, off, d))).toBeLessThan(1e-5);
        expect(la.probes).toBe(1);
        expect(h.core.lockState).toBe('locked');
        // Hops stopped during the gap (idle), and real-time processing resumed after it.
        if (gap > 1) expect(h.stats().map((s) => s.mode)).toContain('idle');
        expect(h.stats().at(-1)).toMatchObject({ mode: 'lookahead', underruns: 0 });
      });
    }
  }
});

describe('MixerCore look-ahead when playback stops', () => {
  for (const d of [2400, 14400]) {
    it(`drops the lock at a pause inside a digital-silence gap: nothing after the pause is heard (D = ${d})`, () => {
      const off = SR / 4;
      const media = makeMedia(12 * SR, 7);
      const gapFrom = 3 * SR;
      const gapTo = gapFrom + 1.5 * SR;
      scaleMedia(media, gapFrom + off, gapTo + off, 0);
      // Paused 0.6 s into the gap, so the look-ahead position (D ahead) is still in the gap.
      const pause: Pause = { at: gapFrom + 0.6 * SR, resume: gapFrom + 2.6 * SR, message: true };
      const { h, la, run } = scenario(10 * SR, off, media, d, pause);
      run();
      // Not even the speech after the gap, which look-ahead output would reach while paused.
      expect(maxError(h.outL, pause.at + FADE, pause.resume + L, () => 0)).toBe(0);
      // Played again (still in the gap): sound returns at the gap end, then a new lock.
      expect(la.probes).toBe(2);
      expect(h.core.lockState).toBe('locked');
      const after = gapTo + (pause.resume - pause.at);
      expect(loud(h.outL, after + L, after + L + SR / 2)).toBeGreaterThan(SR / 4);
    });

    it(`without the playback message, leaks at most D of the speech after the gap (D = ${d})`, () => {
      const off = SR / 4;
      const media = makeMedia(12 * SR, 7);
      const gapFrom = 3 * SR;
      const gapTo = gapFrom + 1.5 * SR;
      scaleMedia(media, gapFrom + off, gapTo + off, 0);
      const pause: Pause = { at: gapFrom + 0.6 * SR, resume: gapFrom + 2.6 * SR, message: false };
      const { h, run } = scenario(10 * SR, off, media, d, pause);
      run();
      // Look-ahead output reaches the speech D before its verification position does; the
      // silent input then contradicts the media and look-ahead output stops at once.
      const leaked = loud(h.outL, pause.at, pause.resume);
      expect(leaked).toBeLessThanOrEqual(d + QUANTUM + FADE);
      expect(firstMismatch(h.outL, pause.at, gapTo - d, () => 0, 0.01)).toBe(-1);
    });
  }

  for (const message of [true, false]) {
    it(`a pause in a quiet passage leaks ${message ? 'nothing' : 'at most 21 ms'} of the speech that follows`, () => {
      const off = SR / 4;
      const d = 14400;
      const media = makeMedia(12 * SR, 5);
      const pauseAt = 3 * SR;
      // −60 dBFS for 250 ms after the pause point (a gated podcast), then speech again.
      scaleMedia(media, pauseAt + off, pauseAt + off + SR / 4, 1e-3 / 0.15);
      const pause: Pause = { at: pauseAt, resume: pauseAt + 2 * SR, message };
      const { h, run } = scenario(8 * SR, off, media, d, pause);
      run();
      const leaked = loud(h.outL, pauseAt + FADE, pause.resume);
      if (message) expect(leaked).toBe(0);
      // Digital silence against quiet media counts towards unlocking (8 quanta).
      else expect(leaked).toBeLessThanOrEqual(UNLOCK_FRAMES + FADE);
      expect(h.core.lockState).toBe('locked'); // after the resume
    });
  }

  it('drops the lock while sound goes on (another speed) and locks again once it plays normally', () => {
    const off = SR / 4;
    const media = makeMedia(10 * SR, 3);
    const { h, la, inL } = scenario(7 * SR, off, media, 2400);
    h.runUntil(2.5 * SR);
    expect(h.core.lockState).toBe('locked');
    const stopAt = h.frame;
    h.core.onMain({ type: 'playback', playing: false });
    expect(h.core.lockState).toBe('unlocked');
    h.runUntil(4 * SR);
    // Look-ahead output already played D ahead, including the input that keeps arriving for a
    // moment after the stop (STOP_TAIL, 2048 frames): silence until real-time output reaches the
    // input after that tail, then real-time output; no probes meanwhile.
    const STOP_TAIL = 2048;
    expect(maxError(h.outL, stopAt + FADE, stopAt + L + STOP_TAIL, () => 0)).toBe(0);
    expect(maxError(h.outL, stopAt + L + STOP_TAIL + FADE, 4 * SR, rtOut(inL))).toBe(0);
    expect(la.probes).toBe(1);
    const playAt = h.frame;
    h.core.onMain({ type: 'playback', playing: true });
    h.runUntil(7 * SR);
    // A probe window entirely after playback resumed, then a lock and look-ahead output.
    expect(la.probes).toBe(2);
    const relock = firstMismatch(h.outL, playAt, 7 * SR, rtOut(inL), 1e-6);
    expect(relock).toBeGreaterThan(playAt + PROBE_LENGTH);
    expect(maxError(h.outL, relock + FADE, 7 * SR, laOut(media, off, 2400))).toBeLessThan(1e-5);
  });
});
