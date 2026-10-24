import { describe, expect, it } from 'vitest';
import { FakeLookahead, FakeRealtime, MixerHarness, SR } from './helpers/mixer-harness';
import { makeMedia, playMedia } from './helpers/mixer-signals';

// The frame counters are rebased (moved back by a multiple of 2^28) once they reach 2^29, so
// that they stay small integers (Smis) after hours of uptime. The output must not change.

const REBASE_AT = 2 ** 29;

/**
 * Runs the same session from `firstFrame`: real-time answers in flight (13 ms), gap reduction,
 * and with `lookahead` a lock with D = 2400 and a seek at 3.5 s (unlock, real-time, probe, new
 * lock).
 */
function session(firstFrame: number, lookahead: boolean) {
  const n = 7 * SR;
  const off1 = SR / 2 + 3;
  const off2 = 2 * SR + 11;
  const seek = 3.5 * SR;
  const media = makeMedia(12 * SR, 17, (i) => i % SR < 0.7 * SR);
  const offsetAt = (f: number) => (f < seek ? off1 : off2);
  const [inL, inR] = playMedia(media, n, offsetAt);
  const h = new MixerHarness(inL, inR, { firstFrame });
  const rt = new FakeRealtime(h, 'zero');
  rt.delay = () => 640;
  // Probes carry core frame indices; the media offset is relative to the session's frames, whose
  // core indices move back by 2^28 at the rebase.
  const local = (frameEnd: number) => frameEnd - (frameEnd >= firstFrame ? firstFrame : firstFrame - 2 ** 28);
  const la = new FakeLookahead(h, media, 1, (frameEnd) => offsetAt(local(frameEnd)) - (frameEnd - local(frameEnd)));
  h.connectRt(rt);
  h.connectLa(la);
  la.sendBlocks(0, media.speechL.length, SR);
  h.config({ enabled: true, residualGain: 0.3, gapReduction: true, lookahead, outputLatency: 2400 });
  h.runUntil(n);
  return { h, la };
}

describe('MixerCore frame counter rebase', () => {
  for (const lookahead of [false, true]) {
    it(`renders exactly the same output and stats across a rebase (${lookahead ? 'look-ahead' : 'real-time'})`, () => {
      const a = session(0, lookahead);
      // Rebased 2.5 s into the session with speech answers in flight (and locked: the seek and
      // the new lock come after it).
      const b = session(REBASE_AT - 2.5 * SR, lookahead);
      expect(Buffer.compare(Buffer.from(b.h.outL.buffer), Buffer.from(a.h.outL.buffer))).toBe(0);
      expect(Buffer.compare(Buffer.from(b.h.outR.buffer), Buffer.from(a.h.outR.buffer))).toBe(0);
      expect(b.h.stats()).toEqual(a.h.stats());
      expect(a.h.stats().at(-1)).toMatchObject({ mode: lookahead ? 'lookahead' : 'realtime', underruns: 0 });
      if (lookahead) {
        expect(a.la.probes).toBe(2);
        expect(b.la.probes).toBe(2);
        expect(b.h.core.lockState).toBe('locked');
      }
    });
  }
});
