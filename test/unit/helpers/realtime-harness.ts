// Drives an RtProcessor like the worklet does and reassembles its speech output.
import { RT_HOP } from '../../../src/lib/constants';
import type { RtFromWorker } from '../../../src/lib/protocol';
import { Dfn, type DfnOptions } from '../../../src/lib/realtime/dfn';
import { RtProcessor, type RtProcessorOptions } from '../../../src/lib/realtime/rt-processor';
import { dfnWasm } from './realtime-audio';

export type SpeechMsg = Extract<RtFromWorker, { type: 'speech' }>;

/** An RtProcessor whose posted messages (and transfer lists) are recorded. */
export class Recorder {
  readonly messages: RtFromWorker[] = [];
  readonly transfers: Array<Transferable[] | undefined> = [];
  readonly processor: RtProcessor;

  constructor(dfn: Dfn, opts?: RtProcessorOptions) {
    this.processor = new RtProcessor(
      dfn,
      (msg, transfer) => {
        this.messages.push(msg);
        this.transfers.push(transfer);
      },
      opts,
    );
  }

  /**
   * A recorder around a real model. Hops are sent as fast as the model runs, not in real time,
   * so stale hops are never skipped unless `opts.maxWaitMs` says otherwise.
   */
  static create(dfnOpts?: DfnOptions, opts?: RtProcessorOptions): Recorder {
    return new Recorder(Dfn.create(dfnWasm(), dfnOpts), { maxWaitMs: Infinity, ...opts });
  }

  get speech(): SpeechMsg[] {
    return this.messages.filter((m): m is SpeechMsg => m.type === 'speech');
  }

  /** Sends the hop of `signal` starting at `start` with worklet frame index `index` (default `start`). */
  sendHop(signal: Float32Array, start: number, index = start): Float32Array {
    const data = signal.slice(start, start + RT_HOP);
    this.processor.onMessage({ type: 'hop', index, data });
    return data;
  }

  /** Sends consecutive hops of `signal` covering [start, end). */
  sendRange(signal: Float32Array, start: number, end: number): void {
    for (let i = start; i + RT_HOP <= end; i += RT_HOP) this.sendHop(signal, i);
  }
}

/**
 * Writes every speech message at its index into a signal of `length` frames. `covered` marks the
 * frames that received speech (later messages overwrite earlier ones, as in the worklet).
 */
export function reassemble(messages: readonly SpeechMsg[], length: number): { estimate: Float32Array; covered: Uint8Array } {
  const estimate = new Float32Array(length);
  const covered = new Uint8Array(length);
  for (const { index, data } of messages) {
    for (let j = 0; j < data.length; j++) {
      const i = index + j;
      if (i < 0 || i >= length) continue;
      estimate[i] = data[j]!;
      covered[i] = 1;
    }
  }
  return { estimate, covered };
}

/** A copy of `mask` with the frames in [start, end) cleared. */
export function without(mask: Uint8Array, ranges: Array<[number, number]>): Uint8Array {
  const out = mask.slice();
  for (const [start, end] of ranges) out.fill(0, Math.max(0, start), Math.min(out.length, end));
  return out;
}
