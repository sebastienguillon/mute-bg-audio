import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { DEFAULT_LATENCY, RT_HOP } from '../../src/lib/constants';
import { FakeLookahead, FakeRealtime, MixerHarness, SR } from './helpers/mixer-harness';
import { makeMedia, maxStep, playMedia, readWavFloat, smoothMedia } from './helpers/mixer-signals';

const L = DEFAULT_LATENCY;

function db(ratio: number): number {
  return 20 * Math.log10(ratio);
}

/** RMS of (a − b) over [from, to) divided by RMS of c over the same range. */
function ratio(a: (i: number) => number, c: (i: number) => number, from: number, to: number): number {
  let num = 0;
  let den = 0;
  for (let i = from; i < to; i++) {
    num += a(i) * a(i);
    den += c(i) * c(i);
  }
  return Math.sqrt(num / den);
}

describe('MixerCore crossfades', () => {
  it('keeps sample-to-sample steps small across every kind of switch', () => {
    const n = 12 * SR;
    const off = SR / 3;
    const media = smoothMedia(n + off + SR);
    const [inL, inR] = playMedia(media, n, () => off);
    const h = new MixerHarness(inL, inR);
    const rt = new FakeRealtime(h, 'zero');
    const bursts = [1.5, 2, 2.5].map((s) => Math.ceil((s * SR) / RT_HOP) * RT_HOP);
    rt.delay = (index) => (bursts.some((b) => index >= b && index < b + 10 * RT_HOP) ? 2400 : 0);
    const la = new FakeLookahead(h, media, 1, () => off);
    h.connectRt(rt);
    h.connectLa(la);
    la.sendBlocks(0, media.speechL.length, SR);
    const config = { enabled: true, residualGain: 0.3, gapReduction: true, lookahead: false, outputLatency: 1200 };

    h.runUntil(0.5 * SR); // bypass
    h.config(config); // bypass → silence (L, already heard) → real-time
    h.runUntil(3.5 * SR); // underruns: real-time ⇄ pass-through, then a jitter increase (replay)
    expect(h.core.latency).toBe(L + RT_HOP);
    h.config({ ...config, lookahead: true }); // real-time → look-ahead (a jump forward by L + D)
    h.runUntil(5 * SR);
    expect(h.core.lockState).toBe('locked');
    h.core.onLa({ type: 'flush' }); // look-ahead without data: reflected fade-out, silence, real-time
    h.runUntil(5.5 * SR);
    la.sendBlocks(0, media.speechL.length, SR);
    h.runUntil(7 * SR);
    expect(h.core.lockState).toBe('locked');
    h.config({ ...config, lookahead: true, residualGain: 0.05 }); // gain ramp
    h.runUntil(8 * SR);
    h.config({ ...config, residualGain: 0.05 }); // look-ahead → silence (L + D) → real-time
    h.runUntil(9 * SR);
    h.config({ ...config, enabled: false }); // → bypass…
    h.runUntil(9 * SR + 128);
    h.config(config); // …interrupted after one quantum: reflected fade, silence
    h.runUntil(10 * SR);
    h.config({ ...config, enabled: false });
    h.runUntil(11 * SR);
    h.config(config);
    h.runUntil(n);

    const modes = new Set(h.stats().map((s) => s.mode));
    expect([...modes].sort()).toEqual(['bypass', 'lookahead', 'realtime']);
    expect(h.stats().at(-1)!.underruns).toBe(3); // three ~100 ms pass-through gaps
    const natural = Math.max(maxStep(inL, 0, n), maxStep(inR, 0, n));
    expect(natural).toBeLessThan(0.009);
    // A hard switch would step by up to ~0.5 here.
    expect(maxStep(h.outL, 0, n)).toBeLessThan(0.015);
    expect(maxStep(h.outR, 0, n)).toBeLessThan(0.015);
  });
});

describe('MixerCore gap reduction', () => {
  const speechOn = (i: number) => (i >= 0.5 * SR && i < 2 * SR) || (i >= 4 * SR && i < 5.5 * SR);

  for (const path of ['realtime', 'lookahead'] as const) {
    it(`lowers the residual by ~12 dB without speech and not during speech (${path})`, () => {
      const n = 6 * SR;
      const off = SR;
      const media = makeMedia(n + 2 * SR, 3, (i) => speechOn(i - off));
      const [inL, inR] = playMedia(media, n, () => off);
      const run = (gapReduction: boolean) => {
        const h = new MixerHarness(inL, inR);
        const mono = (t: number) => 0.5 * (media.speechL[t + off]! + media.speechR[t + off]!);
        h.connectRt(new FakeRealtime(h, mono));
        if (path === 'lookahead') {
          const la = new FakeLookahead(h, media, 1, () => off);
          h.connectLa(la);
          la.sendBlocks(0, media.speechL.length, SR);
        }
        h.config({ enabled: true, residualGain: 0.5, gapReduction, lookahead: path === 'lookahead' });
        h.runUntil(n);
        // Effective residual gain over input frames [from, to): real-time output frames t + L,
        // look-ahead output frames t (it reads media t + off with outputLatency 0).
        return (from: number, to: number) => {
          if (path === 'realtime') {
            return ratio(
              (t) => h.outL[t + L]! - mono(t),
              (t) => inL[t]! - mono(t),
              from,
              to,
            );
          }
          return ratio(
            (t) => h.outL[t]! - media.speechL[t + off]!,
            (t) => media.residualL[t + off]!,
            from,
            to,
          );
        };
      };
      const gated = run(true);
      const plain = run(false);
      const g = 0.5;
      // Speech-free (the release has had > 0.9 s to settle).
      expect(db(gated(3 * SR, 3.9 * SR) / g)).toBeGreaterThan(-12.5);
      expect(db(gated(3 * SR, 3.9 * SR) / g)).toBeLessThan(-10.5);
      // During speech (onset after 5 ms attack).
      expect(Math.abs(db(gated(1 * SR, 2 * SR) / g))).toBeLessThan(0.5);
      expect(Math.abs(db(gated(4.05 * SR, 5.5 * SR) / g))).toBeLessThan(0.5);
      // Without gap reduction: g everywhere.
      expect(Math.abs(db(plain(0.5 * SR, 6 * SR - L) / g))).toBeLessThan(0.01);
    });
  }

  it.skipIf(!existsSync('test/fixtures/generated/speech.wav'))('works on the generated speech/music fixtures', () => {
    const speech = readWavFloat('test/fixtures/generated/speech.wav').channels;
    const mix = readWavFloat('test/fixtures/generated/mix.wav').channels;
    const [mixL, mixR] = mix as [Float32Array, Float32Array];
    const s = speech[0]!;
    const n = mixL.length;
    const h = new MixerHarness(mixL, mixR);
    h.connectRt(new FakeRealtime(h, (t) => s[t]!));
    h.config({ enabled: true, residualGain: 0.25, gapReduction: true });
    h.runUntil(n);
    const gEff = (from: number, to: number) =>
      ratio(
        (t) => h.outL[t + L]! - s[t]!,
        (t) => mixL[t]! - s[t]!,
        from,
        to,
      ) / 0.25;
    // timeline.json: no speech in [25.51 s, 28.51 s); lines elsewhere (with short pauses).
    expect(db(gEff(26.6 * SR, 28.4 * SR))).toBeLessThan(-10.5);
    expect(db(gEff(3 * SR, 9 * SR))).toBeGreaterThan(-3);
  });
});
