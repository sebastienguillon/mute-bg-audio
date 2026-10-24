// Synthetic harness for MixerCore tests: drives process() quantum by quantum over prepared input
// signals and simulates the real-time and look-ahead workers with configurable delays.
import { DFN_DELAY, PROBE_LENGTH, QUANTUM } from '../../../src/lib/constants';
import { MixerCore, type MixerCoreOptions } from '../../../src/lib/mixer/mixer-core';
import type { FromMixer, LaToWorker, MixerConfig, MixerStats, RtToWorker } from '../../../src/lib/protocol';

export const SR = 48000;

/** Input channel layout fed to process(). */
export type InputLayout = 'stereo' | 'mono' | 'none';

/** Receives the core's messages to the real-time worker (synchronously, like postMessage). */
export interface RealtimeWorker {
  receive(msg: RtToWorker): void;
}

interface Pending {
  at: number;
  seq: number;
  deliver: () => void;
}

/** Drives a MixerCore over a prepared stereo input, recording the whole output. */
export class MixerHarness {
  readonly core: MixerCore;
  readonly main: FromMixer[] = [];
  /** Harness frame at which each message of `main` was posted (the end of its quantum). */
  readonly mainFrames: number[] = [];
  readonly inL: Float32Array;
  readonly inR: Float32Array;
  readonly outL: Float32Array;
  readonly outR: Float32Array;
  /** Frames processed so far (during process(): including the current quantum). */
  frame = 0;
  layout: InputLayout = 'stereo';
  rt: RealtimeWorker | null = null;
  la: FakeLookahead | null = null;
  readonly #pending: Pending[] = [];
  #seq = 0;

  constructor(inL: Float32Array, inR: Float32Array, opts?: MixerCoreOptions) {
    this.inL = inL;
    this.inR = inR;
    this.outL = new Float32Array(inL.length);
    this.outR = new Float32Array(inL.length);
    this.core = new MixerCore(
      {
        // Like postMessage: a hop that is not transferred is a copy.
        postRt: (msg, transfer) => this.rt?.receive(transfer?.length ? msg : structuredClone(msg)),
        postLa: (msg) => this.la?.receive(msg),
        // Like postMessage: the core reuses its message objects.
        postMain: (msg) => {
          this.main.push(structuredClone(msg));
          this.mainFrames.push(this.frame);
        },
      },
      opts,
    );
  }

  /** Delivers `deliver` before the first quantum that starts at least `delay` frames from now. */
  schedule(delay: number, deliver: () => void): void {
    this.#pending.push({ at: this.frame + delay, seq: this.#seq++, deliver });
  }

  config(config: Partial<MixerConfig>): void {
    this.core.onMain({
      type: 'config',
      config: { enabled: true, residualGain: 0.25, gapReduction: false, lookahead: false, outputLatency: 0, ...config },
    });
  }

  /** Connects a real-time worker; unless `ready` is false it says 'ready' at once (its model is loaded). */
  connectRt(rt: RealtimeWorker, ready = true): void {
    this.rt = rt;
    this.core.setRtConnected(true);
    if (ready) this.core.onRt({ type: 'ready' });
  }

  connectLa(la: FakeLookahead): void {
    this.la = la;
    this.core.setLaConnected(true);
  }

  /** Processes quanta until `frame` (rounded up to a quantum) or the end of the input. */
  runUntil(frame: number): void {
    const end = Math.min(frame, this.inL.length);
    const inputs: Float32Array[] = [];
    while (this.frame < end) {
      this.#deliver();
      const f0 = this.frame;
      const l = this.inL.subarray(f0, f0 + QUANTUM);
      const r = this.inR.subarray(f0, f0 + QUANTUM);
      inputs.length = 0;
      if (this.layout === 'stereo') inputs.push(l, r);
      else if (this.layout === 'mono') inputs.push(l);
      this.frame = f0 + QUANTUM;
      this.core.process(inputs, [this.outL.subarray(f0, f0 + QUANTUM), this.outR.subarray(f0, f0 + QUANTUM)]);
    }
    this.#deliver();
  }

  /** Stats messages received so far. */
  stats(): MixerStats[] {
    return this.main.flatMap((m) => (m.type === 'stats' ? [m.stats] : []));
  }

  #deliver(): void {
    for (;;) {
      let best = -1;
      for (let k = 0; k < this.#pending.length; k++) {
        const p = this.#pending[k]!;
        if (p.at > this.frame) continue;
        const b = this.#pending[best];
        if (b === undefined || p.at < b.at || (p.at === b.at && p.seq < b.seq)) best = k;
      }
      if (best < 0) return;
      const [p] = this.#pending.splice(best, 1);
      p!.deliver();
    }
  }
}

/** Speech returned by the fake real-time worker for input frame t. */
export type SpeechModel = 'zero' | 'mid' | ((t: number) => number);

/** Fake real-time worker: answers each hop at index i with speech for [i − DFN_DELAY, …). */
export class FakeRealtime implements RealtimeWorker {
  hops = 0;
  resets = 0;
  /** Index of every hop received, in order. */
  readonly hopIndices: number[] = [];
  /** Response delay in frames for the hop starting at `index` (Infinity: never answered). */
  delay: (index: number) => number = () => 0;
  readonly #h: MixerHarness;
  readonly #model: SpeechModel;
  readonly #mid: Float32Array;

  constructor(h: MixerHarness, model: SpeechModel) {
    this.#h = h;
    this.#model = model;
    this.#mid = new Float32Array(h.inL.length + QUANTUM * 8);
  }

  receive(msg: RtToWorker): void {
    if (msg.type === 'reset') {
      this.resets++;
      return;
    }
    // The core reuses the message object: read it now.
    const { index, data } = msg;
    this.hops++;
    this.hopIndices.push(index);
    if (this.#model === 'mid') this.#mid.set(data, index);
    const start = index - DFN_DELAY;
    for (let i = 0; i < data.length; i++) data[i] = this.#speech(start + i);
    this.#h.schedule(this.delay(index), () => this.#h.core.onRt({ type: 'speech', index: start, data }));
  }

  #speech(t: number): number {
    if (this.#model === 'zero' || t < 0) return 0;
    if (this.#model === 'mid') return this.#mid[t]!;
    return this.#model(t);
  }
}

/** Separated media of one timeline (what the look-ahead worker would produce). */
export interface Media {
  speechL: Float32Array;
  speechR: Float32Array;
  residualL: Float32Array;
  residualR: Float32Array;
}

/** Fake look-ahead worker: sends blocks of `media` and answers probes with the true offset. */
export class FakeLookahead {
  probes = 0;
  probeDelay = 0;
  /** Multiplies the least-squares gain returned to the core (tests the refinement). */
  gainError = 1;
  readonly #h: MixerHarness;
  readonly #media: Media;
  readonly #timelineId: number;
  readonly #offsetAt: (frameEnd: number) => number | null;

  /** `offsetAt(frameEnd)`: true media offset of the input at `frameEnd`, or null (not found). */
  constructor(h: MixerHarness, media: Media, timelineId: number, offsetAt: (frameEnd: number) => number | null) {
    this.#h = h;
    this.#media = media;
    this.#timelineId = timelineId;
    this.#offsetAt = offsetAt;
  }

  /** Sends media [from, to) as blocks of `size` frames (copies, like transferred buffers). */
  sendBlocks(from: number, to: number, size: number, timelineId = this.#timelineId): void {
    const m = this.#media;
    for (let start = from; start < to; start += size) {
      const end = Math.min(to, start + size);
      this.#h.core.onLa({
        type: 'block',
        timelineId,
        start,
        speechL: m.speechL.slice(start, end),
        speechR: m.speechR.slice(start, end),
        residualL: m.residualL.slice(start, end),
        residualR: m.residualR.slice(start, end),
      });
    }
  }

  receive(msg: LaToWorker): void {
    this.probes++;
    const { id, frameEnd } = msg;
    const data = msg.data.slice();
    const offset = this.#offsetAt(frameEnd);
    const mediaEnd = offset === null ? 0 : frameEnd + offset;
    let xm = 0;
    let mm = 0;
    let xx = 0;
    if (offset !== null) {
      const m = this.#media;
      for (let i = 0; i < PROBE_LENGTH; i++) {
        const k = mediaEnd - PROBE_LENGTH + i;
        const mix = 0.5 * (m.speechL[k]! + m.residualL[k]! + m.speechR[k]! + m.residualR[k]!);
        xm += data[i]! * mix;
        mm += mix * mix;
        xx += data[i]! * data[i]!;
      }
    }
    const found = offset !== null && mm > 0;
    const gain = found ? (xm / mm) * this.gainError : 0;
    const score = found && xx > 0 ? Math.abs(xm) / Math.sqrt(xx * mm) : 0;
    this.#h.schedule(this.probeDelay, () =>
      this.#h.core.onLa({
        type: 'probe-result',
        id,
        frameEnd,
        found,
        timelineId: this.#timelineId,
        mediaEnd,
        gain,
        score,
      }),
    );
  }
}
