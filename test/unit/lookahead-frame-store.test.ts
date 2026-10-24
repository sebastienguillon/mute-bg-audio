import { describe, expect, it } from 'vitest';
import type { AudioCodecConfig } from '../../src/lib/demux/index';
import { FrameStore, type StoredFrame } from '../../src/lib/lookahead/frame-store';

const config: AudioCodecConfig = { codec: 'opus', sampleRate: 48000, channels: 2 };

/** A 20 ms frame of `bytes` bytes at `time` seconds (1 ms of timestamp jitter allowed). */
function frame(time: number, bytes = 100, tag = 0): StoredFrame {
  return { frame: { pts: time, duration: 0.02, data: new Uint8Array(bytes).fill(tag) }, time, position: time, config, addedAt: 0 };
}

const times = (store: FrameStore, start = -Infinity, end = Infinity) => store.overlapping(start, end).map((f) => +f.time.toFixed(3));

describe('FrameStore', () => {
  it('keeps frames sorted; a frame replaces the frames it overlaps, not neighbours with jittered timestamps', () => {
    const store = new FrameStore(1e6);
    for (const t of [0, 0.021, 0.041, 0.061]) store.add(frame(t));
    store.add(frame(-0.02));
    expect(times(store)).toEqual([-0.02, 0, 0.021, 0.041, 0.061]);
    // Re-appended frame at the same time, and one overlapping two frames.
    store.add(frame(0.021, 100, 7));
    store.add(frame(0.05, 100, 9));
    expect(times(store)).toEqual([-0.02, 0, 0.021, 0.05]);
    expect(store.at(0.0205, 0.002)!.frame.data[0]).toBe(7);
    expect(store.at(0.03, 0.002)).toBeUndefined();
    expect(times(store, 0.03, 0.06)).toEqual([0.021, 0.05]);
    expect(store.bytes).toBe(4 * (100 + 128));
  });

  it('removes the frames starting in a range, like SourceBuffer.remove()', () => {
    const store = new FrameStore(1e6);
    for (let k = 0; k < 10; k++) store.add(frame(k * 0.02));
    store.remove(0.03, 0.1);
    expect(times(store)).toEqual([0, 0.02, 0.1, 0.12, 0.14, 0.16, 0.18]);
    store.remove(0.15, Infinity);
    expect(times(store)).toEqual([0, 0.02, 0.1, 0.12, 0.14]);
    store.clear();
    expect(store.bytes).toBe(0);
  });

  it('drops the frames farthest from the focus first and does not leave holes', () => {
    const store = new FrameStore(10 * 228);
    store.setFocus(1);
    for (let k = 0; k < 100; k++) store.add(frame(k * 0.02, k % 3 === 0 ? 100 : 60));
    const kept = times(store);
    // A contiguous run around the focus (frames of different sizes do not slip into gaps).
    for (let i = 1; i < kept.length; i++) expect(kept[i]! - kept[i - 1]!).toBeCloseTo(0.02, 6);
    expect(kept[0]!).toBeLessThan(1);
    expect(kept[kept.length - 1]!).toBeGreaterThan(1);
    expect(store.bytes).toBeLessThanOrEqual(10 * 228);
    // With the focus at the end, new frames push out the earliest ones.
    store.setFocus(5);
    for (let k = 100; k < 120; k++) store.add(frame(k * 0.02));
    const later = times(store);
    expect(later[later.length - 1]).toBeCloseTo(2.38, 6);
    expect(later[0]!).toBeGreaterThan(kept[0]!);
  });

  it('finds the pre-roll of a decoder: the stored frames of the same configuration leading up to a time', () => {
    const store = new FrameStore(1e6);
    // 0–0.1 s and 0.2–0.3 s (1 ms of jitter on every other frame), then a frame of another configuration.
    for (let k = 0; k < 5; k++) store.add(frame(k * 0.02 + (k % 2) * 0.001));
    for (let k = 10; k < 15; k++) store.add(frame(k * 0.02));
    const other = { ...config, channels: 1 };
    store.add({ ...frame(0.3), config: other });
    const preroll = (time: number, seconds: number, c = config) => store.preceding(time, seconds, 0.005, c).map((f) => +f.time.toFixed(3));
    expect(preroll(0.1, 0.1)).toEqual([0, 0.021, 0.04, 0.061, 0.08]);
    expect(preroll(0.1, 0.05)).toEqual([0.04, 0.061, 0.08]);
    // At the start of a stored frame (an overlapping re-append), the frames before it.
    expect(preroll(0.24, 0.1)).toEqual([0.2, 0.22]);
    // Nothing contiguous before (a gap), or only frames of another configuration.
    expect(preroll(0.2, 0.1)).toEqual([]);
    expect(preroll(0.13, 0.1)).toEqual([]);
    expect(preroll(0.32, 0.1)).toEqual([]);
    expect(preroll(0.32, 0.1, other)).toEqual([0.3]);
    // Frames shorter than the tolerance: the stored frame at the time itself (1 ms early) is not pre-roll.
    const short = new FrameStore(1e6);
    const shortFrame = (time: number): StoredFrame => ({ ...frame(time), frame: { pts: time, duration: 0.0025, data: new Uint8Array(10) } });
    for (const t of [0, 0.0025, 0.005, 0.0065]) short.add(shortFrame(t));
    expect(short.preceding(0.0075, 0.1, 0.002, config).map((f) => f.time)).toEqual([0, 0.0025, 0.005]);
  });
});
