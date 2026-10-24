import { describe, expect, it } from 'vitest';
import { DEFAULT_LATENCY, DFN_DELAY, MAX_JITTER, QUANTUM, RT_HOP } from '../../src/lib/constants';
import { FakeRealtime, MixerHarness, SR } from './helpers/mixer-harness';
import { allFinite, firstMismatch, maxError, maxStep, noise, tones } from './helpers/mixer-signals';

const L = DEFAULT_LATENCY;

function stereoNoise(n: number, seed = 1): [Float32Array, Float32Array] {
  return [noise(n, 0.5, seed), noise(n, 0.5, seed + 1)];
}

describe('MixerCore bypass', () => {
  it('is a bit-exact identity with zero latency before any config and when disabled', () => {
    const [l, r] = stereoNoise(SR);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    h.connectRt(rt);
    h.runUntil(SR / 2);
    h.config({ enabled: false });
    h.runUntil(SR);
    expect(Buffer.compare(Buffer.from(h.outL.buffer), Buffer.from(l.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(h.outR.buffer), Buffer.from(r.buffer))).toBe(0);
    expect(rt.hops).toBe(0);
    const stats = h.stats();
    // Every 0.5 s, and at once after a config that disables processing (the output is the input).
    expect(stats.length).toBe(2);
    expect(stats.every((s) => s.mode === 'bypass' && s.latency === 0)).toBe(true);
  });

  it('reports bypass at once when a disabled mixer has crossfaded to the input', () => {
    const [l, r] = stereoNoise(2 * SR, 71);
    const h = new MixerHarness(l, r);
    h.connectRt(new FakeRealtime(h, 'zero'));
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(SR + 64);
    const offAt = h.frame;
    const before = h.main.length;
    h.config({ enabled: false, residualGain: 0.25 });
    h.runUntil(2 * SR);
    // Real-time → bypass is a crossfaded jump forward by L: the report comes with the quantum
    // that completes the crossfade, and the output is the input from then on.
    const k = h.main.findIndex((m, i) => i >= before && m.type === 'stats');
    const msg = h.main[k];
    expect(msg?.type === 'stats' && msg.stats.mode).toBe('bypass');
    const at = h.mainFrames[k]!;
    expect(at).toBe(offAt + Math.ceil(480 / QUANTUM) * QUANTUM);
    expect(maxError(h.outL, at, 2 * SR, (f) => l[f]!)).toBe(0);
    expect(maxError(h.outL, at - QUANTUM, at, (f) => l[f]!)).toBeGreaterThan(0);
  });

  it('maps mono input to both sides and missing input to silence', () => {
    const [l, r] = stereoNoise(QUANTUM * 20);
    const h = new MixerHarness(l, r);
    h.layout = 'mono';
    h.runUntil(QUANTUM * 10);
    h.layout = 'none';
    h.runUntil(QUANTUM * 20);
    const half = QUANTUM * 10;
    expect(Array.from(h.outL.subarray(0, half))).toEqual(Array.from(l.subarray(0, half)));
    expect(Array.from(h.outR.subarray(0, half))).toEqual(Array.from(l.subarray(0, half)));
    expect(h.outL.subarray(half).every((v) => v === 0)).toBe(true);
    expect(h.outR.subarray(half).every((v) => v === 0)).toBe(true);
  });
});

describe('MixerCore real-time path', () => {
  it('speech = 0 gives g·x delayed by exactly L', () => {
    const [l, r] = stereoNoise(SR);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.3 });
    h.runUntil(SR);
    // Real-time output starts at output frame L (first valid speech is for input frame 0).
    const from = L + 480;
    expect(maxError(h.outL, from, SR, (f) => Math.fround(0.3 * l[f - L]!))).toBe(0);
    expect(maxError(h.outR, from, SR, (f) => Math.fround(0.3 * r[f - L]!))).toBe(0);
    // Before that: pass-through delayed by L.
    expect(maxError(h.outL, 480, L, (f) => (f < L ? 0 : l[f - L]!))).toBe(0);
    expect(rt.resets).toBe(1);
    const last = h.stats().at(-1)!;
    expect(last).toMatchObject({ mode: 'realtime', latency: L, underruns: 0, locked: false, laAhead: 0 });
    expect(last.outRms).toBeCloseTo(0.3 * last.inRms, 2);
  });

  it('speech = mid gives mid + g·(x − mid) delayed by L', () => {
    const [l, r] = stereoNoise(SR, 7);
    const h = new MixerHarness(l, r);
    h.connectRt(new FakeRealtime(h, 'mid'));
    h.config({ enabled: true, residualGain: 0.2 });
    h.runUntil(SR);
    const mid = (t: number) => Math.fround(0.5 * (l[t]! + r[t]!));
    const from = L + 480;
    expect(maxError(h.outL, from, SR, (f) => mid(f - L) + 0.2 * (l[f - L]! - mid(f - L)))).toBeLessThan(1e-6);
    expect(maxError(h.outR, from, SR, (f) => mid(f - L) + 0.2 * (r[f - L]! - mid(f - L)))).toBeLessThan(1e-6);
  });

  it('absorbs response delays within the jitter allowance and reports the round trip', () => {
    const [l, r] = stereoNoise(2 * SR, 3);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    rt.delay = () => 640; // 13.3 ms
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.5 });
    h.runUntil(2 * SR);
    expect(maxError(h.outL, L + 480, 2 * SR, (f) => Math.fround(0.5 * l[f - L]!))).toBe(0);
    const last = h.stats().at(-1)!;
    expect(last.underruns).toBe(0);
    expect(last.latency).toBe(L);
    expect(last.rtRoundTripMs).toBeCloseTo((640 * 1000) / SR, 6);
  });

  it('falls back to pass-through for late responses, counts one underrun per gap and grows the jitter', () => {
    const n = 8 * SR;
    const [l, r] = stereoNoise(n, 5);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    // Three bursts of 10 hops answered 50 ms late, at 1 s, 2.5 s and 4 s.
    const burstStarts = [SR, 2.5 * SR, 4 * SR].map((s) => Math.ceil(s / RT_HOP) * RT_HOP);
    const late = (index: number) => burstStarts.some((s) => index >= s && index < s + 10 * RT_HOP);
    rt.delay = (index) => (late(index) ? 2400 : 0);
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });

    const first = burstStarts[0]!;
    h.runUntil(first + 2 * SR / 2);
    expect(h.core.latency).toBe(L);
    // Frames [first − DFN_DELAY, first − DFN_DELAY + 4800) lack speech: pure pass-through after the fade.
    const gapFrom = first - DFN_DELAY + L + 480 + QUANTUM;
    const gapTo = first - DFN_DELAY + 10 * RT_HOP + L - QUANTUM;
    expect(maxError(h.outL, gapFrom, gapTo, (f) => l[f - L]!)).toBe(0);
    // Real-time again once the late burst is over.
    const after = first - DFN_DELAY + 10 * RT_HOP + L + 480 + QUANTUM;
    expect(maxError(h.outL, after, after + SR / 4, (f) => Math.fround(0.25 * l[f - L]!))).toBe(0);

    h.runUntil(burstStarts[1]! + SR);
    expect(h.core.latency).toBe(L);
    h.runUntil(n);
    // The third gap within 10 s adds RT_HOP of jitter.
    expect(h.core.latency).toBe(L + RT_HOP);
    const last = h.stats().at(-1)!;
    expect(last.underruns).toBe(3);
    expect(last.latency).toBe(L + RT_HOP);
    const L2 = L + RT_HOP;
    expect(maxError(h.outL, n - SR, n, (f) => Math.fround(0.25 * l[f - L2]!))).toBe(0);
  });

  it('grows the jitter until constantly late responses fit, up to MAX_JITTER', () => {
    const n = 6 * SR;
    const [l, r] = stereoNoise(n, 9);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    rt.delay = () => 1300; // 27 ms: beyond the default allowance
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(n);
    const latency = h.core.latency;
    expect(latency).toBeGreaterThan(L);
    expect(latency).toBeLessThanOrEqual(DFN_DELAY + MAX_JITTER);
    const stats = h.stats();
    // No more underruns over the last 3 s, real-time output with the grown latency.
    expect(stats.at(-1)!.underruns).toBe(stats.at(-7)!.underruns);
    expect(maxError(h.outL, n - 2 * SR, n, (f) => Math.fround(0.25 * l[f - latency]!))).toBe(0);
  });

  it('stops sending hops in bypass and resets the worker when re-enabled', () => {
    const [l, r] = stereoNoise(2 * SR, 11);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0 });
    h.runUntil(SR / 2);
    const hops = rt.hops;
    const offAt = h.frame;
    h.config({ enabled: false, residualGain: 0 });
    h.runUntil(SR);
    expect(rt.hops).toBe(hops);
    // Bypass (zero latency) after the 10 ms crossfade.
    expect(maxError(h.outL, offAt + 480, SR, (f) => l[f]!)).toBe(0);
    const onAt = h.frame;
    h.config({ enabled: true, residualGain: 0 });
    h.runUntil(2 * SR);
    expect(rt.resets).toBe(2);
    // Real-time again (g = 0 removes everything) once speech for the new session is available.
    expect(maxError(h.outL, onAt + L + 480, 2 * SR, () => 0)).toBe(0);
    expect(h.stats().at(-1)!.underruns).toBe(0);
  });

  it('records the undelayed input and the output of the same frames for debugging', () => {
    const [l, r] = stereoNoise(SR, 13);
    const h = new MixerHarness(l, r);
    h.connectRt(new FakeRealtime(h, 'zero'));
    h.config({ enabled: true, residualGain: 0.5 });
    h.runUntil(SR / 2);
    const start = h.frame;
    h.core.onMain({ type: 'debug-record', seconds: 0.1 });
    h.runUntil(SR);
    const rec = h.main.find((m) => m.type === 'debug-recording');
    expect(rec).toBeDefined();
    if (rec?.type !== 'debug-recording') return;
    expect(rec.input[0].length).toBe(SR / 10);
    expect(firstMismatch(rec.input[0], 0, SR / 10, (i) => l[start + i]!, 0)).toBe(-1);
    expect(firstMismatch(rec.input[1], 0, SR / 10, (i) => r[start + i]!, 0)).toBe(-1);
    expect(firstMismatch(rec.output[0], 0, SR / 10, (i) => h.outL[start + i]!, 0)).toBe(-1);
    expect(firstMismatch(rec.output[1], 0, SR / 10, (i) => h.outR[start + i]!, 0)).toBe(-1);
    // Real-time output lags the recorded input by L.
    expect(maxError(rec.output[0], 0, SR / 10, (i) => Math.fround(0.5 * l[start + i - L]!))).toBe(0);
  });

  it('keeps the hop pool constant when the worker answers late', () => {
    const [l, r] = stereoNoise(6 * SR, 17);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    rt.delay = () => 2400; // 50 ms: about 6 hops in flight
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(2 * SR);
    const buffers = h.core.hopBuffersAllocated;
    expect(buffers).toBeLessThanOrEqual(2400 / RT_HOP + 3);
    h.runUntil(6 * SR);
    expect(h.core.hopBuffersAllocated).toBe(buffers);
  });

  it('drops non-finite speech: finite output and an intact gate afterwards', () => {
    const n = 3 * SR;
    const [l, r] = stereoNoise(n, 19);
    const mid = (t: number) => Math.fround(0.5 * (l[t]! + r[t]!));
    const broken = (t: number) => (t >= SR && t < SR + 480 ? NaN : t >= SR + 4800 && t < SR + 4810 ? -Infinity : mid(t));
    const run = (model: (t: number) => number) => {
      const h = new MixerHarness(l, r);
      h.connectRt(new FakeRealtime(h, model));
      h.config({ enabled: true, residualGain: 0.25, gapReduction: true });
      h.runUntil(n);
      return h;
    };
    const h = run(broken);
    const ref = run(mid);
    expect(allFinite(h.outL)).toBe(true);
    expect(allFinite(h.outR)).toBe(true);
    expect(maxError(h.outL, L + 480, SR + L, (f) => ref.outL[f]!)).toBe(0);
    // Once the gate has recovered from the dropped speech, the output is the reference again.
    expect(maxError(h.outL, 1.5 * SR, n, (f) => ref.outL[f]!)).toBeLessThan(1e-6);
    expect(maxError(h.outR, 1.5 * SR, n, (f) => ref.outR[f]!)).toBeLessThan(1e-6);
  });

  it('ramps residual gain changes over ~20 ms', () => {
    const n = SR;
    const x = tones(n, [{ freq: 100, amp: 0.5 }]);
    const h = new MixerHarness(x, x);
    h.connectRt(new FakeRealtime(h, 'zero'));
    h.config({ enabled: true, residualGain: 1 });
    h.runUntil(SR / 2);
    const at = h.frame;
    h.config({ enabled: true, residualGain: 0 });
    h.runUntil(n);
    // Linear ramp from 1 to 0 over 960 frames, then exactly 0.
    expect(maxError(h.outL, at, at + 960, (f) => (1 - (f - at + 1) / 960) * x[f - L]!)).toBeLessThan(1e-6);
    expect(maxError(h.outL, at + 960, n, () => 0)).toBe(0);
  });
});

describe('MixerCore real-time worker health', () => {
  it('bypasses with zero latency while no speech comes back, and recovers', () => {
    const n = 5 * SR;
    const [l, r] = stereoNoise(n, 23);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    // Hops sent in [1 s, 3 s) are never answered (a stuck or dead worker).
    rt.delay = (index) => (index >= SR && index < 3 * SR ? Infinity : 0);
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(1.9 * SR);
    expect(h.stats().every((s) => s.rtHealthy)).toBe(true);
    h.runUntil(3 * SR);
    // Unhealthy 1 s after the last speech arrived (just after 1 s): the input, without delay.
    const lastSpeech = SR;
    const unhealthy = lastSpeech + SR + 2 * QUANTUM;
    expect(maxError(h.outL, unhealthy + 480, 3 * SR, (f) => l[f]!)).toBe(0);
    expect(maxError(h.outR, unhealthy + 480, 3 * SR, (f) => r[f]!)).toBe(0);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'passthrough', latency: 0, rtHealthy: false });
    // Meanwhile only one heartbeat hop per 250 ms (each after a reset).
    const beats = rt.hopIndices.filter((i) => i >= unhealthy - RT_HOP - QUANTUM);
    expect(beats.length).toBe(4);
    for (let k = 1; k < beats.length; k++) expect(beats[k]! - beats[k - 1]!).toBeGreaterThanOrEqual(SR / 4 - RT_HOP);
    h.runUntil(n);
    // The first heartbeat from 3 s on is answered: healthy again, back to real-time after a hold
    // of L (that content was already output without delay).
    const beat = rt.hopIndices.find((i) => i >= 3 * SR)!;
    expect(beat).toBeLessThan(3.25 * SR);
    const healthyAt = beat + RT_HOP + QUANTUM;
    expect(maxError(h.outL, healthyAt + 480, healthyAt + L - QUANTUM, () => 0)).toBe(0);
    expect(maxError(h.outL, healthyAt + L + 480, n, (f) => Math.fround(0.25 * l[f - L]!))).toBe(0);
    const last = h.stats().at(-1)!;
    expect(last).toMatchObject({ mode: 'realtime', latency: L, rtHealthy: true });
    // One underrun when the answers stopped; the recovery itself is not one.
    expect(last.underruns).toBe(1);
  });

  it('treats a worker that never answers as unhealthy', () => {
    const [l, r] = stereoNoise(3 * SR, 29);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    rt.delay = () => Infinity;
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(3 * SR);
    expect(maxError(h.outL, SR + 2 * QUANTUM + 480, 3 * SR, (f) => l[f]!)).toBe(0);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'passthrough', latency: 0, rtHealthy: false, underruns: 0 });
  });

  it('sends a stalled worker one hop per 250 ms (after a reset) and allocates no more hop buffers', () => {
    const n = 10 * SR;
    const [l, r] = stereoNoise(n, 43);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    rt.delay = (index) => (index >= SR ? Infinity : 0); // hangs at 1 s, holding every buffer sent
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(2.1 * SR);
    expect(h.stats().at(-1)!.rtHealthy).toBe(false);
    const hops = rt.hops;
    const resets = rt.resets;
    h.runUntil(n);
    // 7.9 s: 32 heartbeats instead of 790 hops, each after a reset (no silent filler hops).
    expect(rt.hops - hops).toBeGreaterThanOrEqual(31);
    expect(rt.hops - hops).toBeLessThanOrEqual(32);
    expect(rt.resets - resets).toBe(rt.hops - hops);
    // At most 32 buffers in flight; heartbeats are copies.
    expect(h.core.hopBuffersAllocated).toBeLessThanOrEqual(33);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'passthrough', latency: 0, rtHealthy: false });
  });

  it('drops hops instead of allocating when every buffer is in flight', () => {
    const n = 4 * SR;
    const [l, r] = stereoNoise(n, 47);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    rt.delay = () => 0.6 * SR; // alive, but 60 hops behind
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(n);
    expect(h.core.hopBuffersAllocated).toBeLessThanOrEqual(33);
    expect(rt.hops).toBeLessThan(n / RT_HOP - 50);
    // Answers keep coming: healthy, delayed pass-through (the answers are far too late).
    expect(h.stats().at(-1)).toMatchObject({ mode: 'passthrough', rtHealthy: true });
    expect(allFinite(h.outL)).toBe(true);
  });

  it('waits for the worker to say ready: delayed pass-through meanwhile, then real-time without a gap', () => {
    const n = 5 * SR;
    const [l, r] = stereoNoise(n, 53);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    h.connectRt(rt, false); // loading its model
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(3 * SR);
    expect(rt.hops).toBe(0);
    expect(rt.resets).toBe(0);
    // Not unhealthy: the input delayed by L (what real-time output will be in sync with).
    expect(maxError(h.outL, L + 480, 3 * SR, (f) => l[f - L]!)).toBe(0);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'passthrough', latency: L, rtHealthy: true });
    const readyAt = h.frame;
    h.core.onRt({ type: 'ready' });
    h.runUntil(n);
    expect(rt.resets).toBe(1);
    expect(rt.hopIndices[0]).toBe(readyAt);
    // Same delay: crossfaded from pass-through to real-time output, no silence in between.
    expect(maxError(h.outL, readyAt, readyAt + L, (f) => l[f - L]!)).toBe(0);
    expect(maxError(h.outL, readyAt + L + 480, n, (f) => Math.fround(0.25 * l[f - L]!))).toBe(0);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'realtime', latency: L, rtHealthy: true, underruns: 0 });
  });

  it('treats a worker that never says ready as unhealthy after 10 s', () => {
    const n = 11 * SR;
    const [l, r] = stereoNoise(n, 59);
    const h = new MixerHarness(l, r);
    h.connectRt(new FakeRealtime(h, 'zero'), false);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(9.9 * SR);
    expect(h.stats().every((s) => s.rtHealthy)).toBe(true);
    h.runUntil(n);
    expect(maxError(h.outL, 10 * SR + 2 * QUANTUM + 480, n, (f) => l[f]!)).toBe(0);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'passthrough', latency: 0, rtHealthy: false });
  });

  it('stays unhealthy through idle: a dead worker is not hidden by pauses', () => {
    const n = 6 * SR;
    const [l, r] = stereoNoise(n, 61);
    // Paused (digital silence) for 1 s at 2.5 s.
    l.fill(0, 2.5 * SR, 3.5 * SR);
    r.fill(0, 2.5 * SR, 3.5 * SR);
    const h = new MixerHarness(l, r);
    const rt = new FakeRealtime(h, 'zero');
    rt.delay = (index) => (index >= SR ? Infinity : 0); // dies at 1 s
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(n);
    const stats = h.stats();
    expect(stats.map((s) => s.mode)).toContain('idle');
    // From 2.5 s on (stats every 0.5 s) unhealthy throughout, so the controller can replace it.
    expect(stats.slice(4).every((s) => !s.rtHealthy)).toBe(true);
    // After the pause: the input without delay, not a second of delayed pass-through.
    expect(maxError(h.outL, 3.5 * SR + 480, n, (f) => l[f]!)).toBe(0);
  });

  it('starts over with a new connection: no hops until it says ready, a fresh health clock', () => {
    const n = 5 * SR;
    const [l, r] = stereoNoise(n, 67);
    const h = new MixerHarness(l, r);
    const dead = new FakeRealtime(h, 'zero');
    dead.delay = () => Infinity;
    h.connectRt(dead);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(2 * SR);
    expect(h.stats().at(-1)!.rtHealthy).toBe(false);
    const fresh = new FakeRealtime(h, 'zero');
    h.connectRt(fresh, false);
    h.runUntil(2.5 * SR);
    expect(fresh.hops).toBe(0);
    expect(h.stats().at(-1)!.rtHealthy).toBe(true);
    const readyAt = h.frame;
    h.core.onRt({ type: 'ready' });
    h.runUntil(n);
    expect(fresh.resets).toBe(1);
    expect(fresh.hopIndices[0]).toBe(readyAt);
    expect(maxError(h.outL, readyAt + 2 * L, n, (f) => Math.fround(0.25 * l[f - L]!))).toBe(0);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'realtime', rtHealthy: true });
  });
});

describe('MixerCore jitter allowance', () => {
  it('starts from the configured jitter, clamped to [DEFAULT_JITTER, 200 ms]', () => {
    const [l, r] = stereoNoise(SR, 31);
    const latency = (jitter: number) => {
      const h = new MixerHarness(l, r, { jitter });
      h.connectRt(new FakeRealtime(h, 'zero'));
      h.config({ enabled: true, residualGain: 0.5 });
      h.runUntil(SR);
      const delay = h.core.latency;
      expect(maxError(h.outL, delay + 480, SR, (f) => Math.fround(0.5 * l[f - delay]!))).toBe(0);
      expect(h.stats().at(-1)!.latency).toBe(delay);
      return delay;
    };
    expect(latency(4000)).toBe(DFN_DELAY + 4000);
    expect(latency(100)).toBe(L);
    expect(latency(NaN)).toBe(L);
    expect(latency(1e9)).toBe(DFN_DELAY + 9600);
  });

  it('avoids the underruns of large audio callbacks when the jitter is sized for them', () => {
    // Chrome renders the quanta of one device callback back to back: a reply to a hop sent during
    // a callback can only be used from the next one.
    const run = (burst: number, jitter?: number) => {
      const [l, r] = stereoNoise(6 * SR, 41);
      const h = new MixerHarness(l, r, jitter === undefined ? {} : { jitter });
      const rt = new FakeRealtime(h, 'zero');
      rt.delay = () => Math.ceil(h.frame / burst) * burst - h.frame;
      h.connectRt(rt);
      h.config({ enabled: true, residualGain: 0.25 });
      h.runUntil(6 * SR);
      return { underruns: h.stats().at(-1)!.underruns, latency: h.core.latency };
    };
    for (const burst of [2048, 4096]) {
      expect(run(burst).underruns).toBeGreaterThan(0);
      // What the controller passes: callback size + one hop + 10 ms for the model.
      const sized = run(burst, burst + RT_HOP + 480);
      expect(sized).toEqual({ underruns: 0, latency: DFN_DELAY + burst + 960 });
    }
    // 4096-frame callbacks cannot be served within the default maximum at all.
    expect(run(4096).latency).toBe(DFN_DELAY + MAX_JITTER);
  });

  it('grows a large initial jitter by at most 30 ms', () => {
    const [l, r] = stereoNoise(8 * SR, 37);
    const h = new MixerHarness(l, r, { jitter: 4000 });
    const rt = new FakeRealtime(h, 'zero');
    rt.delay = () => 8000; // hopelessly late
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(8 * SR);
    expect(h.core.latency).toBe(DFN_DELAY + 4000 + 3 * RT_HOP);
    expect(h.stats().at(-1)!.underruns).toBeGreaterThan(9);
  });

  it('shrinks a grown jitter by one step per minute of clean real-time output, down to the initial value', () => {
    const n = 140 * SR;
    const x = tones(n, [{ freq: 100, amp: 0.3 }]);
    const h = new MixerHarness(x, x);
    const rt = new FakeRealtime(h, 'zero');
    // Two bursts of late answers within 10 s: the third underrun grows the jitter, twice.
    const late = [0.5, 1, 1.5, 3, 3.5, 4].map((s) => Math.ceil((s * SR) / RT_HOP) * RT_HOP);
    rt.delay = (index) => (late.some((s) => index >= s && index < s + 5 * RT_HOP) ? 2400 : 0);
    h.connectRt(rt);
    h.config({ enabled: true, residualGain: 0.25 });
    h.runUntil(5 * SR);
    expect(h.core.latency).toBe(L + 2 * RT_HOP);
    h.runUntil(64 * SR);
    expect(h.core.latency).toBe(L + 2 * RT_HOP);
    h.runUntil(66 * SR);
    expect(h.core.latency).toBe(L + RT_HOP);
    h.runUntil(n);
    expect(h.core.latency).toBe(L);
    expect(h.stats().at(-1)!.underruns).toBe(6);
    // Each step is a crossfaded skip of 10 ms.
    expect(maxStep(h.outL, 6 * SR, n)).toBeLessThan(0.01);
    expect(maxError(h.outL, n - SR, n, (f) => Math.fround(0.25 * x[f - L]!))).toBe(0);
  });
});
