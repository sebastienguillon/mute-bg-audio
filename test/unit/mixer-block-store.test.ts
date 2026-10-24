import { describe, expect, it } from 'vitest';
import { BlockCursor, BlockStore } from '../../src/lib/mixer/block-store';

/** Block of `length` frames whose samples encode (tag, media index). */
function block(store: BlockStore, timeline: number, start: number, length: number, tag: number): boolean {
  const make = (c: number) => Float32Array.from({ length }, (_, i) => tag * 1000 + (start + i + 100) + c / 10);
  return store.insert(timeline, start, make(1), make(2), make(3), make(4));
}

/** Tag of the data stored at media index m (or null). */
function tagAt(store: BlockStore, timeline: number, m: number): number | null {
  const b = store.find(timeline, m, new BlockCursor());
  if (b === null) return null;
  const v = b.speechL[m - b.start]!;
  expect(v - Math.floor(v / 1000) * 1000).toBeCloseTo(m + 100.1, 2); // the sample belongs to index m
  expect(b.residualR[m - b.start]! - v).toBeCloseTo(0.3, 2);
  return Math.floor(v / 1000);
}

function layout(store: BlockStore, timeline: number, from: number, to: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let m = from; m < to; m++) out.push(tagAt(store, timeline, m));
  return out;
}

describe('BlockStore', () => {
  it('finds blocks and measures contiguous coverage', () => {
    const s = new BlockStore(1e6);
    block(s, 1, 100, 50, 1);
    block(s, 1, 150, 50, 2);
    block(s, 1, 300, 10, 3);
    block(s, 2, 0, 10, 4);
    expect(s.blockCount).toBe(4);
    expect(s.frames).toBe(120);
    expect(tagAt(s, 1, 99)).toBeNull();
    expect(tagAt(s, 1, 100)).toBe(1);
    expect(tagAt(s, 1, 150)).toBe(2);
    expect(tagAt(s, 1, 200)).toBeNull();
    expect(tagAt(s, 2, 5)).toBe(4);
    expect(tagAt(s, 3, 5)).toBeNull();
    expect(s.contiguousAhead(1, 120)).toBe(80);
    expect(s.contiguousAhead(1, 250)).toBe(0);
    expect(s.contiguousAhead(1, 305)).toBe(5);
  });

  it('replaces older data for the same indices (trim, split, cover)', () => {
    const s = new BlockStore(1e6);
    block(s, 1, 0, 10, 1);
    block(s, 1, 10, 10, 2);
    block(s, 1, 20, 10, 3);
    block(s, 1, 5, 20, 4); // trims 1 and 3, removes 2
    expect(layout(s, 1, 0, 30)).toEqual([...Array(5).fill(1), ...Array(20).fill(4), ...Array(5).fill(3)]);
    block(s, 1, 8, 4, 5); // splits 4
    expect(layout(s, 1, 0, 30)).toEqual([
      ...Array(5).fill(1),
      ...Array(3).fill(4),
      ...Array(4).fill(5),
      ...Array(13).fill(4),
      ...Array(5).fill(3),
    ]);
    block(s, 1, -5, 40, 6); // covers everything
    expect(layout(s, 1, -5, 35)).toEqual(Array(40).fill(6));
    expect(s.blockCount).toBe(1);
    expect(s.frames).toBe(40);
  });

  it('rejects invalid blocks', () => {
    const s = new BlockStore(1e6);
    const a = new Float32Array(10);
    expect(s.insert(1, 0, a, a, a, new Float32Array(9))).toBe(false);
    expect(s.insert(1, 0.5, a, a, a, a)).toBe(false);
    expect(s.insert(1, 0, new Float32Array(0), new Float32Array(0), new Float32Array(0), new Float32Array(0))).toBe(
      false,
    );
    expect(s.blockCount).toBe(0);
  });

  it('flushes one timeline or all and invalidates cursors', () => {
    const s = new BlockStore(1e6);
    block(s, 1, 0, 10, 1);
    block(s, 2, 0, 10, 2);
    const cursor = new BlockCursor();
    expect(s.find(1, 3, cursor)).not.toBeNull();
    s.flush(1);
    expect(s.find(1, 3, cursor)).toBeNull();
    expect(tagAt(s, 2, 3)).toBe(2);
    s.flush();
    expect(s.blockCount).toBe(0);
    expect(s.frames).toBe(0);
  });

  it('evicts data far behind the locked position first, then the oldest, never the current block', () => {
    const s = new BlockStore(100);
    block(s, 2, 0, 20, 9); // other timeline, oldest
    for (let k = 0; k < 4; k++) block(s, 1, k * 20, 20, k + 1);
    expect(s.frames).toBe(100);
    block(s, 1, 80, 20, 5); // 120 frames stored
    s.enforceBudget(1, 65, 30); // behind limit 35: block [0, 20) of timeline 1 goes first
    expect(s.frames).toBe(100);
    expect(tagAt(s, 1, 10)).toBeNull();
    expect(tagAt(s, 2, 10)).toBe(9);
    block(s, 1, 100, 20, 6);
    s.enforceBudget(1, 65, 30); // [20, 40) ends at 40 > 35: not "far behind" → oldest = timeline 2
    expect(tagAt(s, 2, 10)).toBeNull();
    expect(tagAt(s, 1, 30)).toBe(2);
    block(s, 1, 120, 60, 7);
    s.enforceBudget(1, 65, 30); // oldest first, skipping [60, 80) that contains the position
    expect(layout(s, 1, 0, 180).filter((t) => t !== null).length).toBeLessThanOrEqual(100);
    expect(tagAt(s, 1, 65)).toBe(4);
    expect(tagAt(s, 1, 30)).toBeNull();
    expect(tagAt(s, 1, 50)).toBeNull();
    expect(s.frames).toBeLessThanOrEqual(100);
  });
});
