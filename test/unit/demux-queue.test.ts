import { describe, expect, it } from 'vitest';
import { ByteQueue } from '../../src/lib/demux/types';

const bytesOf = (q: ByteQueue, from = q.start, to = q.end) => Array.from(q.bytes.subarray(q.index(from), q.index(to)));

describe('ByteQueue', () => {
  it('addresses bytes by absolute stream position across pushes and discards', () => {
    const q = new ByteQueue();
    q.push(Uint8Array.of(0, 1, 2, 3));
    q.discard(2);
    q.release();
    q.push(Uint8Array.of(4, 5));
    expect([q.start, q.end]).toEqual([2, 6]);
    expect(bytesOf(q)).toEqual([2, 3, 4, 5]);
    expect(bytesOf(q, 3, 5)).toEqual([3, 4]);
  });

  it('borrows a chunk pushed into an empty queue and copies only what release() keeps', () => {
    const q = new ByteQueue();
    const chunk = Uint8Array.of(10, 11, 12, 13, 14);
    q.push(chunk);
    expect(q.bytes).toBe(chunk);
    q.discard(3);
    q.release();
    chunk.fill(0);
    expect(q.bytes).not.toBe(chunk);
    expect(bytesOf(q)).toEqual([13, 14]);
  });

  it('drops bytes before a discard position that lies beyond the end, as they arrive', () => {
    const q = new ByteQueue();
    q.push(Uint8Array.of(0, 1));
    q.discard(5);
    q.release();
    q.push(Uint8Array.of(2, 3));
    expect([q.start, q.end]).toEqual([4, 4]);
    q.push(Uint8Array.of(4, 5, 6));
    expect([q.start, q.end]).toEqual([5, 7]);
    expect(bytesOf(q)).toEqual([5, 6]);
  });

  it('grows and compacts its storage while keeping the content', () => {
    const q = new ByteQueue();
    const expected: number[] = [];
    let start = 0;
    for (let k = 0; k < 2000; k++) {
      const chunk = Uint8Array.from({ length: (k * 37) % 300 }, (_, i) => (k + i) & 0xff);
      q.push(chunk);
      expected.push(...chunk);
      if (k % 3 === 0) {
        const drop = Math.floor((q.end - q.start) / 2);
        q.discard(q.start + drop);
        expected.splice(0, drop);
        start += drop;
      }
      q.release();
      chunk.fill(0);
    }
    expect(q.start).toBe(start);
    expect(bytesOf(q)).toEqual(expected);
  });

  it('clear() drops everything and keeps counting positions', () => {
    const q = new ByteQueue();
    q.push(Uint8Array.of(1, 2, 3));
    q.release();
    q.clear();
    q.push(Uint8Array.of(4));
    expect([q.start, q.end]).toEqual([3, 4]);
    expect(bytesOf(q)).toEqual([4]);
  });
});
