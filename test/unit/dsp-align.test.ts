import { describe, expect, it } from 'vitest';
import { alignProbe, alignWorkspacesCreated } from '../../src/lib/dsp/align';
import { decodeWithFfmpeg, noise, readFixture, timeMs } from './helpers/dsp-audio';

const PROBE = 4096;

function mid(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(left.length);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (left[i]! + right[i]!);
  return out;
}

describe('alignProbe', () => {
  it('recovers an exact offset and gain in noise', () => {
    const ref = noise(200000, 0.5, 11);
    const offset = 123457;
    const extra = noise(PROBE, 0.01, 12);
    const probe = new Float32Array(PROBE);
    for (let i = 0; i < PROBE; i++) probe[i] = 0.3 * ref[offset + i]! + extra[i]!;
    const res = alignProbe(probe, ref);
    expect(res.found).toBe(true);
    expect(res.offset).toBe(offset);
    expect(res.gain).toBeCloseTo(0.3, 2);
    expect(res.score).toBeGreaterThan(0.95);
  });

  it('finds the first and last possible lags', () => {
    const ref = noise(50000, 0.5, 21);
    for (const offset of [0, 50000 - PROBE]) {
      const res = alignProbe(ref.slice(offset, offset + PROBE), ref);
      expect(res).toMatchObject({ found: true, offset });
      expect(res.score).toBeCloseTo(1, 9);
      expect(res.gain).toBeCloseTo(1, 9);
    }
  });

  it('recovers offsets in the music + speech mix with gain 0.3', () => {
    const wav = readFixture('mix.wav');
    const signal = mid(wav.channels[0]!, wav.channels[1]!);
    const base = 480000;
    const ref = signal.slice(base, base + 200000);
    for (const offset of [1, 4321, 99999, 195000]) {
      const probe = ref.slice(offset, offset + PROBE).map((v) => 0.3 * v);
      const res = alignProbe(probe, ref);
      expect(res).toMatchObject({ found: true, offset });
      expect(res.gain).toBeCloseTo(0.3, 4);
    }
  });

  it('aligns an Opus-decoded probe against the original PCM within one sample', () => {
    const original = readFixture('mix.wav');
    const decoded = decodeWithFfmpeg('mix.webm', 'dsp', 'mix-webm-decoded.wav');
    const ref = mid(original.channels[0]!, original.channels[1]!);
    const dec = mid(decoded.channels[0]!, decoded.channels[1]!);
    const scores: number[] = [];
    for (const at of [100000, 432100, 777777, 1200000]) {
      const windowStart = at - 100000;
      const window = ref.slice(windowStart, windowStart + 200000);
      const res = alignProbe(dec.slice(at, at + PROBE), window);
      expect(res.found).toBe(true);
      expect(Math.abs(res.offset - (at - windowStart))).toBeLessThanOrEqual(1);
      expect(res.gain).toBeGreaterThan(0.9);
      expect(res.gain).toBeLessThan(1.1);
      scores.push(res.score);
    }
    console.log(`Opus vs original alignment scores: ${scores.map((s) => s.toFixed(3)).join(', ')}`);
  });

  it('reports not found for silence, short references and unrelated audio', () => {
    const ref = noise(100000, 0.5, 31);
    expect(alignProbe(new Float32Array(PROBE), ref).found).toBe(false);
    expect(alignProbe(noise(PROBE, 0.5, 32), new Float32Array(100000)).found).toBe(false);
    expect(alignProbe(noise(PROBE, 0.5, 33), ref.subarray(0, PROBE - 1)).found).toBe(false);
    const unrelated = alignProbe(noise(PROBE, 0.5, 34), ref);
    expect(unrelated.found).toBe(false);
    expect(unrelated.score).toBeLessThan(0.2);
  });

  it('ignores silent reference regions', () => {
    const ref = noise(60000, 0.5, 41);
    ref.fill(0, 10000, 30000);
    const offset = 40000;
    const res = alignProbe(ref.slice(offset, offset + PROBE), ref);
    expect(res).toMatchObject({ found: true, offset });
  });

  it('speed: 4096-sample probe against 200k samples (logged, < 30 ms)', () => {
    const ref = noise(200000, 0.5, 51);
    const probe = ref.slice(150000, 150000 + PROBE);
    const ms = timeMs(() => alignProbe(probe, ref), 9);
    console.log(`alignProbe 4096 vs 200000: ${ms.toFixed(2)} ms (median)`);
    expect(ms).toBeLessThan(30);
  });

  it('reuses its FFT workspaces when callers alternate between window sizes', () => {
    const ref = noise(80000, 0.5, 31);
    const probe = ref.slice(20000, 20000 + PROBE);
    // The look-ahead worker searches ±0.25 s (32768-point FFT), then ±0.75 s (131072-point).
    const small = ref.subarray(0, PROBE + 24000);
    alignProbe(probe, small);
    alignProbe(probe, ref);
    const created = alignWorkspacesCreated();
    for (let i = 0; i < 10; i++) {
      expect(alignProbe(probe, small).offset).toBe(20000);
      expect(alignProbe(probe, ref).offset).toBe(20000);
    }
    expect(alignWorkspacesCreated()).toBe(created);
  });
});
