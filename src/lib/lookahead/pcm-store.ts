/**
 * Media-indexed stereo PCM of one timeline (48 kHz): sparse fixed-size chunks addressed by
 * floor(index / CHUNK_SAMPLES), plus a sorted list of covered index ranges. Writes copy only the
 * written samples; coverage bookkeeping is O(number of ranges), which stays small (one range
 * per contiguous buffered region).
 *
 * Samples can be stored as *provisional*: the first output of a decoder that started without
 * enough pre-roll, which differs from a continuous decode for a few tens of milliseconds. They
 * are read like any other samples, but differs() ignores them and a settled write replaces them.
 */

/** Samples per channel and storage chunk (~341 ms at 48 kHz). */
export const CHUNK_SAMPLES = 16384;

/** Released chunks kept for reuse (at most 4 MiB) until clear(). */
const POOL_LIMIT = 32;
/** A write changes stored audio when the difference is above −30 dB of the louder of both. */
const CHANGE_RATIO = 1e-3;
/** Differences below this mean square per sample (−100 dBFS) never count as a change. */
const MIN_CHANGE_POWER = 1e-10;

/** Half-open range [start, end) of media indices. */
export interface PcmRange {
  start: number;
  end: number;
}

export interface PcmStoreOptions {
  /**
   * Upper bound of the stored samples per channel (rounded up to whole chunks). When a write
   * exceeds it, the stored data farthest from the written range is dropped. Default: unbounded.
   */
  maxSamples?: number;
}

interface Chunk {
  left: Float32Array;
  right: Float32Array;
}

export class PcmStore {
  private readonly chunks = new Map<number, Chunk>();
  /** Sorted, disjoint and non-adjacent covered ranges. */
  private readonly covered: PcmRange[] = [];
  /** Sorted, disjoint covered ranges holding provisional samples. */
  private readonly provisional: PcmRange[] = [];
  private readonly pool: Chunk[] = [];
  private readonly maxChunks: number;
  private coveredSamples = 0;
  /** Media index the size bound keeps data around (null: around the latest write). */
  private focus: number | null = null;

  constructor(opts: PcmStoreOptions = {}) {
    const max = opts.maxSamples ?? Infinity;
    if (!(max > 0)) throw new RangeError(`maxSamples must be positive, got ${max}`);
    this.maxChunks = Math.max(2, Math.ceil(max / CHUNK_SAMPLES));
  }

  /** Covered samples per channel. */
  get size(): number {
    return this.coveredSamples;
  }

  /** Allocated samples per channel (whole chunks). */
  get allocatedSamples(): number {
    return this.chunks.size * CHUNK_SAMPLES;
  }

  /** Samples per channel of the released chunks kept for reuse. */
  get pooledSamples(): number {
    return this.pool.length * CHUNK_SAMPLES;
  }

  /**
   * Stores left/right (same length) at media indices [start, start + length), overwriting
   * overlapping data (provisional or not). The arrays are copied.
   */
  write(start: number, left: Float32Array, right: Float32Array): void {
    checkWrite('write', start, left, right);
    const end = start + left.length;
    if (end === start) return;
    this.copyIn(start, left, right, start, end);
    subtractRange(this.provisional, start, end);
    this.enforceBound(start, end);
  }

  /**
   * Like write(), but only into the parts of [start, start + length) that hold no samples or,
   * unless `provisional`, provisional ones: stored settled samples are kept. With `provisional`,
   * the written samples are marked provisional.
   */
  fill(start: number, left: Float32Array, right: Float32Array, provisional: boolean): void {
    checkWrite('fill', start, left, right);
    const end = start + left.length;
    if (end === start) return;
    const writable = this.uncovered(start, end);
    if (!provisional) writable.push(...intersection(this.provisional, start, end));
    if (writable.length === 0) return;
    for (const { start: from, end: to } of writable) {
      this.copyIn(start, left, right, from, to);
      if (provisional) addRange(this.provisional, from, to);
      else subtractRange(this.provisional, from, to);
    }
    this.enforceBound(start, end);
  }

  /**
   * Copies media indices [start, start + length) into outL/outR[0, length), with zeros where
   * nothing is stored. Returns the number of covered samples.
   */
  read(start: number, length: number, outL: Float32Array, outR: Float32Array): number {
    if (outL.length < length || outR.length < length) throw new RangeError(`PcmStore.read: outputs need ${length} samples`);
    outL.fill(0, 0, length);
    outR.fill(0, 0, length);
    const end = start + length;
    let total = 0;
    for (let r = this.firstEndingAfter(start); r < this.covered.length; r++) {
      const range = this.covered[r]!;
      if (range.start >= end) break;
      const from = Math.max(range.start, start);
      const to = Math.min(range.end, end);
      this.copyOut(from, to, outL, outR, from - start);
      total += to - from;
    }
    return total;
  }

  /**
   * True when writing left/right at `start` would replace stored samples with audibly different
   * audio: the difference over the stored part is more than −30 dB below the louder of the two.
   * Provisional samples do not count as stored.
   */
  differs(start: number, left: Float32Array, right: Float32Array): boolean {
    const end = start + left.length;
    let diff = 0;
    let stored = 0;
    let incoming = 0;
    let overlap = 0;
    for (const settled of this.settled(start, end)) {
      for (let index = settled.start; index < settled.end; ) {
        const key = Math.floor(index / CHUNK_SAMPLES);
        const offset = index - key * CHUNK_SAMPLES;
        const length = Math.min(CHUNK_SAMPLES - offset, settled.end - index);
        const chunk = this.chunks.get(key)!;
        for (let i = 0, j = index - start; i < length; i++, j++) {
          const a = chunk.left[offset + i]!;
          const b = chunk.right[offset + i]!;
          const x = left[j]!;
          const y = right[j]!;
          diff += (a - x) * (a - x) + (b - y) * (b - y);
          stored += a * a + b * b;
          incoming += x * x + y * y;
        }
        index += length;
        overlap += length;
      }
    }
    return diff > CHANGE_RATIO * Math.max(stored, incoming) && diff > MIN_CHANGE_POWER * 2 * overlap;
  }

  /** End of the covered run containing `index`, or `index` itself when it is not covered. */
  contiguousEnd(index: number): number {
    const range = this.covered[this.firstEndingAfter(index)];
    return range !== undefined && range.start <= index ? range.end : index;
  }

  /** First covered index >= `index`, or null when nothing is stored at or after it. */
  nextCovered(index: number): number | null {
    const range = this.covered[this.firstEndingAfter(index)];
    return range === undefined ? null : Math.max(range.start, index);
  }

  /** True when every index of [start, end) is covered. */
  covers(start: number, end: number): boolean {
    return end <= start || this.contiguousEnd(start) >= end;
  }

  /** Copy of the covered ranges, sorted. */
  ranges(): PcmRange[] {
    return this.covered.map((r) => ({ start: r.start, end: r.end }));
  }

  /** Copy of the ranges holding provisional samples, sorted. */
  provisionalRanges(): PcmRange[] {
    return this.provisional.map((r) => ({ start: r.start, end: r.end }));
  }

  /**
   * Sets the media index (the playhead) around which the size bound keeps data: it then drops
   * the data farthest from it, instead of the data farthest from the latest write. null: unset.
   */
  setFocus(index: number | null): void {
    this.focus = index;
  }

  /** Drops media indices [start, end) (bounds may be infinite). */
  remove(start: number, end: number): void {
    if (!(end > start) || this.covered.length === 0) return;
    const covered = this.covered;
    const kept: PcmRange[] = [];
    const first = this.firstEndingAfter(start);
    let last = first;
    while (last < covered.length && covered[last]!.start < end) {
      const range = covered[last]!;
      if (range.start < start) kept.push({ start: range.start, end: start });
      if (range.end > end) kept.push({ start: end, end: range.end });
      this.coveredSamples -= Math.min(range.end, end) - Math.max(range.start, start);
      last++;
    }
    if (last === first) return;
    const lo = covered[first]!.start;
    const hi = covered[last - 1]!.end;
    covered.splice(first, last - first, ...kept);
    subtractRange(this.provisional, start, end);
    this.releaseUncovered(Math.max(lo, start), Math.min(hi, end));
  }

  /** Drops everything outside [keepFrom, keepTo). */
  evictOutside(keepFrom: number, keepTo: number): void {
    this.remove(-Infinity, keepFrom);
    this.remove(keepTo, Infinity);
  }

  /** Drops all data and frees the memory, including the chunks kept for reuse. */
  clear(): void {
    this.chunks.clear();
    this.pool.length = 0;
    this.covered.length = 0;
    this.provisional.length = 0;
    this.coveredSamples = 0;
  }

  /** Index of the first covered range whose end is > index (covered.length when none). */
  private firstEndingAfter(index: number): number {
    const covered = this.covered;
    let lo = 0;
    let hi = covered.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (covered[mid]!.end > index) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  private addCoverage(start: number, end: number): void {
    const covered = this.covered;
    // Ranges touching [start, end) (including adjacent ones) merge into one.
    const first = this.firstEndingAfter(start - 1);
    let last = first;
    let mergedStart = start;
    let mergedEnd = end;
    let absorbed = 0;
    while (last < covered.length && covered[last]!.start <= end) {
      const range = covered[last]!;
      mergedStart = Math.min(mergedStart, range.start);
      mergedEnd = Math.max(mergedEnd, range.end);
      absorbed += range.end - range.start;
      last++;
    }
    covered.splice(first, last - first, { start: mergedStart, end: mergedEnd });
    this.coveredSamples += mergedEnd - mergedStart - absorbed;
  }

  /** Copies left/right[from − start, to − start) to media indices [from, to) and covers them. */
  private copyIn(start: number, left: Float32Array, right: Float32Array, from: number, to: number): void {
    for (let index = from; index < to; ) {
      const key = Math.floor(index / CHUNK_SAMPLES);
      const offset = index - key * CHUNK_SAMPLES;
      const length = Math.min(CHUNK_SAMPLES - offset, to - index);
      const chunk = this.chunks.get(key) ?? this.allocate(key);
      const i = index - start;
      chunk.left.set(left.subarray(i, i + length), offset);
      chunk.right.set(right.subarray(i, i + length), offset);
      index += length;
    }
    this.addCoverage(from, to);
  }

  /** Sub-ranges of [start, end) without stored samples. */
  private uncovered(start: number, end: number): PcmRange[] {
    const out: PcmRange[] = [];
    let pos = start;
    for (let r = this.firstEndingAfter(start); r < this.covered.length && pos < end; r++) {
      const range = this.covered[r]!;
      if (range.start >= end) break;
      if (range.start > pos) out.push({ start: pos, end: range.start });
      pos = Math.max(pos, range.end);
    }
    if (pos < end) out.push({ start: pos, end });
    return out;
  }

  /** Sub-ranges of [start, end) holding settled (stored, not provisional) samples. */
  private settled(start: number, end: number): PcmRange[] {
    const out: PcmRange[] = [];
    for (let r = this.firstEndingAfter(start); r < this.covered.length; r++) {
      const range = this.covered[r]!;
      if (range.start >= end) break;
      let pos = Math.max(range.start, start);
      const to = Math.min(range.end, end);
      for (const p of intersection(this.provisional, pos, to)) {
        if (p.start > pos) out.push({ start: pos, end: p.start });
        pos = p.end;
      }
      if (pos < to) out.push({ start: pos, end: to });
    }
    return out;
  }

  /**
   * Drops the stored chunk farthest from the focus (or, without one, from the written range
   * [start, end)) until the size bound holds.
   */
  private enforceBound(start: number, end: number): void {
    while (this.chunks.size > this.maxChunks && this.covered.length > 0) {
      const low = this.covered[0]!.start;
      const high = this.covered[this.covered.length - 1]!.end - 1;
      const fromLow = (this.focus ?? start) - low;
      const fromHigh = high - (this.focus ?? end - 1);
      const key = fromLow >= fromHigh ? Math.floor(low / CHUNK_SAMPLES) : Math.floor(high / CHUNK_SAMPLES);
      this.remove(key * CHUNK_SAMPLES, (key + 1) * CHUNK_SAMPLES);
    }
  }

  private copyOut(from: number, to: number, outL: Float32Array, outR: Float32Array, at: number): void {
    for (let index = from; index < to; ) {
      const key = Math.floor(index / CHUNK_SAMPLES);
      const offset = index - key * CHUNK_SAMPLES;
      const length = Math.min(CHUNK_SAMPLES - offset, to - index);
      const chunk = this.chunks.get(key)!;
      outL.set(chunk.left.subarray(offset, offset + length), at + index - from);
      outR.set(chunk.right.subarray(offset, offset + length), at + index - from);
      index += length;
    }
  }

  /** Releases the chunks overlapping [from, to) that no longer hold covered samples. */
  private releaseUncovered(from: number, to: number): void {
    if (!(to > from)) return;
    const firstKey = Math.floor(from / CHUNK_SAMPLES);
    const lastKey = Math.floor((to - 1) / CHUNK_SAMPLES);
    if (lastKey - firstKey + 1 > this.chunks.size) {
      for (const key of [...this.chunks.keys()]) {
        if (key >= firstKey && key <= lastKey) this.releaseIfUncovered(key);
      }
    } else {
      for (let key = firstKey; key <= lastKey; key++) this.releaseIfUncovered(key);
    }
  }

  private releaseIfUncovered(key: number): void {
    const chunk = this.chunks.get(key);
    if (chunk === undefined) return;
    const start = key * CHUNK_SAMPLES;
    const range = this.covered[this.firstEndingAfter(start)];
    if (range !== undefined && range.start < start + CHUNK_SAMPLES) return;
    this.chunks.delete(key);
    this.release(chunk);
  }

  private allocate(key: number): Chunk {
    const chunk = this.pool.pop() ?? { left: new Float32Array(CHUNK_SAMPLES), right: new Float32Array(CHUNK_SAMPLES) };
    this.chunks.set(key, chunk);
    return chunk;
  }

  private release(chunk: Chunk): void {
    if (this.pool.length < POOL_LIMIT) this.pool.push(chunk);
  }
}

function checkWrite(method: string, start: number, left: Float32Array, right: Float32Array): void {
  if (!Number.isSafeInteger(start)) throw new RangeError(`PcmStore.${method}: start must be an integer, got ${start}`);
  if (right.length !== left.length) throw new RangeError(`PcmStore.${method}: channels differ in length`);
}

// Small sorted lists of disjoint ranges (the provisional marks: a few per timeline).

/** Parts of the ranges inside [start, end). */
function intersection(list: readonly PcmRange[], start: number, end: number): PcmRange[] {
  const out: PcmRange[] = [];
  for (const r of list) {
    if (r.start >= end) break;
    if (r.end > start) out.push({ start: Math.max(r.start, start), end: Math.min(r.end, end) });
  }
  return out;
}

/** Adds [start, end), merging overlapping and adjacent ranges. */
function addRange(list: PcmRange[], start: number, end: number): void {
  let first = 0;
  while (first < list.length && list[first]!.end < start) first++;
  let last = first;
  let from = start;
  let to = end;
  while (last < list.length && list[last]!.start <= end) {
    from = Math.min(from, list[last]!.start);
    to = Math.max(to, list[last]!.end);
    last++;
  }
  list.splice(first, last - first, { start: from, end: to });
}

/** Removes [start, end) (bounds may be infinite). */
function subtractRange(list: PcmRange[], start: number, end: number): void {
  if (!(end > start) || !list.some((r) => r.start < end && r.end > start)) return;
  const kept: PcmRange[] = [];
  for (const r of list) {
    if (r.end <= start || r.start >= end) kept.push(r);
    else {
      if (r.start < start) kept.push({ start: r.start, end: start });
      if (r.end > end) kept.push({ start: end, end: r.end });
    }
  }
  list.splice(0, list.length, ...kept);
}
