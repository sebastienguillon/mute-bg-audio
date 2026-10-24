import { describe, expect, it } from 'vitest';
import { DEFAULT_LATENCY, QUANTUM, RT_HOP } from '../../src/lib/constants';
import { FakeRealtime, MixerHarness, SR } from './helpers/mixer-harness';
import { maxError, maxStep, noise, tones } from './helpers/mixer-signals';

const L = DEFAULT_LATENCY;
const IDLE_AFTER = SR / 2;

/** `signal` with exact digital silence over the given [from, to) ranges (quantum-aligned). */
function withSilence(signal: Float32Array, ranges: readonly [number, number][]): Float32Array {
  const out = signal.slice();
  for (const [from, to] of ranges) out.fill(0, from, to);
  return out;
}

describe('MixerCore idle on digital silence', () => {
  it('stops sending hops after 0.5 s of silence and resumes with a new session on sound', () => {
    const n = 4 * SR;
    const pause = SR;
    const resume = 3 * SR;
    const l = withSilence(noise(n, 0.4, 1), [[pause, resume]]);
    const r = withSilence(noise(n, 0.4, 2), [[pause, resume]]);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });

    h.runUntil(pause + IDLE_AFTER + QUANTUM);
    const hops = rt.hops;
    // Hops up to the start of idle, none after it.
    expect(rt.hopIndices.at(-1)).toBeLessThan(pause + IDLE_AFTER);
    expect(rt.hopIndices.at(-1)).toBeGreaterThanOrEqual(pause + IDLE_AFTER - 2 * RT_HOP);
    h.runUntil(resume);
    expect(rt.hops).toBe(hops);
    expect(rt.resets).toBe(1);

    h.runUntil(n);
    // The first quantum with sound starts a new session (reset, hop indices from that quantum).
    expect(rt.resets).toBe(2);
    expect(rt.hopIndices[hops]).toBe(resume);
    expect(rt.hopIndices.slice(hops)).toEqual(Array.from({ length: rt.hops - hops }, (_, k) => resume + k * RT_HOP));
    // Silence until the resumed input reaches the output, then real-time output, with no
    // added latency and no underruns.
    expect(maxError(h.outL, pause + L, resume + L, () => 0)).toBe(0);
    expect(maxError(h.outL, resume + L + 480, n, (f) => Math.fround(0.25 * l[f - L]!))).toBe(0);
    expect(maxError(h.outR, resume + L + 480, n, (f) => Math.fround(0.25 * r[f - L]!))).toBe(0);
    const stats = h.stats();
    const idle = stats.filter((s) => s.mode === 'idle');
    // Stats windows of 0.5 s: [1.5 s, 3 s) is idle; the windows overlapping the edges may not be.
    expect(idle.length).toBeGreaterThanOrEqual(2);
    expect(idle.every((s) => s.rtHealthy && s.latency === L)).toBe(true);
    expect(stats.at(-1)).toMatchObject({ mode: 'realtime', underruns: 0, latency: L, rtHealthy: true });
  });

  it("treats the near-zero output of Chrome's Opus decoder for digital silence as silence", () => {
    // Chrome decodes Opus digital silence to values around 1e-15, not exact zeros.
    const n = 3 * SR;
    const x = noise(n, 0.4, 4);
    for (let f = SR; f < 2 * SR; f++) x[f] = (f & 1 ? 1 : -1) * 1e-15;
    const h = new MixerHarness(x, x);
    const rt = new FakeRealtime(h, 'zero');
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(SR + IDLE_AFTER + QUANTUM);
    const hops = rt.hops;
    h.runUntil(2 * SR);
    expect(rt.hops).toBe(hops);
    h.runUntil(n);
    expect(rt.resets).toBe(2);
    expect(h.stats().some((st) => st.mode === 'idle')).toBe(true);
  });

  it('does not count the missing speech of repeated pauses as underruns', () => {
    // Five pauses of 0.6 s within 10 s: counted as underruns they would grow the jitter.
    const n = 10 * SR;
    const pauses = [1, 2.5, 4, 5.5, 7].map((s): [number, number] => [s * SR, (s + 0.6) * SR]);
    const x = withSilence(noise(n, 0.4, 3), pauses);
    const h = new MixerHarness(x, x);
    const rt = new FakeRealtime(h, 'zero');
    rt.delay = () => 640; // within the jitter allowance
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(n);
    expect(rt.resets).toBe(1 + pauses.length);
    expect(h.core.latency).toBe(L);
    expect(h.stats().at(-1)!.underruns).toBe(0);
    expect(maxError(h.outL, 8 * SR, n, (f) => Math.fround(0.25 * x[f - L]!))).toBe(0);
  });

  it('keeps the transitions click-free', () => {
    const n = 3 * SR;
    // A tone that fades out before the pause and back in after it (as a player does).
    const env = (f: number) => (f < SR ? 1 : f < SR + 960 ? 1 - (f - SR) / 960 : f < 2 * SR ? 0 : Math.min(1, (f - 2 * SR) / 960));
    const tone = tones(n, [{ freq: 220, amp: 0.4 }]);
    const x = Float32Array.from(tone, (v, f) => (env(f) === 0 ? 0 : v * env(f)));
    const h = new MixerHarness(x, x);
    const mid = (t: number) => 0.5 * x[t]!;
    h.connectRt(new FakeRealtime(h, mid));
    h.config({ enabled: true, residualGain: 0.5 });
    h.runUntil(n);
    expect(h.stats().some((s) => s.mode === 'idle')).toBe(true);
    expect(maxStep(h.outL, 0, n)).toBeLessThanOrEqual(maxStep(x, 0, n) + 1e-3);
  });

  it('treats a missing input as silence and reports bypass instead of idle when disabled', () => {
    const n = 3 * SR;
    const x = noise(n, 0.4, 4);
    const h = new MixerHarness(x, x);
    const rt = new FakeRealtime(h, 'zero');
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(SR / 2);
    h.layout = 'none';
    h.runUntil(1.5 * SR);
    const hops = rt.hops;
    h.runUntil(2 * SR);
    expect(rt.hops).toBe(hops);
    expect(h.stats().at(-1)!.mode).toBe('idle');
    h.config({ enabled: false });
    h.runUntil(n);
    expect(h.stats().at(-1)!.mode).toBe('bypass');
    expect(rt.hops).toBe(hops);
  });
});
