// Media-indexed storage of look-ahead blocks (stereo speech + residual) for several timelines.
// Used by MixerCore; pure TypeScript (worklet-safe).

/** Processed audio for media indices [start, end) of one timeline. */
export interface LaBlock {
  readonly timelineId: number;
  readonly start: number;
  readonly end: number;
  readonly speechL: Float32Array;
  readonly speechR: Float32Array;
  readonly residualL: Float32Array;
  readonly residualR: Float32Array;
  /** Arrival order of the data (lower is older). Pieces of a trimmed block keep its value. */
  readonly seq: number;
  /** False once the block has been removed, replaced or trimmed. */
  alive: boolean;
}

/** Remembers the last block found so that sequential lookups cost O(1). */
export class BlockCursor {
  block: LaBlock | null = null;
}

/**
 * Sorted, non-overlapping blocks per timeline. Newer data replaces older data for the same
 * media indices; {@link enforceBudget} bounds the total number of stored frames.
 */
export class BlockStore {
  readonly #maxFrames: number;
  readonly #timelines = new Map<number, LaBlock[]>();
  #frames = 0;
  #count = 0;
  #seq = 0;

  /** @param maxFrames total frames (over all timelines) kept by {@link enforceBudget}. */
  constructor(maxFrames: number) {
    this.#maxFrames = maxFrames;
  }

  /** Total stored frames over all timelines. */
  get frames(): number {
    return this.#frames;
  }

  /** Number of stored blocks over all timelines. */
  get blockCount(): number {
    return this.#count;
  }

  /**
   * Stores a block, replacing stored data for the same media indices (overlapped blocks are
   * trimmed or split). Returns false and stores nothing when the block is empty, its channels
   * differ in length or `start` is not an integer.
   */
  insert(
    timelineId: number,
    start: number,
    speechL: Float32Array,
    speechR: Float32Array,
    residualL: Float32Array,
    residualR: Float32Array,
  ): boolean {
    const length = speechL.length;
    if (
      length === 0 ||
      speechR.length !== length ||
      residualL.length !== length ||
      residualR.length !== length ||
      !Number.isSafeInteger(start)
    ) {
      return false;
    }
    const end = start + length;
    let list = this.#timelines.get(timelineId);
    if (list === undefined) {
      list = [];
      this.#timelines.set(timelineId, list);
    }
    const block = this.#create(timelineId, start, speechL, speechR, residualL, residualR, this.#seq++);
    const first = firstEndingAfter(list, start);
    let last = first;
    while (last < list.length && list[last]!.start < end) last++;
    if (first === last) {
      list.splice(first, 0, block);
      return true;
    }
    const pieces: LaBlock[] = [];
    const head = list[first]!;
    const tail = list[last - 1]!;
    if (head.start < start) pieces.push(this.#piece(head, head.start, start));
    pieces.push(block);
    if (tail.end > end) pieces.push(this.#piece(tail, end, tail.end));
    for (let k = first; k < last; k++) this.#kill(list[k]!);
    list.splice(first, last - first, ...pieces);
    return true;
  }

  /** Drops all blocks of one timeline, or of every timeline when `timelineId` is undefined. */
  flush(timelineId?: number): void {
    for (const [id, list] of this.#timelines) {
      if (timelineId !== undefined && id !== timelineId) continue;
      for (const block of list) this.#kill(block);
      this.#timelines.delete(id);
    }
  }

  /** Block of `timelineId` containing media index `m`, or null. */
  find(timelineId: number, m: number, cursor: BlockCursor): LaBlock | null {
    const cached = cursor.block;
    if (cached !== null && cached.alive && cached.timelineId === timelineId && m >= cached.start && m < cached.end) {
      return cached;
    }
    const list = this.#timelines.get(timelineId);
    const block = list === undefined ? undefined : list[lastStartingAtOrBefore(list, m)];
    cursor.block = block !== undefined && m < block.end ? block : null;
    return cursor.block;
  }

  /** Number of contiguously stored frames of `timelineId` from media index `m` onwards. */
  contiguousAhead(timelineId: number, m: number): number {
    const list = this.#timelines.get(timelineId);
    if (list === undefined) return 0;
    let k = lastStartingAtOrBefore(list, m);
    let block = list[k];
    if (block === undefined || m >= block.end) return 0;
    let end = block.end;
    while ((block = list[++k]) !== undefined && block.start === end) end = block.end;
    return end - m;
  }

  /**
   * Evicts blocks until at most `maxFrames` are stored: first blocks of `lockTimeline` that end
   * at least `keepBehind` frames before `lockPos` (farthest behind first), then the oldest blocks,
   * never the block containing `lockPos`. Pass `lockTimeline = null` when nothing is locked.
   */
  enforceBudget(lockTimeline: number | null, lockPos: number, keepBehind: number): void {
    while (this.#frames > this.#maxFrames) {
      const victim = this.#behind(lockTimeline, lockPos - keepBehind) ?? this.#oldest(lockTimeline, lockPos);
      if (victim === null) return;
      this.#remove(victim);
    }
  }

  #behind(lockTimeline: number | null, limit: number): LaBlock | null {
    if (lockTimeline === null) return null;
    const first = this.#timelines.get(lockTimeline)?.[0];
    return first !== undefined && first.end <= limit ? first : null;
  }

  #oldest(lockTimeline: number | null, lockPos: number): LaBlock | null {
    let oldest: LaBlock | null = null;
    for (const list of this.#timelines.values()) {
      for (const block of list) {
        if (block.timelineId === lockTimeline && lockPos >= block.start && lockPos < block.end) continue;
        if (oldest === null || block.seq < oldest.seq) oldest = block;
      }
    }
    return oldest;
  }

  #remove(block: LaBlock): void {
    const list = this.#timelines.get(block.timelineId);
    const index = list === undefined ? -1 : list.indexOf(block);
    if (list === undefined || index < 0) return;
    list.splice(index, 1);
    if (list.length === 0) this.#timelines.delete(block.timelineId);
    this.#kill(block);
  }

  #create(
    timelineId: number,
    start: number,
    speechL: Float32Array,
    speechR: Float32Array,
    residualL: Float32Array,
    residualR: Float32Array,
    seq: number,
  ): LaBlock {
    this.#frames += speechL.length;
    this.#count++;
    return { timelineId, start, end: start + speechL.length, speechL, speechR, residualL, residualR, seq, alive: true };
  }

  /** Copy of the part [from, to) of `block` (copied so the replaced data can be released). */
  #piece(block: LaBlock, from: number, to: number): LaBlock {
    const a = from - block.start;
    const b = to - block.start;
    return this.#create(
      block.timelineId,
      from,
      block.speechL.slice(a, b),
      block.speechR.slice(a, b),
      block.residualL.slice(a, b),
      block.residualR.slice(a, b),
      block.seq,
    );
  }

  #kill(block: LaBlock): void {
    block.alive = false;
    this.#frames -= block.end - block.start;
    this.#count--;
  }
}

/** Index of the first block with end > m (list.length if none). */
function firstEndingAfter(list: readonly LaBlock[], m: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.end > m) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Index of the last block with start <= m (-1 if none). */
function lastStartingAtOrBefore(list: readonly LaBlock[], m: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.start <= m) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}
