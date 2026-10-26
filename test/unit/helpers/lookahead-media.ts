// Test helpers for the look-ahead core: WAV reading, WebM splitting into YouTube-like appends,
// a fake WebCodecs decoder backed by known PCM, simple MDX backends and a LookaheadCore harness.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EncodedAudioFrame } from '../../../src/lib/demux/index';
import { LookaheadCore, type DecodedAudio, type DecoderFactory, type LookaheadCoreOptions } from '../../../src/lib/lookahead/lookahead-core';
import { MDX_MODELS, type MdxBackend } from '../../../src/lib/mdx/mdx';
import type { HookMessage, LaFromWorker, LookaheadStatus, PlayheadInfo } from '../../../src/lib/protocol';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = join(ROOT, 'test/fixtures/generated');
export const SR = 48000;

export interface Wav {
  sampleRate: number;
  channels: Float32Array[];
}

/** Reads a PCM16 or float32 WAV file into planar channels. */
export function readWav(path: string): Wav {
  const b = readFileSync(path);
  let p = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), sampleRate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    } else if (id === 'data') {
      data = b.subarray(p + 8, p + 8 + size);
    }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: not a WAV file`);
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  const float = fmt.format === 3 || (fmt.format === 0xfffe && fmt.bits === 32);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * bytes;
      channels[c]![i] = float ? data.readFloatLE(o) : data.readInt16LE(o) / 32768;
    }
  }
  return { sampleRate: fmt.sampleRate, channels };
}

/** Path of a generated fixture (made by the global setup). */
export function fixturePath(name: string): string {
  return join(FIXTURES, name);
}

export function readFixtureWav(name: string): Wav {
  return readWav(fixturePath(name));
}

/** Splits a WebM file at its top-level Segment children: [init segment, cluster 1 (+ trailing elements), ...]. */
export function splitWebm(bytes: Uint8Array): { init: Uint8Array; clusters: Uint8Array[] } {
  const vint = (p: number, keepMarker: boolean) => {
    const first = bytes[p]!;
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? first : first & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + bytes[p + i]!;
    return { v, len, unknown: !keepMarker && v === 2 ** (7 * len) - 1 };
  };
  const header = (p: number) => {
    const id = vint(p, true);
    const size = vint(p + id.len, false);
    return { id: id.v, dataStart: p + id.len + size.len, size: size.unknown ? Infinity : size.v };
  };
  const ebml = header(0);
  const segment = header(ebml.dataStart + ebml.size);
  const segmentEnd = Math.min(bytes.length, segment.dataStart + segment.size);
  const cuts: number[] = [];
  for (let p = segment.dataStart; p < segmentEnd; ) {
    const el = header(p);
    if (el.id === 0x1f43b675) cuts.push(p);
    p = el.dataStart + el.size;
  }
  const init = bytes.slice(0, cuts[0]);
  const clusters = cuts.map((c, i) => bytes.slice(c, i + 1 < cuts.length ? cuts[i + 1] : bytes.length));
  return { init, clusters };
}

/** Zero-filled copy of signal[start, end). */
export function slice(signal: Float32Array, start: number, end: number): Float32Array {
  const out = new Float32Array(Math.max(0, end - start));
  const from = Math.max(0, start);
  const to = Math.min(signal.length, end);
  if (to > from) out.set(signal.subarray(from, to), from - start);
  return out;
}

export interface DecoderLog {
  created: number;
  closed: number;
  decoded: number;
  /** Timestamps passed to decode(). */
  timestamps: number[];
}

export interface FakeDecoderOptions {
  /**
   * Model Chrome's Opus AudioDecoder: each decoder drops the codec delay (312 samples) at its
   * start, so its output ends that much before the end of its last frame (that audio comes with
   * the next frame), and its first 33.5 ms are off like an unsettled decoder (−4.5 dB of
   * difference for 13.5 ms, then −16.7 dB for 20 ms).
   */
  chromeOpus?: boolean;
}

/** Codec delay of the Chrome-like fake decoder, in samples. */
export const FAKE_CODEC_DELAY = 312;
/** Gain of output sample `i` of a Chrome-like fake decoder (unsettled for the first 33.5 ms). */
function unsettledGain(i: number): number {
  return i < 648 ? 0.4 : i < 1608 ? 0.85 : 1;
}

/**
 * Fake WebCodecs decoder: packet k of the stream (k = round(pts / D), D = the first frame's
 * duration, which absorbs container timestamp rounding) "decodes" to
 * source[k · round(D · rate), + round(duration · rate)), stamped with the timestamp given to
 * decode() (see FakeDecoderOptions.chromeOpus for a decoder with codec delay and settling).
 * Outputs are delivered asynchronously (microtask), like WebCodecs.
 */
export function fakeDecoderFactory(source: Wav, log: DecoderLog = newDecoderLog(), opts: FakeDecoderOptions = {}): DecoderFactory {
  return (_config, onOutput) => {
    log.created++;
    const queue: DecodedAudio[] = [];
    let closed = false;
    let scheduled = false;
    let nominal = 0;
    /** Samples output so far (Chrome-like: the decoder settles over the first ones). */
    let output = 0;
    const drain = () => {
      scheduled = false;
      while (queue.length > 0 && !closed) onOutput(queue.shift()!);
    };
    return {
      decode(frame: EncodedAudioFrame, timestamp: number) {
        if (closed) throw new Error('decoder closed');
        log.decoded++;
        log.timestamps.push(timestamp);
        const rate = source.sampleRate;
        nominal ||= frame.duration;
        let first = Math.round(frame.pts / nominal) * Math.round(nominal * rate);
        let end = first + Math.round(frame.duration * rate);
        if (opts.chromeOpus) {
          // A decoder's first packet loses the codec delay; the later ones carry audio delayed by it.
          if (output > 0) first -= FAKE_CODEC_DELAY;
          end -= FAKE_CODEC_DELAY;
        }
        const channels = source.channels.map((c) => slice(c, first, end));
        if (opts.chromeOpus) {
          for (const channel of channels) for (let i = 0; i < channel.length; i++) channel[i] = channel[i]! * unsettledGain(output + i);
          output += end - first;
        }
        queue.push({ timestamp, sampleRate: rate, channels });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(drain);
        }
      },
      flush: async () => drain(),
      reset: () => {
        queue.length = 0;
        output = 0;
      },
      close: () => {
        if (!closed) log.closed++;
        closed = true;
        queue.length = 0;
      },
    };
  };
}

export function newDecoderLog(): DecoderLog {
  return { created: 0, closed: 0, decoded: 0, timestamps: [] };
}

/** vocals = input (the stream then returns the band-limited mix). */
export const identityBackend: MdxBackend = { run: async (input) => input };
/** vocals = 0 (speech blocks are silent, residual = mix). */
export const zeroBackend: MdxBackend = { run: async (input) => new Float32Array(input.length) };

export function sbAdd(msId: number, sbId: number, mime = 'audio/webm; codecs="opus"'): HookMessage {
  return { type: 'sb-add', msId, sbId, mime };
}

export function sbAppend(
  msId: number,
  sbId: number,
  bytes: Uint8Array,
  opts: { timestampOffset?: number; appendWindowStart?: number; appendWindowEnd?: number; ok?: boolean } = {},
): HookMessage {
  return {
    type: 'sb-append',
    msId,
    sbId,
    data: bytes.slice().buffer,
    timestampOffset: opts.timestampOffset ?? 0,
    appendWindowStart: opts.appendWindowStart ?? 0,
    appendWindowEnd: opts.appendWindowEnd ?? Infinity,
    ok: opts.ok ?? true,
  };
}

/** YouTube-like appends of a WebM file: the init segment, then one append per cluster. */
export function webmAppends(msId: number, sbId: number, bytes: Uint8Array, opts: Parameters<typeof sbAppend>[3] = {}): HookMessage[] {
  const { init, clusters } = splitWebm(bytes);
  return [sbAppend(msId, sbId, init, opts), ...clusters.map((c) => sbAppend(msId, sbId, c, opts))];
}

export type BlockMsg = Extract<LaFromWorker, { type: 'block' }>;
export type ProbeResultMsg = Extract<LaFromWorker, { type: 'probe-result' }>;

export interface Harness {
  core: LookaheadCore;
  /** Every message posted to the worklet, in order. */
  posts: LaFromWorker[];
  statuses: LookaheadStatus[];
  /** Transfer lists of the posted messages (same indices as posts). */
  transfers: (Transferable[] | undefined)[];
  clock: { now: number };
  blocks(timelineId?: number): BlockMsg[];
  /** End of the last block of the timeline (0 when none). */
  blockEnd(timelineId?: number): number;
}

/**
 * Creates a LookaheadCore recording its outputs; `clock.now` is its clock (ms). With `transfer`,
 * posts are structured clones and the transferred buffers are detached, as by the worker's
 * MessagePort.
 */
export function createHarness(
  opts: Partial<LookaheadCoreOptions> & Pick<LookaheadCoreOptions, 'decoderFactory'>,
  { transfer = false }: { transfer?: boolean } = {},
): Harness {
  const posts: LaFromWorker[] = [];
  const transfers: (Transferable[] | undefined)[] = [];
  const statuses: LookaheadStatus[] = [];
  const clock = { now: 0 };
  const core = new LookaheadCore({
    model: MDX_MODELS.Kim_Vocal_2,
    backend: identityBackend,
    postWorklet: (msg, list) => {
      posts.push(transfer ? structuredClone(msg, { transfer: list ?? [] }) : msg);
      transfers.push(list);
    },
    onStatus: (s) => statuses.push(s),
    now: () => clock.now,
    ...opts,
  });
  const blocks = (timelineId?: number) =>
    posts.filter((m): m is BlockMsg => m.type === 'block' && (timelineId === undefined || m.timelineId === timelineId));
  const blockEnd = (timelineId?: number) => {
    const list = blocks(timelineId);
    const last = list[list.length - 1];
    return last ? last.start + last.speechL.length : 0;
  };
  return { core, posts, statuses, transfers, clock, blocks, blockEnd };
}

/** A paused, audible playhead at `time` (seconds), stamped with the harness clock. */
export function playheadAt(h: Harness, time: number, extra: Partial<PlayheadInfo> = {}): PlayheadInfo {
  return { time, paused: true, rate: 1, seeking: false, audible: true, at: h.clock.now, ...extra };
}

/** Seconds of media covered by one copy of mix.webm in appendCopies(). */
export const COPY_SECONDS = 30;

/**
 * Appends `copies` back-to-back copies of a WebM file (YouTube-like: init + one append per
 * cluster) to timeline msId, starting at `offset` seconds. Copy i covers
 * [offset + 30 i, offset + 30 (i + 1)) (the append window cuts each copy at 30 s).
 */
export function appendCopies(h: Harness, webm: Uint8Array, msId: number, copies: number, offset = 0): void {
  h.core.onHook(sbAdd(msId, 1));
  for (let i = 0; i < copies; i++) {
    const last = i === copies - 1;
    const opts = { timestampOffset: offset + COPY_SECONDS * i, ...(last ? {} : { appendWindowEnd: offset + COPY_SECONDS * (i + 1) }) };
    for (const msg of webmAppends(msId, 1, webm, opts)) h.core.onHook(msg);
  }
}

/** Decoded `source` (a 30 s WAV) at media index m of a timeline made by appendCopies(…, copies, offset). */
export function copiesAt(source: Wav, channel: 0 | 1, m: number, copies: number, offset = 0): number {
  const copy = COPY_SECONDS * SR;
  const j = m - offset * SR;
  if (j < 0 || j >= copies * copy) return 0;
  return source.channels[channel]![j % copy]!;
}

/** Worst |speech + residual − mix| over the blocks, where `mix(channel, m)` is the expected mix. */
export function remixError(blocks: BlockMsg[], mix: (channel: 0 | 1, m: number) => number): number {
  let worst = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.speechL.length; i++) {
      const m = b.start + i;
      worst = Math.max(worst, Math.abs(b.speechL[i]! + b.residualL[i]! - mix(0, m)), Math.abs(b.speechR[i]! + b.residualR[i]! - mix(1, m)));
    }
  }
  return worst;
}

/** Polls `predicate` (every 5 ms) until it holds; throws after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 20_000, what = 'condition'): Promise<void> {
  const until = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Resolves once nothing has been posted for `quietMs`. */
export async function settle(h: Harness, quietMs = 300): Promise<void> {
  let count = -1;
  while (count !== h.posts.length) {
    count = h.posts.length;
    await new Promise((r) => setTimeout(r, quietMs));
  }
}

/** Asserts-friendly check that blocks are contiguous; returns [start, end) or null when there are none. */
export function blockSpan(blocks: BlockMsg[]): { start: number; end: number; contiguous: boolean } | null {
  if (blocks.length === 0) return null;
  let contiguous = true;
  for (let i = 1; i < blocks.length; i++) {
    const prev = blocks[i - 1]!;
    if (blocks[i]!.start !== prev.start + prev.speechL.length) contiguous = false;
  }
  const last = blocks[blocks.length - 1]!;
  return { start: blocks[0]!.start, end: last.start + last.speechL.length, contiguous };
}

/** Scale-invariant SDR in dB of `estimate` against `reference` over [start, end). */
export function siSdr(estimate: ArrayLike<number>, reference: ArrayLike<number>, start = 0, end = reference.length): number {
  let er = 0;
  let rr = 0;
  for (let i = start; i < end; i++) {
    er += estimate[i]! * reference[i]!;
    rr += reference[i]! * reference[i]!;
  }
  const a = er / rr;
  let signal = 0;
  let noise = 0;
  for (let i = start; i < end; i++) {
    const s = a * reference[i]!;
    const d = estimate[i]! - s;
    signal += s * s;
    noise += d * d;
  }
  return 10 * Math.log10(signal / noise);
}

/** Deterministic uniform noise in [-amp, amp). */
export function noise(n: number, amp: number, seed = 1): Float32Array {
  let s = seed >>> 0 || 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = (2 * (s / 4294967296) - 1) * amp;
  }
  return out;
}
