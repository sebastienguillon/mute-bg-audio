import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDemuxer } from '../../src/lib/demux';
import { parseAudioSpecificConfig } from '../../src/lib/demux/mp4';
import { opusPacketSamples } from '../../src/lib/demux/opus';
import type { Demuxer, EncodedAudioFrame } from '../../src/lib/demux/types';
import {
  audioSampleEntry, be, bits, box, dOps, esds, fullBox, mp4Fragment, mp4Init, trak, type TrafSpec,
} from './helpers/demux-builders';
import { concat, feed, fixture, makeDash, md5, probe, randomChunks, rng, type ProbePacket, type ProbeResult } from './helpers/demux-media';

const mp4 = (): Demuxer => createDemuxer('audio/mp4; codecs="mp4a.40.2"')!;

function expectFramesMatch(frames: EncodedAudioFrame[], packets: ProbePacket[], timeBase: number): void {
  expect(frames.length).toBe(packets.length);
  const mismatches: string[] = [];
  frames.forEach((f, k) => {
    const p = packets[k]!;
    const pts = Math.round(f.pts / timeBase);
    const duration = Math.round(f.duration / timeBase);
    if (pts !== p.pts || f.data.length !== p.size || md5(f.data) !== p.md5 || (p.duration !== null && duration !== p.duration)) {
      mismatches.push(`#${k}: pts ${pts} vs ${p.pts}, size ${f.data.length} vs ${p.size}, duration ${duration} vs ${p.duration}`);
    }
  });
  expect(mismatches.slice(0, 5)).toEqual([]);
}

/** Positions of the top-level boxes of a file. */
function topLevelBoxes(bytes: Uint8Array): { type: string; pos: number; size: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: { type: string; pos: number; size: number }[] = [];
  for (let p = 0; p + 8 <= bytes.length; ) {
    const size = view.getUint32(p);
    boxes.push({ type: String.fromCharCode(...bytes.subarray(p + 4, p + 8)), pos: p, size });
    p += size;
  }
  return boxes;
}

/**
 * ffprobe ground truth with the last packet's duration dropped: ffprobe reports the nominal frame
 * duration there, while the trun signals the trimmed duration of the stream's final frame.
 */
function probeMp4(path: string): ProbeResult {
  const truth = probe(path);
  truth.packets[truth.packets.length - 1]!.duration = null;
  return truth;
}

describe('MP4 demuxer on mix-aac.mp4 (ffprobe ground truth)', () => {
  let bytes: Uint8Array;
  let truth: ProbeResult;
  beforeAll(() => {
    bytes = new Uint8Array(readFileSync(fixture('mix-aac.mp4')));
    truth = probeMp4(fixture('mix-aac.mp4'));
  });

  it('parses the file in one push', () => {
    const out = feed(mp4(), [bytes.slice()]);
    expect(out.errors).toEqual([]);
    expect(out.order).toEqual(['config', 'frames']);
    expect(out.configs).toHaveLength(1);
    const config = out.configs[0]!;
    expect(config).toMatchObject({ codec: 'mp4a.40.2', sampleRate: truth.sampleRate, channels: 2 });
    expect(config.codecDelaySamples).toBeUndefined();
    expect(md5(config.description!)).toBe(truth.extradataMd5);
    expectFramesMatch(out.frames, truth.packets, truth.timeBase);
    for (const f of out.frames.slice(0, -1)) expect(f.duration).toBe(1024 / 48000);
    expect(out.frames.at(-1)!.duration).toBe(256 / 48000); // stream duration_ts 1441024 = last pts + 256
  });

  for (const seed of [1, 2, 3, 4, 5]) {
    it(`parses random chunks of 1..20000 bytes (seed ${seed})`, () => {
      const out = feed(mp4(), randomChunks(bytes, seed, 1, 20000));
      expect(out.errors).toEqual([]);
      expect(out.configs).toHaveLength(1);
      expectFramesMatch(out.frames, truth.packets, truth.timeBase);
    });
  }

  it('parses tiny chunks of 1..16 bytes', () => {
    const out = feed(mp4(), randomChunks(bytes, 42, 1, 16));
    expect(out.errors).toEqual([]);
    expectFramesMatch(out.frames, truth.packets, truth.timeBase);
  });

  it('keeps only a bounded unparsed tail', () => {
    const demuxer = mp4();
    const queue = (demuxer as unknown as { queue: { start: number; end: number } }).queue;
    let maxRetained = 0;
    for (const chunk of randomChunks(bytes, 7, 1, 20000)) {
      demuxer.push(chunk);
      maxRetained = Math.max(maxRetained, queue.end - queue.start);
    }
    expect(maxRetained).toBeLessThan(2000); // a partial moof (476 bytes) or AAC frame
  });
});

describe('MP4 demuxer on DASH segments (appendBuffer-like pushes)', () => {
  const dashCases = [
    { name: 'mp4-aac', args: ['-c:a', 'aac', '-b:a', '128k'], codec: 'mp4a.40.2', delay: undefined },
    { name: 'mp4-opus', args: ['-c:a', 'libopus', '-b:a', '128k'], codec: 'opus', delay: 312 },
  ];
  for (const c of dashCases) {
    describe(c.name, () => {
      let dash: ReturnType<typeof makeDash>;
      let truth: ProbeResult;
      let ranges: [number, number][];
      const packetsOf = (k: number) => truth.packets.filter((p) => p.pos >= ranges[k]![0] && p.pos < ranges[k]![1]);

      beforeAll(() => {
        dash = makeDash(c.name, 'mp4', c.args);
        truth = probeMp4(dash.concatenated);
        let o = dash.init.length;
        ranges = dash.segments.map((s) => {
          const r: [number, number] = [o, o + s.length];
          o += s.length;
          return r;
        });
      });

      it('demuxes init + styp/sidx/moof/mdat media segments', () => {
        expect(dash.segments.length).toBeGreaterThan(5);
        const out = feed(mp4(), [dash.init.slice(), ...dash.segments.map((s) => s.slice())]);
        expect(out.errors).toEqual([]);
        expect(out.configs).toHaveLength(1);
        const config = out.configs[0]!;
        expect(config).toMatchObject({ codec: c.codec, sampleRate: 48000, channels: 2 });
        expect(config.codecDelaySamples).toBe(c.delay);
        expect(md5(config.description!)).toBe(truth.extradataMd5);
        expectFramesMatch(out.frames, truth.packets, truth.timeBase);
        if (c.codec === 'opus') {
          expect(config.description!.length).toBe(19);
          // Durations come from the trun; all but the (trimmed) last one match the Opus TOC.
          for (const f of out.frames.slice(0, -1)) expect(f.duration).toBeCloseTo(opusPacketSamples(f.data) / 48000, 12);
          expect(out.frames.at(-1)!.duration).toBeLessThan(opusPacketSamples(out.frames.at(-1)!.data) / 48000);
        }
      });

      it('recovers the right timestamps after reset() in the middle of a segment (seek)', () => {
        const demuxer = mp4();
        const seg1 = dash.segments[1]!;
        const before = feed(demuxer, [dash.init.slice(), dash.segments[0]!.slice(), seg1.slice(0, seg1.length >> 1)]);
        demuxer.reset();
        const after = feed(demuxer, [...randomChunks(dash.segments[4]!, 3, 1, 5000), dash.segments[5]!.slice()]);
        expect([...before.errors, ...after.errors]).toEqual([]);
        const partial = before.frames.length - packetsOf(0).length;
        expect(partial).toBeGreaterThan(0);
        expect(partial).toBeLessThan(packetsOf(1).length);
        expectFramesMatch(before.frames, [...packetsOf(0), ...packetsOf(1).slice(0, partial)], truth.timeBase);
        expectFramesMatch(after.frames, [...packetsOf(4), ...packetsOf(5)], truth.timeBase);
        expect(after.frames[0]!.pts).toBeGreaterThan(7.9);
      });

      it('re-emits the config when the init segment is appended again', () => {
        const out = feed(mp4(), [dash.init.slice(), dash.segments[0]!.slice(), dash.init.slice(), dash.segments[1]!.slice()]);
        expect(out.errors).toEqual([]);
        expect(out.order).toEqual(['config', 'frames', 'config', 'frames']);
        expectFramesMatch(out.frames, [...packetsOf(0), ...packetsOf(1)], truth.timeBase);
      });
    });
  }
});

describe('MP4 demuxer on synthetic streams', () => {
  const frame = (n: number, size = 20) => new Uint8Array(size).fill(n);
  const audioInit = (trex: { duration?: number; size?: number } = {}) =>
    mp4Init([trak({ id: 1, handler: 'vide', sampleEntry: box('avc1') }), trak({ id: 2 })], [{ trackId: 1 }, { trackId: 2, ...trex }]);
  const summary = (frames: EncodedAudioFrame[]) =>
    frames.map((f) => ({ pts: Math.round(f.pts * 48000), duration: Math.round(f.duration * 48000), first: f.data[0], size: f.data.length }));

  it('handles several trafs and truns with chained data offsets and composition offsets', () => {
    const trafs: TrafSpec[] = [
      { trackId: 1, base: 'chain', runs: [{ samples: [{ data: frame(90, 100) }, { data: frame(91, 50) }] }] },
      {
        trackId: 2,
        base: 'chain',
        defaultDuration: 1024,
        tfdt: { version: 0, time: 48000 },
        runs: [
          { samples: [{ data: frame(1) }, { data: frame(2, 21) }], dataOffset: false, durations: false },
          { samples: [{ data: frame(3), duration: 960 }], dataOffset: false },
          { version: 1, compositionOffsets: true, samples: [{ data: frame(4), compositionOffset: -512 }, { data: frame(5), duration: 2048, compositionOffset: 256 }] },
        ],
      },
    ];
    const stream = concat(audioInit(), mp4Fragment(trafs));
    for (const chunks of [[stream], randomChunks(stream, 1, 1, 9)]) {
      const out = feed(mp4(), chunks);
      expect(out.errors).toEqual([]);
      expect(summary(out.frames)).toEqual([
        { pts: 48000, duration: 1024, first: 1, size: 20 },
        { pts: 49024, duration: 1024, first: 2, size: 21 },
        { pts: 50048, duration: 960, first: 3, size: 20 },
        { pts: 51008 - 512, duration: 1024, first: 4, size: 20 },
        { pts: 52032 + 256, duration: 2048, first: 5, size: 20 },
      ]);
    }
  });

  it('supports explicit base-data-offsets, trex defaults, moofs without tfdt and other top-level boxes', () => {
    const init = audioInit({ duration: 1024, size: 30 });
    const other = concat(box('styp', [0x6d, 0x73, 0x64, 0x68]), box('sidx', new Uint8Array(32)), box('emsg', new Uint8Array(40)), box('free'), box('prft', new Uint8Array(16)));
    const fixedSamples = (first: number) => ({ samples: [0, 1, 2].map((k) => ({ data: frame(first + k, 30) })), durations: false, sizes: false });
    const f1 = mp4Fragment([{ trackId: 2, base: 'explicit', tfdt: { version: 1, time: 2 ** 40 }, runs: [fixedSamples(1)] }], { streamPos: init.length + other.length });
    const f2 = mp4Fragment([{ trackId: 2, tfdt: null, runs: [fixedSamples(4)] }], { largeMdat: true });
    const stream = concat(init, other, f1, other, f2);
    for (const chunks of [[stream], randomChunks(stream, 2, 1, 13)]) {
      const out = feed(mp4(), chunks);
      expect(out.errors).toEqual([]);
      expect(out.frames.map((f) => [f.pts, f.duration, f.data[0], f.data.length])).toEqual(
        [0, 1, 2, 3, 4, 5].map((k) => [(2 ** 40 + 1024 * k) / 48000, 1024 / 48000, k + 1, 30]),
      );
    }
  });

  it('reads Opus (dOps), QuickTime sound entries with esds in wave, and MP3', () => {
    const configOf = (entry: Uint8Array) => {
      const out = feed(mp4(), [mp4Init([trak({ id: 1, sampleEntry: entry })], [{ trackId: 1 }])]);
      expect(out.errors).toEqual([]);
      return out.configs[0];
    };
    const opus6 = configOf(audioSampleEntry({ type: 'Opus', channels: 6, children: [dOps(6, 3840, 1)] }))!;
    expect(opus6).toMatchObject({ codec: 'opus', sampleRate: 48000, channels: 6, codecDelaySamples: 3840 });
    expect(Array.from(opus6.description!)).toEqual([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 6, 0x00, 0x0f, 0x80, 0xbb, 0, 0, 0, 0, 1, 1, 5, 0, 1, 2, 3, 4, 5]);
    const qt = configOf(audioSampleEntry({ version: 1, channels: 1, sampleRate: 44100, children: [box('wave', box('frma', [0x6d, 0x70, 0x34, 0x61]), esds(0x40, Uint8Array.of(0x12, 0x08)))] }));
    expect(qt).toEqual({ codec: 'mp4a.40.2', sampleRate: 44100, channels: 1, description: Uint8Array.of(0x12, 0x08) });
    const qt2 = configOf(audioSampleEntry({ version: 2, children: [esds(0x40, Uint8Array.of(0x11, 0x90))] }));
    expect(qt2?.codec).toBe('mp4a.40.2');
    expect(configOf(audioSampleEntry({ sampleRate: 44100, children: [esds(0x6b)] }))).toEqual({ codec: 'mp3', sampleRate: 44100, channels: 2 });
    expect(configOf(audioSampleEntry({ children: [esds(0x67, Uint8Array.of(0x11, 0x90))] }))?.codec).toBe('mp4a.40.2');
  });

  it('reports unusable initialization segments', () => {
    const cases: [Uint8Array, string][] = [
      [mp4Init([trak({ id: 1, handler: 'vide', sampleEntry: box('avc1') })], []), 'MP4: no audio track'],
      [mp4Init([trak({ id: 1, sampleEntry: audioSampleEntry({ type: 'enca', children: [] }) })], []), 'MP4: encrypted audio is not supported'],
      [mp4Init([trak({ id: 1, sampleEntry: audioSampleEntry({ type: 'ac-3', children: [] }) })], []), "MP4: unsupported sample entry 'ac-3'"],
      [mp4Init([trak({ id: 1, sampleEntry: audioSampleEntry({ children: [] }) })], []), 'MP4: missing or invalid esds box'],
      [mp4Init([trak({ id: 1, sampleEntry: audioSampleEntry({ children: [esds(0x40)] }) })], []), 'MP4: missing or invalid AudioSpecificConfig'],
      [mp4Init([trak({ id: 1, sampleEntry: audioSampleEntry({ children: [esds(0xa5, Uint8Array.of(0x11, 0x90))] }) })], []), 'MP4: unsupported objectTypeIndication 0xa5'],
      [mp4Init([trak({ id: 1, sampleEntry: audioSampleEntry({ type: 'Opus', children: [] }) })], []), 'MP4: missing or invalid dOps box'],
      [mp4Init([trak({ id: 1, timescale: 0 })], []), 'MP4: invalid mdhd timescale'],
    ];
    for (const [init, message] of cases) {
      const out = feed(mp4(), [init, mp4Fragment([{ trackId: 1, tfdt: { version: 0, time: 0 }, runs: [{ samples: [{ data: frame(1) }] }] }])]);
      expect(out.errors).toEqual([message, 'MP4: moof before a usable moov']);
      expect(out.frames).toEqual([]);
    }
  });

  it('reports samples whose data lies outside the following mdat', () => {
    const init = audioInit();
    const samples = { samples: [{ data: frame(1) }, { data: frame(2) }] };
    // base-data-offset 0 instead of the moof position: the data offsets point into the init segment.
    const wrongBase = mp4Fragment([{ trackId: 2, base: 'explicit', tfdt: { version: 0, time: 0 }, runs: [samples] }], { streamPos: 0 });
    const good = mp4Fragment([{ trackId: 2, tfdt: { version: 0, time: 2048 }, runs: [samples] }]);
    const out = feed(mp4(), [init, wrongBase, good]);
    expect(out.errors).toEqual(['MP4: sample data outside the mdat']);
    expect(out.frames.map((f) => [f.pts * 48000, f.data[0]])).toEqual([[2048, 1], [3072, 2]]);
  });

  it('reports a moof before any moov, then recovers', () => {
    const fragment = (time: number) => mp4Fragment([{ trackId: 2, tfdt: { version: 0, time }, runs: [{ samples: [{ data: frame(1) }] }] }]);
    const out = feed(mp4(), [fragment(0), audioInit(), fragment(4800)]);
    expect(out.errors).toEqual(['MP4: moof before a usable moov']);
    expect(out.frames.map((f) => f.pts)).toEqual([0.1]);
  });
});

describe('parseAudioSpecificConfig', () => {
  it('parses AAC-LC with and without a backward-compatible extension', () => {
    expect(parseAudioSpecificConfig(Uint8Array.of(0x11, 0x90))).toEqual({ codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 });
    expect(parseAudioSpecificConfig(Uint8Array.of(0x11, 0x90, 0x56, 0xe5, 0x00))).toEqual({ codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 });
    expect(parseAudioSpecificConfig(Uint8Array.of(0x12, 0x08))).toEqual({ codec: 'mp4a.40.2', sampleRate: 44100, channels: 1 });
  });

  it('handles explicit hierarchical SBR / PS signalling', () => {
    expect(parseAudioSpecificConfig(bits([5, 5], [6, 4], [2, 4], [3, 4], [2, 5], [0, 3]))).toEqual({ codec: 'mp4a.40.5', sampleRate: 48000, channels: 2 });
    expect(parseAudioSpecificConfig(bits([29, 5], [6, 4], [1, 4], [3, 4], [2, 5], [0, 3]))).toEqual({ codec: 'mp4a.40.29', sampleRate: 48000, channels: 2 });
    expect(parseAudioSpecificConfig(bits([5, 5], [8, 4], [1, 4], [5, 4], [2, 5], [0, 3]))).toEqual({ codec: 'mp4a.40.5', sampleRate: 32000, channels: 1 });
  });

  it('handles backward-compatible SBR / PS signalling', () => {
    const sbr = bits([2, 5], [6, 4], [2, 4], [0, 3], [0x2b7, 11], [5, 5], [1, 1], [3, 4]);
    expect(parseAudioSpecificConfig(sbr)).toEqual({ codec: 'mp4a.40.5', sampleRate: 48000, channels: 2 });
    const ps = bits([2, 5], [6, 4], [1, 4], [0, 3], [0x2b7, 11], [5, 5], [1, 1], [3, 4], [0x548, 11], [1, 1]);
    expect(parseAudioSpecificConfig(ps)).toEqual({ codec: 'mp4a.40.29', sampleRate: 48000, channels: 2 });
  });

  it('handles an explicit sampling frequency, escaped object types and channel configurations', () => {
    expect(parseAudioSpecificConfig(bits([2, 5], [15, 4], [44056, 24], [1, 4], [0, 3]))).toEqual({ codec: 'mp4a.40.2', sampleRate: 44056, channels: 1 });
    expect(parseAudioSpecificConfig(bits([31, 5], [10, 6], [3, 4], [2, 4]))).toEqual({ codec: 'mp4a.40.42', sampleRate: 48000, channels: 2 });
    expect(parseAudioSpecificConfig(bits([2, 5], [3, 4], [7, 4], [0, 3]))?.channels).toBe(8);
    // channelConfiguration 0: program_config_element with front SCE + CPE, back CPE and one LFE.
    const pce = bits(
      [2, 5], [3, 4], [0, 4], [0, 3],
      [0, 4], [1, 2], [3, 4], [2, 4], [0, 4], [1, 4], [1, 2], [0, 3], [0, 4], [0, 1], [0, 1], [0, 1],
      [0, 1], [0, 4], [1, 1], [1, 4], [1, 1], [2, 4], [0, 4],
      [0, 3], // byte_alignment
      [0, 8], // comment_field_bytes
    );
    expect(parseAudioSpecificConfig(pce)).toEqual({ codec: 'mp4a.40.2', sampleRate: 48000, channels: 6 });
  });

  it('rejects invalid configs', () => {
    expect(parseAudioSpecificConfig(new Uint8Array(0))).toBeNull();
    expect(parseAudioSpecificConfig(Uint8Array.of(0x11))).toBeNull();
    expect(parseAudioSpecificConfig(bits([2, 5], [13, 4], [2, 4], [0, 3]))).toBeNull(); // reserved frequency index
    expect(parseAudioSpecificConfig(bits([0, 5], [3, 4], [2, 4], [0, 3]))).toBeNull(); // null object type
    expect(parseAudioSpecificConfig(bits([5, 5], [6, 4], [2, 4]))).toBeNull(); // truncated hierarchical config
  });
});

describe('MP4 demuxer robustness', () => {
  let bytes: Uint8Array;
  let truth: ProbeResult;
  let moofs: number[];
  beforeAll(() => {
    bytes = new Uint8Array(readFileSync(fixture('mix-aac.mp4')));
    truth = probeMp4(fixture('mix-aac.mp4'));
    moofs = topLevelBoxes(bytes).filter((b) => b.type === 'moof').map((b) => b.pos);
  });
  const outside = (from: number, to: number) => truth.packets.filter((p) => p.pos < from || p.pos >= to);

  it('resynchronises on the next moof after a corrupt box size', () => {
    const corrupt = bytes.slice();
    corrupt.set(be(3, 4), moofs[2]!);
    for (const chunks of [[corrupt.slice()], randomChunks(corrupt, 1, 1, 20000)]) {
      const out = feed(mp4(), chunks);
      expect(out.errors).toEqual(['MP4: invalid box size']);
      expectFramesMatch(out.frames, outside(moofs[2]!, moofs[3]!), truth.timeBase);
    }
  });

  it('skips a moof with an impossible trun and keeps the next fragments', () => {
    const corrupt = bytes.slice();
    const trun = moofs[1]! + 8 + 16 + 8 + 28 + 20; // moof > mfhd, traf > tfhd, tfdt, trun
    expect(String.fromCharCode(...corrupt.subarray(trun + 4, trun + 8))).toBe('trun');
    corrupt.set(be(0x7fffffff, 4), trun + 12); // sample_count
    const out = feed(mp4(), randomChunks(corrupt, 2, 1, 20000));
    expect(out.errors).toEqual(['MP4: invalid moof']);
    expectFramesMatch(out.frames, outside(moofs[1]!, moofs[2]!), truth.timeBase);
  });

  it('reports sample data that never arrived', () => {
    const boxes = topLevelBoxes(bytes);
    const firstMdat = boxes.find((b) => b.type === 'mdat')!;
    const stream = concat(bytes.subarray(0, firstMdat.pos), bytes.subarray(firstMdat.pos + firstMdat.size));
    const out = feed(mp4(), [stream]);
    expect(out.errors).toEqual(['MP4: missing sample data']);
    expectFramesMatch(out.frames, outside(0, moofs[1]!), truth.timeBase);
  });

  it('drops a partial box on reset() and continues at the next boundary', () => {
    const demuxer = mp4();
    const cut = moofs[1]! + 20000; // inside the second mdat
    const first = feed(demuxer, [bytes.slice(0, cut)]);
    demuxer.reset();
    const middle = feed(demuxer, [bytes.slice(moofs[2]!, moofs[2]! + 100)]); // inside a moof
    demuxer.reset();
    const last = feed(demuxer, randomChunks(bytes.subarray(moofs[3]!), 4, 1, 20000));
    expect([...first.errors, ...middle.errors, ...last.errors]).toEqual([]);
    expect(middle.frames).toEqual([]);
    expectFramesMatch(first.frames, truth.packets.filter((p) => p.pos + p.size <= cut), truth.timeBase);
    expectFramesMatch(last.frames, truth.packets.filter((p) => p.pos > moofs[3]!), truth.timeBase);
  });

  it('never throws on random or mutated input', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const demuxer = mp4();
      const mutated = bytes.slice();
      const next = rng(seed);
      for (let k = 0; k < 50; k++) mutated[800 + Math.floor(next() * (mutated.length - 800))] = Math.floor(next() * 256);
      const out = feed(demuxer, randomChunks(mutated, seed, 1, 30000));
      expect(out.frames.length).toBeGreaterThan(500);
      const noise = Uint8Array.from({ length: 200_000 }, (_, i) => (Math.imul(i + seed, 2654435761) >>> 13) & 0xff);
      expect(() => feed(demuxer, randomChunks(noise, seed, 1, 5000))).not.toThrow();
      const boxNoise = concat(...Array.from({ length: 200 }, (_, k) => fullBox(['moof', 'traf', 'trun', 'moov', 'mdat'][k % 5]!, k & 1, k * 7919, new Uint8Array((k * 31) % 64).fill(k))));
      expect(() => feed(demuxer, randomChunks(boxNoise, seed, 1, 100))).not.toThrow();
    }
  });
});
