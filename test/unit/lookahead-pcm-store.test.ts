import { describe, expect, it } from 'vitest';
import { CHUNK_SAMPLES, PcmStore } from '../../src/lib/lookahead/pcm-store';

/** Ramp whose value encodes the media index (left) and its negation (right). */
function ramp(start: number, length: number, tag = 0): [Float32Array, Float32Array] {
  const l = new Float32Array(length);
  const r = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    l[i] = ((start + i) % 100003) + tag;
    r[i] = -l[i]!;
  }
  return [l, r];
}

function readAll(store: PcmStore, start: number, length: number): { l: Float32Array; r: Float32Array; covered: number } {
  const l = new Float32Array(length);
  const r = new Float32Array(length);
  const covered = store.read(start, length, l, r);
  return { l, r, covered };
}

describe('PcmStore', () => {
  it('writes, merges contiguous ranges and reads back with zeros where missing', () => {
    const store = new PcmStore();
    store.write(1000, ...ramp(1000, 500));
    store.write(1500, ...ramp(1500, 700)); // adjacent: merges
    store.write(5000, ...ramp(5000, 100));
    expect(store.ranges()).toEqual([
      { start: 1000, end: 2200 },
      { start: 5000, end: 5100 },
    ]);
    expect(store.size).toBe(1300);
    const { l, r, covered } = readAll(store, 900, 4300);
    expect(covered).toBe(1300);
    for (let i = 0; i < 4300; i++) {
      const m = 900 + i;
      const inside = (m >= 1000 && m < 2200) || (m >= 5000 && m < 5100);
      expect(l[i]).toBe(inside ? m % 100003 : 0);
      expect(r[i]).toBe(inside ? -(m % 100003) : 0);
    }
  });

  it('overwrites overlapping data and merges overlapping ranges', () => {
    const store = new PcmStore();
    store.write(0, ...ramp(0, 40000));
    store.write(60000, ...ramp(60000, 10000));
    // Bridges both ranges and overwrites parts of them.
    store.write(30000, ...ramp(30000, 35000, 0.5));
    expect(store.ranges()).toEqual([{ start: 0, end: 70000 }]);
    expect(store.size).toBe(70000);
    const { l } = readAll(store, 0, 70000);
    for (const m of [0, 29999, 30000, 50000, 64999]) expect(l[m]).toBe((m % 100003) + (m >= 30000 && m < 65000 ? 0.5 : 0));
    expect(l[65000]).toBe(65000);
  });

  it('answers coverage queries', () => {
    const store = new PcmStore();
    store.write(100, ...ramp(100, 100));
    store.write(300, ...ramp(300, 50));
    expect(store.contiguousEnd(100)).toBe(200);
    expect(store.contiguousEnd(199)).toBe(200);
    expect(store.contiguousEnd(200)).toBe(200); // not covered: the index itself
    expect(store.contiguousEnd(50)).toBe(50);
    expect(store.contiguousEnd(320)).toBe(350);
    expect(store.nextCovered(0)).toBe(100);
    expect(store.nextCovered(150)).toBe(150);
    expect(store.nextCovered(200)).toBe(300);
    expect(store.nextCovered(350)).toBeNull();
    expect(store.covers(120, 200)).toBe(true);
    expect(store.covers(120, 201)).toBe(false);
    expect(store.covers(250, 250)).toBe(true);
  });

  it('supports negative and very large media indices', () => {
    const store = new PcmStore();
    const big = 48000 * 3600 * 24 * 30; // 30 days of live stream
    store.write(-5000, ...ramp(0, 10000));
    store.write(big, ...ramp(big, 20000));
    expect(store.ranges()).toEqual([
      { start: -5000, end: 5000 },
      { start: big, end: big + 20000 },
    ]);
    const { l } = readAll(store, big - 10, 30);
    expect(l[9]).toBe(0);
    expect(l[10]).toBe(big % 100003);
    const neg = readAll(store, -5001, 3);
    expect([...neg.l]).toEqual([0, 0, 1]);
  });

  it('removes ranges, splitting covered runs and releasing empty chunks', () => {
    const store = new PcmStore();
    store.write(0, ...ramp(0, 10 * CHUNK_SAMPLES));
    expect(store.allocatedSamples).toBe(10 * CHUNK_SAMPLES);
    store.remove(2 * CHUNK_SAMPLES + 5, 7 * CHUNK_SAMPLES - 5);
    expect(store.ranges()).toEqual([
      { start: 0, end: 2 * CHUNK_SAMPLES + 5 },
      { start: 7 * CHUNK_SAMPLES - 5, end: 10 * CHUNK_SAMPLES },
    ]);
    // Chunks 3..5 are empty now; 2 and 6 still hold samples.
    expect(store.allocatedSamples).toBe(7 * CHUNK_SAMPLES);
    expect(store.size).toBe(10 * CHUNK_SAMPLES - (5 * CHUNK_SAMPLES - 10));
    const { l, covered } = readAll(store, 2 * CHUNK_SAMPLES, 5 * CHUNK_SAMPLES);
    expect(covered).toBe(10);
    expect(l[4]).toBe((2 * CHUNK_SAMPLES + 4) % 100003);
    expect(l[5]).toBe(0);
    store.remove(-Infinity, Infinity);
    expect(store.ranges()).toEqual([]);
    expect(store.allocatedSamples).toBe(0);
    expect(store.size).toBe(0);
  });

  it('evicts outside a window', () => {
    const store = new PcmStore();
    store.write(0, ...ramp(0, 48000 * 20));
    store.write(48000 * 100, ...ramp(48000 * 100, 48000));
    store.evictOutside(48000 * 5, 48000 * 12);
    expect(store.ranges()).toEqual([{ start: 48000 * 5, end: 48000 * 12 }]);
    expect(store.allocatedSamples).toBeLessThanOrEqual(48000 * 7 + 2 * CHUNK_SAMPLES);
    store.clear();
    expect(store.ranges()).toEqual([]);
    expect(store.allocatedSamples).toBe(0);
  });

  it('frees its chunk pool on clear()', () => {
    const store = new PcmStore();
    store.write(0, ...ramp(0, 40 * CHUNK_SAMPLES));
    store.remove(0, 10 * CHUNK_SAMPLES);
    // Released chunks are kept for reuse (at most 32)…
    expect(store.pooledSamples).toBe(10 * CHUNK_SAMPLES);
    store.write(100 * CHUNK_SAMPLES, ...ramp(0, 4 * CHUNK_SAMPLES));
    expect(store.pooledSamples).toBe(6 * CHUNK_SAMPLES);
    // …until the store is cleared (an inactive or closed timeline): then nothing stays allocated.
    store.clear();
    expect(store.allocatedSamples).toBe(0);
    expect(store.pooledSamples).toBe(0);
  });

  it('tells whether a write would replace stored samples with audibly different ones', () => {
    const store = new PcmStore();
    const [l, r] = ramp(0, 3 * CHUNK_SAMPLES);
    const scale = (a: Float32Array, k: number) => a.map((v) => v * k);
    store.write(CHUNK_SAMPLES, l.subarray(0, CHUNK_SAMPLES), r.subarray(0, CHUNK_SAMPLES));
    // Nothing stored there, or the same samples: no change.
    expect(store.differs(5 * CHUNK_SAMPLES, l, r)).toBe(false);
    expect(store.differs(CHUNK_SAMPLES, l.subarray(0, CHUNK_SAMPLES), r.subarray(0, CHUNK_SAMPLES))).toBe(false);
    // −40 dB of difference is inaudible; −20 dB is a change. Only the stored part counts.
    expect(store.differs(CHUNK_SAMPLES, scale(l, 1.01), scale(r, 1.01))).toBe(false);
    expect(store.differs(0, scale(l, 1.1), scale(r, 1.1))).toBe(true);
    expect(store.differs(CHUNK_SAMPLES - 10, new Float32Array(20), new Float32Array(20))).toBe(true);
  });

  it('stores provisional samples: fill() keeps settled ones, differs() ignores them, settled writes replace them', () => {
    const store = new PcmStore();
    store.write(1000, ...ramp(1000, 1000));
    // Fills only what is missing: [500, 1000) and [2000, 2500), marked provisional.
    store.fill(500, ...ramp(500, 2000, 0.5), true);
    expect(store.ranges()).toEqual([{ start: 500, end: 2500 }]);
    expect(store.provisionalRanges()).toEqual([
      { start: 500, end: 1000 },
      { start: 2000, end: 2500 },
    ]);
    const { l } = readAll(store, 500, 2000);
    expect([l[0], l[499], l[500], l[1499], l[1500]]).toEqual([500.5, 999.5, 1000, 1999, 2000.5]);
    // Other audio over provisional samples is no change; over settled ones it is.
    const silence = (n: number) => [new Float32Array(n), new Float32Array(n)] as const;
    expect(store.differs(500, ...silence(500))).toBe(false);
    expect(store.differs(500, ...silence(600))).toBe(true);
    // A settled fill replaces provisional samples only; a provisional fill leaves them alone.
    store.fill(400, ...ramp(400, 700, 0.25), true);
    expect(readAll(store, 400, 700).l.slice(0, 101)[100]).toBe(500.5);
    store.fill(2400, ...ramp(2400, 200, 0.25), false);
    expect(store.provisionalRanges()).toEqual([
      { start: 400, end: 1000 },
      { start: 2000, end: 2400 },
    ]);
    expect(readAll(store, 2399, 202).l.slice(0, 3)).toEqual(new Float32Array([2399.5, 2400.25, 2401.25]));
    // write() and remove() drop the marks of their range, clear() all of them.
    store.write(900, ...ramp(900, 200));
    store.remove(2000, 2100);
    expect(store.provisionalRanges()).toEqual([
      { start: 400, end: 900 },
      { start: 2100, end: 2400 },
    ]);
    store.clear();
    expect(store.provisionalRanges()).toEqual([]);
  });

  it('with a focus, bounds its size by dropping the data farthest from the focus', () => {
    const store = new PcmStore({ maxSamples: 8 * CHUNK_SAMPLES });
    const frame = 960;
    for (let m = 0; m < 6 * CHUNK_SAMPLES; m += frame) store.write(m, ...ramp(m, frame));
    // Data behind the focus (a replay of old appends) goes, not the data around it.
    store.setFocus(5 * CHUNK_SAMPLES);
    for (let m = -10 * CHUNK_SAMPLES; m < 0; m += frame) store.write(m, ...ramp(m, frame));
    expect(store.allocatedSamples).toBeLessThanOrEqual(8 * CHUNK_SAMPLES);
    const ranges = store.ranges();
    expect(ranges[ranges.length - 1]!.end).toBe(Math.ceil((6 * CHUNK_SAMPLES) / frame) * frame);
    expect(ranges[0]!.start).toBeGreaterThan(-3 * CHUNK_SAMPLES);
  });

  it('bounds its size by dropping the data farthest from the latest write', () => {
    const store = new PcmStore({ maxSamples: 8 * CHUNK_SAMPLES });
    const frame = 960;
    for (let m = 0; m < 30 * CHUNK_SAMPLES; m += frame) store.write(m, ...ramp(m, frame));
    expect(store.allocatedSamples).toBeLessThanOrEqual(8 * CHUNK_SAMPLES);
    const [range] = store.ranges();
    expect(store.ranges()).toHaveLength(1);
    // The newest data is kept.
    expect(range!.end).toBe(Math.ceil((30 * CHUNK_SAMPLES) / frame) * frame);
    expect(range!.start).toBeGreaterThanOrEqual(range!.end - 8 * CHUNK_SAMPLES);
    // Writing far behind now drops the far end instead.
    store.write(0, ...ramp(0, frame));
    expect(store.ranges()[0]).toEqual({ start: 0, end: frame });
    expect(store.allocatedSamples).toBeLessThanOrEqual(8 * CHUNK_SAMPLES);
  });

  it('matches a naive model under random operations (including provisional fills)', () => {
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed % n;
    };
    const size = 200000;
    const model = new Float32Array(size);
    const has = new Uint8Array(size);
    const prov = new Uint8Array(size);
    const store = new PcmStore();
    for (let step = 0; step < 400; step++) {
      const start = rand(size - 1);
      const length = 1 + rand(Math.min(30000, size - start));
      const op = rand(12);
      const l = new Float32Array(length).map((_, i) => step * 1000 + i);
      if (op < 6) {
        store.write(start, l, l.map((v) => -v));
        model.set(l, start);
        has.fill(1, start, start + length);
        prov.fill(0, start, start + length);
      } else if (op < 8) {
        const provisional = op === 6;
        store.fill(start, l, l.map((v) => -v), provisional);
        for (let i = start; i < start + length; i++) {
          if (has[i] && !(prov[i] && !provisional)) continue;
          model[i] = l[i - start]!;
          prov[i] = provisional && !has[i] ? 1 : 0;
          has[i] = 1;
        }
      } else if (op < 11) {
        store.remove(start, start + length);
        has.fill(0, start, start + length);
        prov.fill(0, start, start + length);
      } else {
        store.evictOutside(start, start + length);
        has.fill(0, 0, start);
        has.fill(0, start + length);
        prov.fill(0, 0, start);
        prov.fill(0, start + length);
      }
      if (step % 20 === 0 || step === 399) {
        const { l, r, covered } = readAll(store, 0, size);
        let expected = 0;
        for (let i = 0; i < size; i++) {
          const v = has[i] ? model[i]! : 0;
          expected += has[i]!;
          if (l[i] !== v || r[i] !== (v === 0 ? 0 : -v)) throw new Error(`mismatch at ${i} after step ${step}`);
        }
        expect(covered).toBe(expected);
        expect(store.size).toBe(expected);
        const probe = rand(size);
        let end = probe;
        while (end < size && has[end]) end++;
        expect(store.contiguousEnd(probe)).toBe(end);
        const marks: { start: number; end: number }[] = [];
        for (let i = 0; i < size; i++) {
          if (!prov[i]) continue;
          const last = marks[marks.length - 1];
          if (last?.end === i) last.end++;
          else marks.push({ start: i, end: i + 1 });
        }
        expect(store.provisionalRanges()).toEqual(marks);
      }
    }
  });

  it('stores and reads 10 minutes of 20 ms frames quickly', () => {
    const store = new PcmStore();
    const frame = 960;
    const total = 48000 * 600;
    const [l, r] = ramp(0, frame);
    const t0 = performance.now();
    for (let m = 0; m < total; m += frame) store.write(m, l, r);
    const t1 = performance.now();
    const outL = new Float32Array(48000 * 6);
    const outR = new Float32Array(48000 * 6);
    for (let m = 0; m < total; m += outL.length) store.read(m, outL.length, outL, outR);
    const t2 = performance.now();
    expect(store.ranges()).toEqual([{ start: 0, end: total }]);
    console.log(`PcmStore: 10 min in 20 ms frames: write ${(t1 - t0).toFixed(1)} ms, read in 6 s blocks ${(t2 - t1).toFixed(1)} ms`);
    expect(t1 - t0).toBeLessThan(500);
    expect(t2 - t1).toBeLessThan(500);
  });
});
