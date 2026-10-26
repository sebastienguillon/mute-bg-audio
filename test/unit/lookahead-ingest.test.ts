import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDemuxer, type EncodedAudioFrame } from '../../src/lib/demux/index';
import { MseAudioIngest, type DecoderFactory, type IngestListener } from '../../src/lib/lookahead/ingest';
import type { PcmStore } from '../../src/lib/lookahead/pcm-store';
import {
  FAKE_CODEC_DELAY,
  SR,
  fakeDecoderFactory,
  fixturePath,
  newDecoderLog,
  readFixtureWav,
  sbAdd,
  sbAppend,
  splitWebm,
  waitFor,
  webmAppends,
  type DecoderLog,
  type Wav,
} from './helpers/lookahead-media';

let mix: Wav;
let webm: Uint8Array;
let frames: EncodedAudioFrame[];

beforeAll(() => {
  mix = readFixtureWav('mix.wav');
  webm = new Uint8Array(readFileSync(fixturePath('mix.webm')));
  frames = createDemuxer('audio/webm')!
    .push(webm)
    .flatMap((e) => (e.type === 'frames' ? e.frames : []));
});

/** Media index range [start, end) of the frames decoded as one continuous run, shifted by `offset` seconds. */
function frameSpan(list: EncodedAudioFrame[], offset = 0): { start: number; end: number } {
  const start = Math.round((list[0]!.pts + offset) * SR);
  return { start, end: list.reduce((end, f) => end + Math.round(f.duration * SR), start) };
}

/** mix.webm block timestamps after the first are rounded 1 ms late (pts = 20k + 1 ms). */
const WEBM_JITTER = 48;

interface Events {
  data: number;
  errors: string[];
  unsupported: string[];
  changes: [number, number, number][];
  gone: number[];
}

interface Setup {
  ingest: MseAudioIngest;
  log: DecoderLog;
  events: Events;
  /** The ingest's clock (ms). */
  clock: { now: number };
}

function setup(factory?: DecoderFactory, opts: { maxEncodedBytes?: number } = {}): Setup {
  const log = newDecoderLog();
  const events: Events = { data: 0, errors: [], unsupported: [], changes: [], gone: [] };
  const clock = { now: 0 };
  const listener: IngestListener = {
    onData: () => events.data++,
    onError: (_id, message) => events.errors.push(message),
    onUnsupported: (_id, reason) => events.unsupported.push(reason),
    onPcmChanged: (id, start, end) => events.changes.push([id, start, end]),
    onTimelineGone: (id) => events.gone.push(id),
  };
  const ingest = new MseAudioIngest({
    decoderFactory: factory ?? fakeDecoderFactory(mix, log),
    listener,
    maxSamplesPerTimeline: SR * 600,
    now: () => clock.now,
    ...opts,
  });
  return { ingest, log, events, clock };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Max |store − source| over [start, end), where store index m holds source[m − shift]. */
function maxError(store: PcmStore, source: Wav, start: number, end: number, shift: number): number {
  const l = new Float32Array(end - start);
  const r = new Float32Array(end - start);
  store.read(start, end - start, l, r);
  let worst = 0;
  for (let i = 0; i < l.length; i++) {
    const j = start + i - shift;
    const el = j >= 0 && j < source.channels[0]!.length ? source.channels[0]![j]! : 0;
    const er = j >= 0 && j < source.channels[1]!.length ? source.channels[1]![j]! : 0;
    worst = Math.max(worst, Math.abs(l[i]! - el), Math.abs(r[i]! - er));
  }
  return worst;
}

describe('MseAudioIngest', () => {
  it('decodes YouTube-like WebM/Opus appends into PCM covering the media times', async () => {
    const { ingest, log, events } = setup();
    ingest.handle(sbAdd(1, 1, 'video/webm; codecs="vp9"'));
    ingest.handle(sbAdd(1, 2));
    const appends = webmAppends(1, 2, webm);
    expect(appends.length).toBe(8);
    for (const msg of appends) {
      ingest.handle(msg);
      await tick();
    }
    const store = ingest.store(1)!;
    const span = frameSpan(frames);
    expect(span).toEqual({ start: 0, end: 1501 * 960 });
    expect(store.ranges()).toEqual([span]);
    expect(maxError(store, mix, span.start, span.end, 0)).toBe(0);
    expect(log.created).toBe(1);
    expect(log.decoded).toBe(frames.length);
    expect(events.errors).toEqual([]);
    expect(events.data).toBeGreaterThan(0);
  });

  it('applies timestampOffset and the append window like MSE', async () => {
    const { ingest, log } = setup();
    ingest.handle(sbAdd(3, 1));
    // First copy at 100 s, cut at 130 s by the append window; second copy right after it.
    for (const msg of webmAppends(3, 1, webm, { timestampOffset: 100, appendWindowEnd: 130 })) ingest.handle(msg);
    for (const msg of webmAppends(3, 1, webm, { timestampOffset: 130 })) ingest.handle(msg);
    await tick();
    expect(log.timestamps[0]).toBe(100);
    const store = ingest.store(3)!;
    const end = frameSpan(frames, 130).end;
    expect(store.ranges()).toEqual([{ start: 100 * SR, end }]);
    expect(end).toBe(130 * SR + 1501 * 960);
    // Contiguous timestamps: one decoder run for both copies.
    expect(log.created).toBe(1);
    expect(maxError(store, mix, 100 * SR, 130 * SR, 100 * SR)).toBe(0);
    expect(maxError(store, mix, 130 * SR, end, 130 * SR)).toBe(0);
  });

  it('starts a new decoder at a discontinuity and retires the old one after flushing it', async () => {
    const { ingest, log } = setup();
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    ingest.handle(sbAppend(1, 1, init));
    ingest.handle(sbAppend(1, 1, clusters[0]!));
    // Seek: the page appends cluster 4 (no abort), then continues.
    ingest.handle(sbAppend(1, 1, clusters[4]!));
    ingest.handle(sbAppend(1, 1, clusters[5]!));
    await tick();
    await tick();
    expect(log.created).toBe(2);
    expect(log.closed).toBe(1);
    const clusterFrames = (c: Uint8Array) =>
      createDemuxer('audio/webm')!
        .push(new Uint8Array([...init, ...c]))
        .flatMap((e) => (e.type === 'frames' ? e.frames : []));
    const c0 = frameSpan(clusterFrames(clusters[0]!));
    const c4 = frameSpan(clusterFrames(clusters[4]!));
    const c5 = frameSpan(clusterFrames(clusters[5]!));
    expect(c4.start % 960).toBe(WEBM_JITTER);
    expect(ingest.store(1)!.ranges()).toEqual([c0, { start: c4.start, end: c4.start + (c4.end - c4.start) + (c5.end - c5.start) }]);
    expect(maxError(ingest.store(1)!, mix, c0.start, c0.end, 0)).toBe(0);
    expect(maxError(ingest.store(1)!, mix, c4.start, c5.end, WEBM_JITTER)).toBe(0);
  });

  it('ignores failed appends, recovers after abort and drops removed ranges', async () => {
    const { ingest } = setup();
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    ingest.handle(sbAppend(1, 1, init));
    ingest.handle(sbAppend(1, 1, clusters[0]!, { ok: false }));
    await tick();
    expect(ingest.store(1)!.ranges()).toEqual([]);
    // Half a cluster, then abort() and a whole cluster.
    ingest.handle(sbAppend(1, 1, clusters[1]!.subarray(0, 40000)));
    ingest.handle({ type: 'sb-abort', msId: 1, sbId: 1 });
    ingest.handle(sbAppend(1, 1, clusters[3]!));
    await tick();
    const ranges = ingest.store(1)!.ranges();
    expect(ranges).toHaveLength(2);
    const c3start = ranges[1]!.start;
    expect(ranges[1]!.end - c3start).toBeGreaterThan(4.5 * SR);
    for (const range of ranges) expect(maxError(ingest.store(1)!, mix, range.start, range.end, WEBM_JITTER)).toBe(0);
    // sb-remove drops PCM (seconds → media indices).
    ingest.handle({ type: 'sb-remove', msId: 1, sbId: 1, start: 0, end: c3start / SR + 1 });
    expect(ingest.store(1)!.ranges()).toEqual([{ start: c3start + SR, end: ranges[1]!.end }]);
    ingest.handle({ type: 'sb-remove', msId: 1, sbId: 1, start: 0, end: Infinity });
    expect(ingest.store(1)!.ranges()).toEqual([]);
  });

  it('switches to the MP4 demuxer on changeType', async () => {
    const { ingest, log } = setup();
    ingest.handle(sbAdd(1, 1));
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAppend(1, 1, init));
    ingest.handle(sbAppend(1, 1, clusters[0]!));
    ingest.handle({ type: 'sb-change-type', msId: 1, sbId: 1, mime: 'audio/mp4; codecs="mp4a.40.2"' });
    const mp4 = new Uint8Array(readFileSync(fixturePath('mix-aac.mp4')));
    ingest.handle(sbAppend(1, 1, mp4));
    await tick();
    await tick();
    expect(log.created).toBe(2);
    const mp4Frames = createDemuxer('audio/mp4')!
      .push(mp4)
      .flatMap((e) => (e.type === 'frames' ? e.frames : []));
    const span = frameSpan(mp4Frames);
    const ranges = ingest.store(1)!.ranges();
    expect(ranges[ranges.length - 1]!.end).toBe(span.end);
    expect(ranges[0]!.start).toBe(0);
  });

  it('forgets a timeline when its last audio SourceBuffer goes away', async () => {
    const { ingest, events, log } = setup();
    ingest.handle(sbAdd(1, 1, 'video/webm; codecs="vp9"'));
    expect(ingest.store(1)).toBeUndefined();
    ingest.handle(sbAdd(1, 2));
    for (const msg of webmAppends(1, 2, webm).slice(0, 3)) ingest.handle(msg);
    await tick();
    expect(ingest.store(1)!.size).toBeGreaterThan(0);
    ingest.handle({ type: 'sb-gone', msId: 1, sbId: 2 });
    expect(events.gone).toEqual([1]);
    expect(ingest.store(1)).toBeUndefined();
    expect([...ingest.timelineIds()]).toEqual([]);
    expect(log.closed).toBe(1);
  });

  it('restarts the decoder after an error, and stops after 3 errors within 10 s until the next initialization segment', async () => {
    // When set, the current decoder reports an error for the next frame (its later outputs are lost).
    let failNext = false;
    const log = newDecoderLog();
    const inner = fakeDecoderFactory(mix, log);
    const factory: DecoderFactory = (config, onOutput, onError) => {
      const decoder = inner(config, onOutput, onError);
      return {
        ...decoder,
        decode(frame, timestamp) {
          if (!failNext) return decoder.decode(frame, timestamp);
          failNext = false;
          queueMicrotask(() => onError('EncodingError: bad packet'));
        },
      };
    };
    const { ingest, events, clock } = setup(factory);
    const { init, clusters } = splitWebm(webm);
    const store = () => ingest.store(1)!;
    const append = async (k: number, fail = false) => {
      failNext = fail;
      ingest.handle(sbAppend(1, 1, clusters[k]!));
      await tick();
    };
    ingest.handle(sbAdd(1, 1));
    ingest.handle(sbAppend(1, 1, init));
    await append(0, true);
    expect(events.errors).toEqual(['Audio decoder: EncodingError: bad packet']);
    expect(store().size).toBe(0);
    // One error: the next append is decoded by a new decoder, without a new initialization segment.
    await append(1);
    expect(log.created).toBe(2);
    expect(store().size).toBeGreaterThan(4.5 * SR);

    // Errors more than 10 s apart never stop decoding.
    for (const k of [2, 3]) {
      clock.now += 11_000;
      await append(k, true);
    }
    expect(events.errors).toHaveLength(3);
    let size = store().size;
    await append(4);
    expect(store().size).toBeGreaterThan(size + 4.5 * SR);

    // Three errors within 10 s: decoding stops…
    clock.now += 11_000;
    for (const k of [5, 6, 0]) {
      await append(k, true);
      clock.now += 1000;
    }
    expect(events.errors).toHaveLength(6);
    const created = log.created;
    size = store().size;
    await append(1);
    expect(log.created).toBe(created);
    expect(store().size).toBe(size);
    // …until the next initialization segment.
    ingest.handle(sbAppend(1, 1, init));
    await append(2);
    expect(log.created).toBe(created + 1);
    expect(store().size).toBeGreaterThan(size);
  });

  it('does not decode a frame that made the decoder fail again as pre-roll of the next decoder', async () => {
    // Every decoder fails on one corrupt frame (asynchronously, like WebCodecs) and loses its later outputs.
    const { init, clusters } = splitWebm(webm);
    const clusterFrames = createDemuxer('audio/webm')!
      .push(new Uint8Array([...init, ...clusters[1]!]))
      .flatMap((e) => (e.type === 'frames' ? e.frames : []));
    const corrupt = clusterFrames[clusterFrames.length - 1]!.pts;
    const log = newDecoderLog();
    const inner = fakeDecoderFactory(mix, log);
    const factory: DecoderFactory = (config, onOutput, onError) => {
      let dead = false;
      const decoder = inner(config, (audio) => dead || onOutput(audio), onError);
      return {
        ...decoder,
        decode(frame, timestamp) {
          if (dead) return;
          if (frame.pts !== corrupt) return decoder.decode(frame, timestamp);
          dead = true;
          queueMicrotask(() => onError('EncodingError: corrupt packet'));
        },
      };
    };
    const { ingest, events } = setup(factory);
    ingest.handle(sbAdd(1, 1));
    ingest.handle(sbAppend(1, 1, init));
    for (const c of clusters.slice(0, 5)) {
      ingest.handle(sbAppend(1, 1, c));
      await tick();
    }
    // One error; the decoders after it start without the corrupt frame and decode everything after it.
    expect(events.errors).toEqual(['Audio decoder: EncodingError: corrupt packet']);
    const end = frameSpan(createDemuxer('audio/webm')!.push(new Uint8Array([...init, ...clusters.slice(0, 5).flatMap((c) => [...c])])).flatMap((e) => (e.type === 'frames' ? e.frames : []))).end;
    const ranges = ingest.store(1)!.ranges();
    expect(ranges[ranges.length - 1]!.end).toBe(end);
    expect(ranges[ranges.length - 1]!.start).toBeLessThanOrEqual(10 * SR);
  });

  it('keeps the encoded frames and decodes evicted PCM again on demand, aligned with the original decode', async () => {
    const { ingest, log, events, clock } = setup();
    ingest.handle(sbAdd(1, 1));
    for (const msg of webmAppends(1, 1, webm)) ingest.handle(msg);
    await tick();
    const store = ingest.store(1)!;
    const end = 1501 * 960;
    expect(store.ranges()).toEqual([{ start: 0, end }]);
    expect(ingest.encodedBytes(1)).toBeGreaterThan(webm.length / 2);
    // The core evicts the PCM behind the playhead (a seek back follows).
    store.remove(0, 25 * SR);
    // Frames appended within the last second may still be in the live decoder: not decoded again.
    ingest.redecode(1, 5 * SR, 20 * SR);
    await tick();
    expect(log.created).toBe(1);
    clock.now += 2000;
    const data = events.data;
    ingest.redecode(1, 5 * SR, 20 * SR);
    // A request for a range being decoded starts nothing more.
    ingest.redecode(1, 6 * SR, 7 * SR);
    expect(log.created).toBe(2);
    await tick();
    await tick();
    expect(events.data).toBeGreaterThan(data);
    // The range, and the 0.1 s after it that the decoder ran on so that the range's end is written.
    expect(store.ranges()).toEqual([
      { start: 5 * SR, end: 20 * SR + SR / 10 },
      { start: 25 * SR, end },
    ]);
    // Same samples as the first decode (which placed the jittered WebM timestamps contiguously).
    expect(maxError(store, mix, 5 * SR, 20 * SR + SR / 10, 0)).toBe(0);
    expect(log.closed).toBe(1);
    // A gap without retained frames (before the media) starts nothing; nor does a covered range.
    ingest.redecode(1, -10 * SR, -SR);
    ingest.redecode(1, 25 * SR, 26 * SR);
    expect(log.created).toBe(2);
    expect(events.errors).toEqual([]);
  });

  it('drops retained frames on sb-remove and keeps those nearest the playhead within its byte bound', async () => {
    const { ingest, clock } = setup(undefined, { maxEncodedBytes: 200_000 });
    ingest.handle(sbAdd(1, 1));
    ingest.setFocus(1, 0);
    for (const msg of webmAppends(1, 1, webm)) ingest.handle(msg);
    await tick();
    const bytes = ingest.encodedBytes(1);
    expect(bytes).toBeLessThanOrEqual(200_000);
    expect(bytes).toBeGreaterThan(150_000);
    clock.now += 2000;
    const store = ingest.store(1)!;
    store.remove(-Infinity, Infinity);
    // Frames near the focus (0 s) were kept, the later ones dropped.
    ingest.redecode(1, 0, 30 * SR);
    await tick();
    await tick();
    const kept = store.ranges();
    expect(kept).toHaveLength(1);
    expect(kept[0]!.start).toBe(0);
    expect(kept[0]!.end).toBeLessThan(25 * SR);
    // sb-remove drops the frames (and PCM) of the range.
    ingest.handle({ type: 'sb-remove', msId: 1, sbId: 1, start: 0, end: 30 });
    expect(ingest.encodedBytes(1)).toBe(0);
    expect(store.size).toBe(0);
  });

  it('reports removed PCM and PCM replaced with different audio, not identical re-appends', async () => {
    let source = mix;
    const factory: DecoderFactory = (config, onOutput, onError) => fakeDecoderFactory(source)(config, onOutput, onError);
    const { ingest, events } = setup(factory);
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    ingest.handle(sbAppend(1, 1, init));
    for (const c of clusters.slice(0, 3)) ingest.handle(sbAppend(1, 1, c));
    await tick();
    expect(events.changes).toEqual([]);
    // The same cluster again (an overlapping re-append of identical data).
    ingest.handle(sbAppend(1, 1, clusters[1]!));
    await tick();
    expect(events.changes).toEqual([]);
    // Other audio for the same media time (e.g. another audio track).
    source = readFixtureWav('speech.wav');
    ingest.handle(sbAppend(1, 1, clusters[1]!));
    await tick();
    const span = frameSpan(
      createDemuxer('audio/webm')!
        .push(new Uint8Array([...init, ...clusters[1]!]))
        .flatMap((e) => (e.type === 'frames' ? e.frames : [])),
    );
    expect(events.changes.length).toBeGreaterThan(0);
    for (const [id, start, end] of events.changes) {
      expect(id).toBe(1);
      expect(start).toBeGreaterThanOrEqual(span.start - WEBM_JITTER);
      expect(end).toBeLessThanOrEqual(span.end + WEBM_JITTER);
    }
    // Removing stored PCM is a change; removing nothing is not.
    events.changes.length = 0;
    ingest.handle({ type: 'sb-remove', msId: 1, sbId: 1, start: 100, end: 110 });
    expect(events.changes).toEqual([]);
    ingest.handle({ type: 'sb-remove', msId: 1, sbId: 1, start: 1, end: 2 });
    expect(events.changes).toEqual([[1, SR, 2 * SR]]);
  });

  it('downmixes 5.1 decoder output and reports layouts without a stereo downmix as unsupported', async () => {
    let channels = 6;
    const inner = fakeDecoderFactory(mix);
    const factory: DecoderFactory = (config, onOutput, onError) =>
      inner(config, (audio) => {
        const [l, r] = audio.channels as [Float32Array, Float32Array];
        const silent = new Float32Array(l.length);
        // L, R, C, LFE, SL, SR with only the front channels carrying the mix.
        const planes = [l, r, silent, silent, silent, silent, silent, silent].slice(0, channels);
        onOutput({ ...audio, channels: planes });
      }, onError);
    const { ingest, events } = setup(factory);
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    ingest.handle(sbAppend(1, 1, init));
    ingest.handle(sbAppend(1, 1, clusters[0]!));
    await tick();
    const first = ingest.store(1)!.ranges();
    expect(first).toHaveLength(1);
    expect(maxError(ingest.store(1)!, mix, first[0]!.start, first[0]!.end, 0)).toBe(0);
    channels = 3;
    ingest.handle(sbAppend(1, 1, clusters[3]!));
    await tick();
    expect(events.unsupported).toEqual(['Look-ahead does not support 3-channel audio. Using real-time mode.']);
    expect(ingest.store(1)!.ranges()).toEqual(first);
    // Nothing more is decoded for this SourceBuffer.
    ingest.handle(sbAppend(1, 1, clusters[4]!));
    await tick();
    expect(ingest.store(1)!.ranges()).toEqual(first);
  });

  it('suspend() drops all PCM and frames and decodes nothing until resume()', async () => {
    const { ingest, log } = setup();
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    ingest.handle(sbAppend(1, 1, init));
    ingest.handle(sbAppend(1, 1, clusters[0]!));
    await tick();
    expect(ingest.store(1)!.size).toBeGreaterThan(0);
    ingest.suspend();
    expect(ingest.store(1)!.size).toBe(0);
    expect(ingest.store(1)!.pooledSamples).toBe(0);
    expect(ingest.encodedBytes(1)).toBe(0);
    expect(log.closed).toBe(log.created);
    const decoded = log.decoded;
    ingest.handle(sbAppend(1, 1, clusters[1]!));
    await tick();
    expect(log.decoded).toBe(decoded);
    expect(ingest.store(1)!.size).toBe(0);
    // The appends were still parsed: decoding resumes with the next cluster, no init segment needed.
    ingest.resume();
    ingest.handle(sbAppend(1, 1, clusters[2]!));
    await tick();
    expect(ingest.store(1)!.size).toBeGreaterThan(4.5 * SR);
  });

  it('releases everything of closed MediaSources: no timelines, tracks, open decoders or pooled chunks remain', async () => {
    const { ingest, log, events } = setup();
    const { init, clusters } = splitWebm(webm);
    const stores = [];
    for (let msId = 1; msId <= 12; msId++) {
      ingest.handle(sbAdd(msId, 1));
      ingest.handle(sbAppend(msId, 1, init));
      ingest.handle(sbAppend(msId, 1, clusters[msId % clusters.length]!));
      await tick();
      const store = ingest.store(msId)!;
      stores.push(store);
      store.remove(0, 2 * SR); // some chunks go to the pool
      ingest.handle({ type: 'sb-gone', msId, sbId: 1 });
    }
    expect([...ingest.timelineIds()]).toEqual([]);
    expect(events.gone).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(log.closed).toBe(log.created);
    for (const store of stores) expect(store.allocatedSamples + store.pooledSamples).toBe(0);
  });
});

describe('MseAudioIngest.decoding', () => {
  it('holds while the live decoder still owes output for the range, for at most a second', async () => {
    // Batches of 25 outputs (0.5 s) every 10 ms.
    const { ingest } = setup(fakeDecoderFactory(mix, undefined, { batch: 25, batchMs: 10 }));
    ingest.handle(sbAdd(1, 1));
    for (const msg of webmAppends(1, 1, webm)) ingest.handle(msg);
    const end = 1501 * 960;
    expect(ingest.decoding(1, 0, end)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    const store = ingest.store(1)!;
    const decoded = store.contiguousEnd(0);
    expect(decoded).toBeGreaterThan(0);
    expect(decoded).toBeLessThan(end);
    expect(ingest.decoding(1, decoded, end)).toBe(true);
    // Not for audio before what it owes, nor after what it was given.
    expect(ingest.decoding(1, 0, decoded - SR)).toBe(false);
    expect(ingest.decoding(1, end + SR, end + 2 * SR)).toBe(false);
    expect(ingest.decoding(2, decoded, end)).toBe(false);
    await waitFor(() => store.contiguousEnd(0) >= end, 5000, 'all output');
    expect(ingest.decoding(1, 0, end)).toBe(false);
  });

  it('gives up on a decoder that delivers nothing after a second', () => {
    const silent: DecoderFactory = () => ({ decode: () => {}, flush: async () => {}, reset: () => {}, close: () => {} });
    const { ingest, clock } = setup(silent);
    ingest.handle(sbAdd(1, 1));
    for (const msg of webmAppends(1, 1, webm)) ingest.handle(msg);
    expect(ingest.decoding(1, 0, SR)).toBe(true);
    clock.now = 999;
    expect(ingest.decoding(1, 0, SR)).toBe(true);
    clock.now = 1000;
    expect(ingest.decoding(1, 0, SR)).toBe(false);
  });
});

describe('MseAudioIngest with a Chrome-like decoder (codec delay, unsettled start)', () => {
  const chrome = (log = newDecoderLog()) => fakeDecoderFactory(mix, log, { chromeOpus: true });
  const appendAll = async (ingest: MseAudioIngest, list: Uint8Array[], opts: Parameters<typeof sbAppend>[3] = {}) => {
    for (const c of list) ingest.handle(sbAppend(1, 1, c, opts));
    await tick();
    await tick();
  };

  /** The PCM of one continuous decode of the whole file. */
  async function reference(): Promise<PcmStore> {
    const { ingest } = setup(chrome());
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    await appendAll(ingest, [init, ...clusters]);
    return ingest.store(1)!;
  }

  /** Stores hold the same ranges and samples. */
  function expectSame(store: PcmStore, ref: PcmStore): void {
    expect(store.ranges()).toEqual(ref.ranges());
    for (const { start, end } of ref.ranges()) {
      const read = (s: PcmStore) => {
        const l = new Float32Array(end - start);
        const r = new Float32Array(end - start);
        s.read(start, end - start, l, r);
        return [l, r];
      };
      expect(read(store)).toEqual(read(ref));
    }
  }

  it('models the decoder: one run ends the codec delay before its last frame, its start differs', async () => {
    const ref = await reference();
    expect(ref.ranges()).toEqual([{ start: 0, end: 1501 * 960 - FAKE_CODEC_DELAY }]);
    // Only the decoder's start is off (and kept provisional: no pre-roll exists before the media start).
    expect(maxError(ref, mix, 1608, 1501 * 960 - FAKE_CODEC_DELAY, 0)).toBe(0);
    expect(maxError(ref, mix, 0, 1608, 0)).toBeGreaterThan(0.01);
    expect(ref.provisionalRanges()).toEqual([{ start: 0, end: 3840 }]);
  });

  it('gives the PCM of one continuous decode for an identical re-append, without reporting a change', async () => {
    const ref = await reference();
    const log = newDecoderLog();
    const { ingest, events } = setup(chrome(log));
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    await appendAll(ingest, [init, ...clusters]);
    // Clusters 2–4 again (an overlapping re-append of identical data), then the next appends.
    await appendAll(ingest, clusters.slice(2, 5));
    expect(log.created).toBe(2);
    expect(events.changes).toEqual([]);
    expectSame(ingest.store(1)!, ref);
  });

  it('gives the PCM of one continuous decode when the page fills a gap after seeks, without reporting a change', async () => {
    const ref = await reference();
    const { ingest, events, clock } = setup(chrome());
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    await appendAll(ingest, [init, ...clusters.slice(0, 2)]);
    // A seek forwards: clusters 5–7 (placed at exact timestamps, like YouTube's), whose decoder starts unsettled…
    await appendAll(ingest, clusters.slice(5), { timestampOffset: -0.001 });
    expect(ingest.store(1)!.provisionalRanges()).toHaveLength(2);
    // …then the page fills the gap, overlapping cluster 5: its settled audio replaces the unsettled start.
    await appendAll(ingest, clusters.slice(2, 6));
    expect(events.changes).toEqual([]);
    clock.now += 2000;
    expectSame(ingest.store(1)!, ref);
    expect(ingest.store(1)!.provisionalRanges()).toEqual(ref.provisionalRanges());
  });

  it("keeps what is stored when the hook replays a SourceBuffer's init segment and recent appends", async () => {
    const ref = await reference();
    const { ingest, events } = setup(chrome());
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    // The live appends end in the middle of cluster 4.
    const half = clusters[4]!.subarray(0, 30_000);
    await appendAll(ingest, [init, ...clusters.slice(0, 4), half]);
    const bytes = ingest.encodedBytes(1);
    // The hook reconnects: sb-add, the init segment and the recent appends again, then the live appends go on.
    ingest.handle(sbAdd(1, 1));
    await appendAll(ingest, [init, ...clusters.slice(1, 4), half]);
    await appendAll(ingest, [clusters[4]!.subarray(30_000), ...clusters.slice(5)]);
    expect(events.gone).toEqual([]);
    expect(events.changes).toEqual([]);
    expect(events.errors).toEqual([]);
    expect(ingest.encodedBytes(1)).toBeGreaterThan(bytes);
    expectSame(ingest.store(1)!, ref);
  });

  it('starts no re-decode at the live edge, where the decoder holds the last samples back', async () => {
    const log = newDecoderLog();
    const { ingest, clock } = setup(chrome(log));
    const { init, clusters } = splitWebm(webm);
    ingest.handle(sbAdd(1, 1));
    await appendAll(ingest, [init, ...clusters]);
    clock.now += 2000;
    const end = 1501 * 960;
    expect(ingest.store(1)!.ranges()).toEqual([{ start: 0, end: end - FAKE_CODEC_DELAY }]);
    // The missing end [end − 312, end) only comes with the next append: nothing to decode again.
    for (let k = 0; k < 3; k++) {
      ingest.redecode(1, end - SR, end + 10 * SR);
      clock.now += 6000;
      await tick();
    }
    expect(log.created).toBe(1);
    // An evicted range inside the frames is decoded again, settled from its start.
    ingest.store(1)!.remove(10 * SR, 11 * SR);
    ingest.redecode(1, 9 * SR, 12 * SR);
    await tick();
    await tick();
    expect(log.created).toBe(2);
    expect(ingest.store(1)!.ranges()).toEqual([{ start: 0, end: end - FAKE_CODEC_DELAY }]);
    expect(maxError(ingest.store(1)!, mix, 10 * SR, 11 * SR, 0)).toBe(0);
  });

  it('backs off re-decodes that store nothing', async () => {
    let silent = false;
    const log = newDecoderLog();
    const inner = fakeDecoderFactory(mix, log);
    const factory: DecoderFactory = (config, onOutput, onError) => inner(config, (audio) => silent || onOutput(audio), onError);
    const { ingest, clock } = setup(factory);
    ingest.handle(sbAdd(1, 1));
    for (const msg of webmAppends(1, 1, webm)) ingest.handle(msg);
    await tick();
    clock.now += 2000;
    const store = ingest.store(1)!;
    store.remove(10 * SR, 20 * SR);
    silent = true;
    /** Asks for [from, to) s at `ms` after the previous request; true when a decoder was started. */
    const attempt = async (ms: number, from = 10, to = 20) => {
      clock.now += ms;
      const created = log.created;
      ingest.redecode(1, from * SR, to * SR);
      await tick();
      await tick();
      return log.created > created;
    };
    // Waits of 5 s, 10 s, 20 s…, also for overlapping ranges.
    expect(await attempt(0)).toBe(true);
    expect(await attempt(4000, 12, 18)).toBe(false);
    expect(await attempt(1500)).toBe(true);
    expect(await attempt(6000)).toBe(false);
    expect(await attempt(5000)).toBe(true);
    expect(await attempt(19_000, 15, 25)).toBe(false);
    // A range that does not overlap is not held up.
    store.remove(25 * SR, 26 * SR);
    expect(await attempt(0, 25, 26)).toBe(true);
    // Once a re-decode stores something, the waits start over.
    silent = false;
    expect(await attempt(21_000)).toBe(true);
    expect(store.covers(10 * SR, 20 * SR)).toBe(true);
  });
});
