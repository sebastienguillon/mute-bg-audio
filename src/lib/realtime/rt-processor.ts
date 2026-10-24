// Message logic of the real-time worker: worklet hops in, delay-compensated speech out.
// The worker entry only creates the Dfn and wires a MessagePort to an RtProcessor.
import { MAX_JITTER, SAMPLE_RATE } from '../constants';
import type { RtFromWorker, RtToWorker } from '../protocol';
import type { Dfn } from './dfn';

/** Options for {@link RtProcessor}. */
export interface RtProcessorOptions {
  /** Post a 'stats' message every this many processed frames. Default 48000 (1 s). */
  statsEveryFrames?: number;
  /** Clock in milliseconds. Default `performance.now`. */
  now?: () => number;
  /**
   * A hop that waited longer than this (ms) behind the processing of earlier hops is answered
   * without the model. Default STALE_MS (MAX_JITTER, 60 ms); Infinity never skips (for callers
   * that do not send hops in real time).
   */
  maxWaitMs?: number;
}

/**
 * 'speech' as posted by RtProcessor. `passthrough` marks the answers whose data is the delayed
 * input because the model was skipped or failed: the mixer treats them like missing answers and
 * crossfades to its own (stereo) pass-through, instead of mixing them as speech next to model
 * output. (Requested addition to RtFromWorker 'speech'; structured cloning carries it as is.)
 */
/** A 'speech' answer (see RtFromWorker; `passthrough` marks the delayed input itself). */
export type RtSpeech = Extract<RtFromWorker, { type: 'speech' }>;

/** Sends a message to the worklet, transferring the listed buffers. */
export type RtPost = (msg: RtFromWorker, transfer?: Transferable[]) => void;

/**
 * Forward gaps shorter than this (samples) are filled with silent hops (whole hops, rounded
 * down) so that the model's timeline stays aligned with the worklet's; longer gaps and backward
 * jumps continue without filling (the model adapts within ~100 ms; re-creating it costs ~300 ms).
 */
const MAX_FILLED_GAP = SAMPLE_RATE;

/**
 * Default {@link RtProcessorOptions.maxWaitMs}: the speech of a hop that waited longer comes back
 * later than the worklet's largest default output latency, and processing it would only delay
 * the following hops further.
 */
const STALE_MS = (MAX_JITTER * 1000) / SAMPLE_RATE;

/** Model failures are reported at most this often (ms). */
const ERROR_REPORT_MS = 10_000;

/** Input history in samples (a power of two of at least the model delay plus one hop). */
const INPUT_HISTORY = 2048;
const INPUT_MASK = INPUT_HISTORY - 1;

/**
 * Runs DeepFilterNet on the worklet's hops ({@link RtToWorker}) and answers each hop at frame
 * index `i` with `{ type: 'speech', index: i − dfn.delay }`, returning the hop's own buffer.
 * Also posts `stats` periodically. The worker entry posts `ready` itself.
 *
 * When the model cannot be used for a hop, the answer is the hop's delayed input (the input of
 * frames [i − delay, i − delay + hop)) marked `passthrough` ({@link RtSpeech}), which the
 * worklet replaces with the unchanged input:
 * - the model throws: `error` is posted (at most every ERROR_REPORT_MS) and later hops are
 *   still processed;
 * - the hop is stale (it waited more than `maxWaitMs` behind earlier hops, e.g. on a CPU too
 *   slow for the model): it skips the model so that the queue catches up. The model then misses
 *   those frames, so its next `delay / hop` outputs, which still estimate older input, are
 *   replaced as well.
 * Each processor needs its own Dfn: the model state holds one continuous stream.
 */
export class RtProcessor {
  readonly #dfn: Dfn;
  readonly #post: RtPost;
  readonly #statsEveryFrames: number;
  readonly #now: () => number;
  readonly #maxWaitMs: number;
  readonly #silence: Float32Array;
  readonly #discard: Float32Array;
  /** Mono input of frames [#inputFrom, #inputTo), by frame index. */
  readonly #input = new Float32Array(INPUT_HISTORY);
  #inputFrom = 0;
  #inputTo = 0;
  /** Frame index of the next hop on the current timeline; null after a reset. */
  #expected: number | null = null;
  /** Index of the previous hop (null: none yet) and the work queued behind it when it ended (ms). */
  #lastIndex: number | null = null;
  #backlogMs = 0;
  /** Upcoming model outputs that still estimate input from before skipped hops. */
  #misaligned = 0;
  /** Clock reading at the start of the current hop. */
  #hopStartMs = 0;
  #lastErrorMs = -Infinity;
  #statsFrames = 0;
  #statsMs = 0;

  constructor(dfn: Dfn, post: RtPost, opts: RtProcessorOptions = {}) {
    this.#dfn = dfn;
    this.#post = post;
    this.#statsEveryFrames = opts.statsEveryFrames ?? SAMPLE_RATE;
    this.#now = opts.now ?? (() => performance.now());
    this.#maxWaitMs = opts.maxWaitMs ?? STALE_MS;
    this.#silence = new Float32Array(dfn.hop);
    this.#discard = new Float32Array(dfn.hop);
  }

  /** Handles one message from the worklet. */
  onMessage(msg: RtToWorker): void {
    switch (msg.type) {
      case 'hop':
        this.#onHop(msg.index, msg.data);
        break;
      case 'reset':
        this.#expected = null;
        break;
    }
  }

  #onHop(index: number, data: Float32Array): void {
    const start = this.#now();
    this.#hopStartMs = start;
    const { hop, delay } = this.#dfn;
    const wait = this.#queueWait(index);
    const stale = wait > this.#maxWaitMs;
    let filled = 0;
    if (this.#expected !== null && !stale) {
      const gap = index - this.#expected;
      if (gap > 0 && gap < MAX_FILLED_GAP) {
        filled = Math.floor(gap / hop);
        this.#fill(this.#expected, filled);
      }
    }
    this.#expected = index + hop;
    this.#remember(index, data);
    if (stale) this.#misaligned = Math.ceil(delay / hop);
    const passthrough = stale || !this.#model(data, data);
    if (passthrough) this.#delayedInput(index - delay, data);
    this.#post(speech(index - delay, data, passthrough), [data.buffer]);
    const elapsed = this.#now() - start;
    this.#backlogMs = wait + elapsed;
    this.#account(elapsed, (filled + 1) * hop);
  }

  /**
   * Estimated time (ms) the hop at `index` waited behind the processing of earlier hops,
   * assuming that the worklet sends hops in real time (Lindley's recursion over the hop
   * indices). Bursts of hops therefore do not count; a backward jump starts over.
   */
  #queueWait(index: number): number {
    const last = this.#lastIndex;
    this.#lastIndex = index;
    if (last === null || index <= last) return 0;
    return Math.max(0, this.#backlogMs - ((index - last) * 1000) / SAMPLE_RATE);
  }

  /**
   * Feeds `count` silent hops for the missing frames starting at `from`. The first outputs
   * estimate the last real frames before the gap, so those are posted; the rest estimate the
   * silent filler itself and are dropped.
   */
  #fill(from: number, count: number): void {
    const { hop, delay } = this.#dfn;
    for (let k = 0; k < count; k++) {
      const offset = k * hop;
      if (offset < delay) {
        const out = new Float32Array(hop);
        const passthrough = !this.#model(this.#silence, out);
        if (passthrough) this.#delayedInput(from + offset - delay, out);
        this.#post(speech(from + offset - delay, out, passthrough), [out.buffer]);
      } else {
        this.#model(this.#silence, this.#discard);
      }
    }
  }

  /**
   * Runs the model on one hop into `out` (which may be `input`). Returns false when the output
   * must not be used: the model threw, or it still estimates input from before skipped hops.
   */
  #model(input: Float32Array, out: Float32Array): boolean {
    let ok = true;
    try {
      this.#dfn.process(input, out);
    } catch (err) {
      ok = false;
      if (this.#hopStartMs - this.#lastErrorMs >= ERROR_REPORT_MS) {
        this.#lastErrorMs = this.#hopStartMs;
        const reason = err instanceof Error ? err.message : String(err);
        this.#post({ type: 'error', message: `DeepFilterNet failed: ${reason}` });
      }
    }
    if (this.#misaligned > 0) {
      this.#misaligned--;
      return false;
    }
    return ok;
  }

  /** Appends a hop's input to the history (which restarts at a discontinuity). */
  #remember(index: number, data: Float32Array): void {
    if (index !== this.#inputTo) this.#inputFrom = index;
    const input = this.#input;
    for (let j = 0; j < data.length; j++) input[(index + j) & INPUT_MASK] = data[j]!;
    this.#inputTo = index + data.length;
    this.#inputFrom = Math.max(this.#inputFrom, this.#inputTo - INPUT_HISTORY);
  }

  /** Writes the input of frames [from, from + out.length) to `out`, 0 where it is not known. */
  #delayedInput(from: number, out: Float32Array): void {
    const input = this.#input;
    for (let j = 0; j < out.length; j++) {
      const t = from + j;
      out[j] = t >= this.#inputFrom && t < this.#inputTo ? input[t & INPUT_MASK]! : 0;
    }
  }

  #account(ms: number, frames: number): void {
    this.#statsMs += ms;
    this.#statsFrames += frames;
    if (this.#statsFrames < this.#statsEveryFrames) return;
    const audioMs = (this.#statsFrames * 1000) / SAMPLE_RATE;
    this.#post({ type: 'stats', rtf: this.#statsMs / audioMs, frames: this.#statsFrames });
    this.#statsMs = 0;
    this.#statsFrames = 0;
  }
}

/** The answer for input frames [index, index + data.length). */
function speech(index: number, data: Float32Array, passthrough: boolean): RtSpeech {
  return passthrough ? { type: 'speech', index, data, passthrough } : { type: 'speech', index, data };
}
