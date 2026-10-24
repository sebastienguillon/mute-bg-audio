import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDemuxer } from '../../src/lib/demux';
import type { Demuxer, EncodedAudioFrame } from '../../src/lib/demux/types';
import { opusPacketSamples } from '../../src/lib/demux/opus';
import {
  ID, blockGroup, cluster, el, elUnknown, opusHead, opusPacket, simpleBlock, trackEntry, uintEl, webmInit,
} from './helpers/demux-builders';
import { concat, feed, fixture, makeDash, md5, probe, randomChunks, rng, type ProbePacket, type ProbeResult } from './helpers/demux-media';

const webm = (): Demuxer => createDemuxer('audio/webm; codecs="opus"')!;

/**
 * Compares frames with ffprobe packets. ffmpeg's Matroska demuxer subtracts the CodecDelay
 * (rounded to ticks) from timestamps; the demuxer reports raw container timestamps.
 */
function expectFramesMatch(frames: EncodedAudioFrame[], packets: ProbePacket[], timeBase: number, ptsOffsetTicks: number): void {
  expect(frames.length).toBe(packets.length);
  const mismatches: string[] = [];
  frames.forEach((f, k) => {
    const p = packets[k]!;
    const pts = Math.round(f.pts / timeBase) - ptsOffsetTicks;
    const duration = Math.round(f.duration / timeBase);
    if (pts !== p.pts || f.data.length !== p.size || md5(f.data) !== p.md5 || (p.duration !== null && duration !== p.duration)) {
      mismatches.push(`#${k}: pts ${pts} vs ${p.pts}, size ${f.data.length} vs ${p.size}, duration ${duration} vs ${p.duration}`);
    }
  });
  expect(mismatches.slice(0, 5)).toEqual([]);
}

/** CodecDelay of the generated fixtures (312 samples = 6.5 ms) as ffmpeg rounds it to 1 ms ticks. */
const CODEC_DELAY_TICKS = 7;

describe('WebM demuxer on mix.webm (ffprobe ground truth)', () => {
  let bytes: Uint8Array;
  let truth: ProbeResult;
  beforeAll(() => {
    bytes = new Uint8Array(readFileSync(fixture('mix.webm')));
    truth = probe(fixture('mix.webm'));
  });

  it('parses the file in one push', () => {
    const out = feed(webm(), [bytes.slice()]);
    expect(out.errors).toEqual([]);
    expect(out.configs).toHaveLength(1);
    const config = out.configs[0]!;
    expect(config.codec).toBe('opus');
    expect(config.sampleRate).toBe(48000);
    expect(config.channels).toBe(2);
    expect(config.codecDelaySamples).toBe(312);
    expect(md5(config.description!)).toBe(truth.extradataMd5);
    expect(out.order).toEqual(['config', 'frames']);
    expectFramesMatch(out.frames, truth.packets, truth.timeBase, CODEC_DELAY_TICKS);
    expect(out.frames[0]!.pts).toBe(0);
    for (const f of out.frames) expect(f.duration).toBe(opusPacketSamples(f.data) / 48000);
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`parses random chunks of 1..20000 bytes (seed ${seed})`, () => {
      const out = feed(webm(), randomChunks(bytes, seed, 1, 20000));
      expect(out.errors).toEqual([]);
      expect(out.configs).toHaveLength(1);
      expectFramesMatch(out.frames, truth.packets, truth.timeBase, CODEC_DELAY_TICKS);
    });
  }

  it('parses tiny chunks of 1..16 bytes', () => {
    const out = feed(webm(), randomChunks(bytes, 42, 1, 16));
    expect(out.errors).toEqual([]);
    expectFramesMatch(out.frames, truth.packets, truth.timeBase, CODEC_DELAY_TICKS);
  });

  it('keeps only a bounded unparsed tail', () => {
    const demuxer = webm();
    const queue = (demuxer as unknown as { queue: { start: number; end: number } }).queue;
    let maxRetained = 0;
    for (const chunk of randomChunks(bytes, 7, 1, 20000)) {
      demuxer.push(chunk);
      maxRetained = Math.max(maxRetained, queue.end - queue.start);
    }
    expect(maxRetained).toBeLessThan(2000); // at most one partial block (Opus packets are < 1500 bytes)
  });

  it('matches audio-only.webm (non-zero first timestamp)', () => {
    const t = probe(fixture('audio-only.webm'));
    const out = feed(webm(), randomChunks(new Uint8Array(readFileSync(fixture('audio-only.webm'))), 11, 1000, 50000));
    expect(out.errors).toEqual([]);
    expectFramesMatch(out.frames, t.packets, t.timeBase, CODEC_DELAY_TICKS);
  });
});

describe('WebM demuxer on DASH segments (appendBuffer-like pushes)', () => {
  let dash: ReturnType<typeof makeDash>;
  let truth: ProbeResult;
  let ranges: [number, number][];
  const packetsOf = (k: number) => truth.packets.filter((p) => p.pos >= ranges[k]![0] && p.pos < ranges[k]![1]);

  beforeAll(() => {
    dash = makeDash('webm-opus', 'webm', ['-c:a', 'libopus', '-b:a', '128k']);
    truth = probe(dash.concatenated);
    let o = dash.init.length;
    ranges = dash.segments.map((s) => {
      const r: [number, number] = [o, o + s.length];
      o += s.length;
      return r;
    });
  });

  it('demuxes an init segment followed by Cluster-only media segments', () => {
    expect(dash.segments.length).toBeGreaterThan(10);
    expect(dash.segments[1]![0]).toBe(0x1f); // media segments start directly with a Cluster
    const out = feed(webm(), [dash.init.slice(), ...dash.segments.map((s) => s.slice())]);
    expect(out.errors).toEqual([]);
    expect(out.configs).toHaveLength(1);
    expectFramesMatch(out.frames, truth.packets, truth.timeBase, CODEC_DELAY_TICKS);
  });

  it('recovers the right timestamps after reset() in the middle of a segment (seek)', () => {
    const demuxer = webm();
    const seg1 = dash.segments[1]!;
    const before = feed(demuxer, [dash.init.slice(), dash.segments[0]!.slice(), seg1.slice(0, seg1.length >> 1)]);
    demuxer.reset();
    const after = feed(demuxer, [...randomChunks(dash.segments[6]!, 3, 1, 5000), dash.segments[7]!.slice()]);
    expect([...before.errors, ...after.errors]).toEqual([]);
    expect(after.configs).toHaveLength(0);

    const partial = before.frames.length - packetsOf(0).length;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(packetsOf(1).length);
    expectFramesMatch(before.frames, [...packetsOf(0), ...packetsOf(1).slice(0, partial)], truth.timeBase, CODEC_DELAY_TICKS);
    expectFramesMatch(after.frames, [...packetsOf(6), ...packetsOf(7)], truth.timeBase, CODEC_DELAY_TICKS);
    expect(after.frames[0]!.pts).toBeGreaterThan(11.9);
  });

  it('re-emits the config when an init segment is appended again', () => {
    const out = feed(webm(), [dash.init.slice(), dash.segments[0]!.slice(), dash.init.slice(), dash.segments[1]!.slice()]);
    expect(out.errors).toEqual([]);
    expect(out.order).toEqual(['config', 'frames', 'config', 'frames']);
    expectFramesMatch(out.frames, [...packetsOf(0), ...packetsOf(1)], truth.timeBase, CODEC_DELAY_TICKS);
  });
});

describe('WebM demuxer on synthetic streams', () => {
  const p20 = (size = 40, fill = 1) => opusPacket(0xfc, size, fill); // CELT FB 20 ms
  const p10 = (size = 30, fill = 2) => opusPacket(0xf4, size, fill); // CELT FB 10 ms
  const p60 = (size = 50, fill = 3) => opusPacket(0x18, size, fill); // SILK NB 60 ms

  const simple = (frames: EncodedAudioFrame[]) => frames.map((f) => ({ pts: +f.pts.toFixed(9), duration: +f.duration.toFixed(9), size: f.data.length, first: f.data[1] }));

  it('handles Xiph, fixed and EBML lacing', () => {
    const xiph = [p20(300, 1), p10(255, 2), p60(10, 3)];
    const fixed = [p20(33, 4), p20(33, 5), p20(33, 6)];
    const ebml = [p10(300, 7), p10(20, 8), p10(700, 9), p20(5, 10)];
    const stream = concat(
      webmInit(),
      cluster(1000, [simpleBlock(1, 0, xiph, 'xiph'), simpleBlock(1, 100, fixed, 'fixed'), simpleBlock(1, 200, ebml, 'ebml')]),
    );
    for (const chunks of [[stream], randomChunks(stream, 5, 1, 7)]) {
      const out = feed(webm(), chunks);
      expect(out.errors).toEqual([]);
      expect(simple(out.frames)).toEqual([
        { pts: 1.0, duration: 0.02, size: 300, first: 1 },
        { pts: 1.02, duration: 0.01, size: 255, first: 2 },
        { pts: 1.03, duration: 0.06, size: 10, first: 3 },
        { pts: 1.1, duration: 0.02, size: 33, first: 4 },
        { pts: 1.12, duration: 0.02, size: 33, first: 5 },
        { pts: 1.14, duration: 0.02, size: 33, first: 6 },
        { pts: 1.2, duration: 0.01, size: 300, first: 7 },
        { pts: 1.21, duration: 0.01, size: 20, first: 8 },
        { pts: 1.22, duration: 0.01, size: 700, first: 9 },
        { pts: 1.23, duration: 0.02, size: 5, first: 10 },
      ]);
    }
  });

  it('reads BlockGroups, preferring the TOC duration over BlockDuration', () => {
    const undeterminable = opusPacket(0xfb, 20, 4, 0); // code 3 with M = 0
    const stream = concat(webmInit(), cluster(0, [blockGroup(1, 0, p20(), 25), blockGroup(1, 20, undeterminable, 15), blockGroup(1, 40, p10())]));
    expect(simple(feed(webm(), [stream]).frames)).toEqual([
      { pts: 0, duration: 0.02, size: 40, first: 1 },
      { pts: 0.02, duration: 0.015, size: 20, first: 0 },
      { pts: 0.04, duration: 0.01, size: 30, first: 2 },
    ]);
  });

  it('applies TimecodeScale and signed relative timecodes', () => {
    const stream = concat(webmInit({ timecodeScale: 100_000 }), cluster(12345, [simpleBlock(1, -45, [p20()]), simpleBlock(1, 32767, [p20()]), simpleBlock(1, -32768, [p20()])]));
    expect(feed(webm(), [stream]).frames.map((f) => +f.pts.toFixed(9))).toEqual([1.23, 4.5112, -2.0423]);
  });

  it('ends unknown-size Clusters at the next level-1 element and ignores Segment sizes', () => {
    const stream = concat(
      webmInit({ unknownSegment: false }), // known-size Segment that does not cover the clusters
      cluster(0, [simpleBlock(1, 0, [p20()])], true),
      cluster(20, [simpleBlock(1, 0, [p20()])], true),
      el(ID.Cues, el(0xbb, uintEl(0xb3, 0))),
      cluster(40, [simpleBlock(1, 0, [p20()]), el(ID.Void, [0, 0])], true),
      el(ID.Tags, el(0x7373)),
      el(ID.Void, [1, 2, 3]),
      cluster(60, [simpleBlock(1, 0, [p20()])], true),
      el(ID.Chapters, el(0x45b9)),
      cluster(80, [simpleBlock(1, 0, [p20()])]),
    );
    for (const chunks of [[stream], randomChunks(stream, 9, 1, 5)]) {
      const out = feed(webm(), chunks);
      expect(out.errors).toEqual([]);
      expect(out.frames.map((f) => +f.pts.toFixed(9))).toEqual([0, 0.02, 0.04, 0.06, 0.08]);
    }
  });

  it('only returns blocks of the first audio track', () => {
    const tracks = [trackEntry({ number: 1, type: 1, codecId: 'V_VP9', codecPrivate: null }), trackEntry({ number: 2 }), trackEntry({ number: 3, codecPrivate: opusHead(1) })];
    const stream = concat(webmInit({ tracks }), cluster(0, [simpleBlock(1, 0, [p20(40, 1)]), simpleBlock(2, 0, [p20(40, 2)]), simpleBlock(3, 0, [p20(40, 3)]), simpleBlock(129, 0, [p20(40, 4)])]));
    const out = feed(webm(), [stream]);
    expect(out.configs[0]!.channels).toBe(2);
    expect(out.frames.map((f) => f.data[1])).toEqual([2]);
  });

  it('re-emits the config for a new initialization segment, keeping event order', () => {
    const stream = concat(
      webmInit(),
      cluster(0, [simpleBlock(1, 0, [p20()])]),
      webmInit({ tracks: [trackEntry({ number: 5, channels: 1, codecDelayNs: 3_500_000 })], timecodeScale: 500_000 }),
      cluster(100, [simpleBlock(5, 0, [p20()])]),
    );
    const out = feed(webm(), [stream]);
    expect(out.order).toEqual(['config', 'frames', 'config', 'frames']);
    expect(out.configs.map((c) => [c.channels, c.codecDelaySamples])).toEqual([[2, 312], [1, 168]]);
    expect(out.frames.map((f) => f.pts)).toEqual([0, 0.05]);
  });

  it('accepts a track without CodecPrivate and falls back to the OpusHead pre-skip', () => {
    const noPrivate = feed(webm(), [webmInit({ tracks: [trackEntry({ codecPrivate: null, channels: 1, codecDelayNs: 6_500_000 })] })]);
    expect(noPrivate.configs).toEqual([{ codec: 'opus', sampleRate: 48000, channels: 1, codecDelaySamples: 312 }]);
    const noDelay = feed(webm(), [webmInit({ tracks: [trackEntry({ codecPrivate: opusHead(2, 120) })] })]);
    expect(noDelay.configs[0]!.codecDelaySamples).toBe(120);
  });

  it('reports unusable initialization segments', () => {
    const cases: [Uint8Array, string][] = [
      [webmInit({ tracks: [trackEntry({ encrypted: true })] }), 'WebM: encrypted or compressed audio tracks are not supported'],
      [webmInit({ tracks: [trackEntry({ type: 1, codecId: 'V_VP9' })] }), 'WebM: no audio track'],
      [webmInit({ tracks: [trackEntry({ codecId: 'A_AAC' })] }), 'WebM: codec A_AAC is not supported'],
      [webmInit({ tracks: [trackEntry({ codecPrivate: Uint8Array.of(1, 2, 3) })] }), 'WebM: invalid OpusHead in CodecPrivate'],
    ];
    for (const [init, message] of cases) {
      const out = feed(webm(), [init, cluster(0, [simpleBlock(1, 0, [p20()])])]);
      expect(out.errors).toEqual([message]);
      expect(out.frames).toEqual([]);
    }
  });

  it('reports media data that arrives before any initialization segment, then recovers', () => {
    const out = feed(webm(), [cluster(0, [simpleBlock(1, 0, [p20()]), simpleBlock(1, 20, [p20()])]), webmInit(), cluster(40, [simpleBlock(1, 0, [p20()])])]);
    expect(out.errors).toEqual(['WebM: media data before an initialization segment']);
    expect(out.frames.map((f) => f.pts)).toEqual([0.04]);
  });
});

describe('WebM demuxer robustness', () => {
  let bytes: Uint8Array;
  let truth: ProbeResult;
  beforeAll(() => {
    bytes = new Uint8Array(readFileSync(fixture('mix.webm')));
    truth = probe(fixture('mix.webm'));
  });

  /** Absolute positions of the Cluster IDs in the file. */
  const clusterStarts = () => {
    const starts: number[] = [];
    for (let i = 0; i + 4 <= bytes.length; i++) {
      if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) starts.push(i);
    }
    return starts;
  };

  it('resynchronises on the next Cluster after a corrupt element header', () => {
    const corrupt = bytes.slice();
    const victim = truth.packets[100]!; // pos points at the block payload; its 2-byte size field precedes it
    corrupt[victim.pos - 2] = 0x00;
    const nextCluster = clusterStarts().find((c) => c > victim.pos)!;
    for (const chunks of [[corrupt.slice()], randomChunks(corrupt, 1, 1, 20000)]) {
      const out = feed(webm(), chunks);
      expect(out.errors).toEqual(['WebM: invalid EBML element header']);
      const expected = [...truth.packets.slice(0, 100), ...truth.packets.filter((p) => p.pos > nextCluster)];
      expectFramesMatch(out.frames, expected, truth.timeBase, CODEC_DELAY_TICKS);
    }
  });

  it('resynchronises after an element that overflows its Cluster', () => {
    const corrupt = bytes.slice();
    const nextCluster = clusterStarts()[2]!;
    const index = truth.packets.findIndex((p) => p.pos > nextCluster) - 1; // last block of the previous Cluster
    corrupt[truth.packets[index]!.pos - 2] = 0x5f; // 2-byte size 0x1fxx: beyond the Cluster end
    const out = feed(webm(), randomChunks(corrupt, 2, 1, 20000));
    expect(out.errors).toEqual(['WebM: element overflows its Cluster']);
    expectFramesMatch(out.frames, [...truth.packets.slice(0, index), ...truth.packets.slice(index + 1)], truth.timeBase, CODEC_DELAY_TICKS);
  });

  it('skips leading garbage up to the EBML header', () => {
    const garbage = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7919) & 0xff);
    const out = feed(webm(), randomChunks(concat(garbage, bytes), 3, 1, 20000));
    expect(out.errors.length).toBe(1);
    expect(out.configs).toHaveLength(1);
    expectFramesMatch(out.frames, truth.packets, truth.timeBase, CODEC_DELAY_TICKS);
  });

  it('reports blocks that cannot be parsed without losing the Cluster', () => {
    const stream = concat(
      webmInit(),
      cluster(0, [
        el(ID.SimpleBlock, [0x81, 0x00]), // truncated block header
        el(ID.SimpleBlock, [0x81, 0x00, 0x14, 0x82, 5, 200, 1, 2]), // Xiph lacing larger than the block
        simpleBlock(1, 40, [opusPacket(0xfc, 10)]),
      ]),
      cluster(60, [simpleBlock(1, 0, [opusPacket(0xfc, 10)])]),
      el(ID.Cluster, el(ID.SimpleBlock, [0x81, 0, 0, 0x80, 0xfc])), // block before the Cluster Timecode
    );
    const out = feed(webm(), [stream]);
    expect(out.errors).toEqual(['WebM: truncated block header', 'WebM: block before the Cluster Timecode']);
    expect(out.frames.map((f) => f.pts)).toEqual([0.04, 0.06]);
  });

  it('rejects unknown-size and oversized elements inside a Cluster', () => {
    const a = feed(webm(), [concat(webmInit(), elUnknown(ID.Cluster, uintEl(ID.Timecode, 0), elUnknown(ID.SimpleBlock, [0x81, 0, 0, 0x80, 0xfc])), cluster(20, [simpleBlock(1, 0, [opusPacket(0xfc, 10)])]))]);
    expect(a.errors).toEqual(['WebM: unknown-size element inside a Cluster']);
    expect(a.frames.map((f) => f.pts)).toEqual([0.02]);
    const huge = Uint8Array.from([0xa3, 0x18, 0x00, 0x00, 0x00, 0x81, 0x00, 0x00]); // 2^27-byte SimpleBlock
    const b = feed(webm(), [concat(webmInit(), elUnknown(ID.Cluster, uintEl(ID.Timecode, 0), huge)), cluster(20, [simpleBlock(1, 0, [opusPacket(0xfc, 10)])])]);
    expect(b.errors).toEqual(['WebM: block too large']);
    expect(b.frames.map((f) => f.pts)).toEqual([0.02]);
  });

  it('drops a partial element on reset() and continues at the next boundary', () => {
    const starts = clusterStarts();
    const cut = starts[1]! + 777;
    const demuxer = webm();
    const first = feed(demuxer, [bytes.slice(0, cut)]);
    demuxer.reset();
    const second = feed(demuxer, randomChunks(bytes.subarray(starts[3]!), 4, 1, 20000));
    expect([...first.errors, ...second.errors]).toEqual([]);
    // Every block completed before the cut is returned; the one straddling it is dropped.
    const complete = truth.packets.filter((p) => p.pos + 4 + p.size <= cut); // pos: block payload (4-byte block header)
    expectFramesMatch(first.frames, complete, truth.timeBase, CODEC_DELAY_TICKS);
    expectFramesMatch(second.frames, truth.packets.filter((p) => p.pos > starts[3]!), truth.timeBase, CODEC_DELAY_TICKS);
  });

  it('never throws on random or mutated input', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const demuxer = webm();
      const mutated = bytes.slice();
      const next = rng(seed);
      // Mutate media data only (past the init segment), so that some frames must survive.
      for (let k = 0; k < 50; k++) mutated[600 + Math.floor(next() * (mutated.length - 600))] = Math.floor(next() * 256);
      const out = feed(demuxer, randomChunks(mutated, seed, 1, 30000));
      expect(out.frames.length).toBeGreaterThan(500);
      const noise = Uint8Array.from({ length: 200_000 }, (_, i) => (Math.imul(i + seed, 2654435761) >>> 13) & 0xff);
      expect(() => feed(demuxer, randomChunks(noise, seed, 1, 5000))).not.toThrow();
      demuxer.reset();
      expect(() => demuxer.push(bytes.subarray(0, 0))).not.toThrow();
    }
  });
});
