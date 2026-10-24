import { describe, expect, it } from 'vitest';
import { resampleRange } from '../../src/lib/dsp/resample';
import { PcmStore } from '../../src/lib/lookahead/pcm-store';
import { PcmWriter } from '../../src/lib/lookahead/pcm-writer';
import { StreamResampler } from '../../src/lib/lookahead/stream-resampler';
import { noise, readFixtureWav } from './helpers/lookahead-media';

/** Band-limited test signal at `rate`: a few sines plus low-passed noise. */
function signal(rate: number, n: number, seed: number): Float32Array {
  const raw = noise(n, 0.2, seed);
  const out = new Float32Array(n);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    lp += 0.2 * (raw[i]! - lp);
    out[i] = lp + 0.3 * Math.sin((2 * Math.PI * 440 * i) / rate) + 0.2 * Math.sin((2 * Math.PI * 3150.5 * i) / rate + 1);
  }
  return out;
}

function randomSplits(n: number, seed: number, min: number, max: number): number[] {
  let s = seed;
  const cuts = [0];
  while (cuts[cuts.length - 1]! < n) {
    s = (s * 1103515245 + 12345) >>> 0;
    cuts.push(Math.min(n, cuts[cuts.length - 1]! + min + (s % (max - min + 1))));
  }
  return cuts;
}

describe('StreamResampler', () => {
  for (const from of [44100, 22050, 96000]) {
    it(`${from} Hz → 48 kHz blocks concatenate to the single-pass result`, () => {
      const n = from * 3;
      const l = signal(from, n, 3);
      const r = signal(from, n, 4);
      const start = 12345; // arbitrary input index of the first sample
      const resampler = new StreamResampler(from, 48000);
      const out = new Map<number, [number, number]>();
      let firstOut: number | null = null;
      let next: number | null = null;
      const sink = (s: number, a: Float32Array, b: Float32Array) => {
        if (next !== null) expect(s).toBe(next);
        firstOut ??= s;
        for (let i = 0; i < a.length; i++) out.set(s + i, [a[i]!, b[i]!]);
        next = s + a.length;
      };
      const cuts = randomSplits(n, from, 1, 3000);
      for (let k = 0; k + 1 < cuts.length; k++) {
        resampler.push(start + cuts[k]!, l.subarray(cuts[k]!, cuts[k + 1]!), r.subarray(cuts[k]!, cuts[k + 1]!), sink);
      }
      expect(resampler.nextInput).toBe(start + n);
      resampler.finish(sink);
      const first = Math.ceil((start * 48000) / from);
      const last = Math.ceil(((start + n) * 48000) / from); // exclusive
      expect(firstOut).toBe(first);
      expect(next).toBe(last);
      const refL = resampleRange(l, start, from, 48000, first, last - first);
      const refR = resampleRange(r, start, from, 48000, first, last - first);
      let worst = 0;
      for (let j = first; j < last; j++) {
        const [a, b] = out.get(j)!;
        worst = Math.max(worst, Math.abs(a - refL[j - first]!), Math.abs(b - refR[j - first]!));
      }
      expect(worst).toBeLessThan(1e-6);
    });
  }

  it('finishes the previous run when a block does not continue it', () => {
    const resampler = new StreamResampler(44100, 48000);
    const blocks: [number, number][] = [];
    const sink = (s: number, a: Float32Array) => blocks.push([s, s + a.length]);
    resampler.push(0, new Float32Array(4410).fill(0.5), new Float32Array(4410).fill(0.5), sink);
    resampler.push(44100, new Float32Array(4410).fill(0.5), new Float32Array(4410).fill(0.5), sink);
    resampler.finish(sink);
    // Run 1: [0, 4800) (first part, then its tail); run 2 starts at 48000.
    expect(blocks[0]![0]).toBe(0);
    expect(blocks[1]).toEqual([blocks[0]![1], 4800]);
    expect(blocks[2]![0]).toBe(48000);
    expect(blocks[blocks.length - 1]![1]).toBe(52800);
  });
});

describe('PcmWriter', () => {
  it('keeps 48 kHz outputs with microsecond timestamps sample-contiguous', () => {
    const store = new PcmStore();
    const writer = new PcmWriter(store);
    const frame = 1024; // AAC frames: 21333.33 µs, timestamps are rounded
    for (let k = 0; k < 500; k++) {
      const data = new Float32Array(frame).fill(k);
      const timestamp = Math.round(((5 * 48000 + k * frame) / 48000) * 1e6) / 1e6;
      writer.write({ timestamp, sampleRate: 48000, channels: [data, data] });
    }
    expect(store.ranges()).toEqual([{ start: 5 * 48000, end: 5 * 48000 + 500 * frame }]);
    const l = new Float32Array(frame * 500);
    const r = new Float32Array(frame * 500);
    store.read(5 * 48000, l.length, l, r);
    for (let k = 0; k < 500; k++) expect(l[k * frame]).toBe(k);
  });

  it("downmixes like Web Audio's 'speakers' interpretation: mono, quad and 5.1; refuses other layouts", () => {
    const store = new PcmStore();
    const writer = new PcmWriter(store);
    const planes = (...values: number[]) => values.map((v) => new Float32Array(10).fill(v));
    expect(writer.write({ timestamp: 0, sampleRate: 48000, channels: planes(0.25) })).toBe(true);
    // Quad (L, R, SL, SR): ½(L + SL), ½(R + SR).
    expect(writer.write({ timestamp: 10 / 48000, sampleRate: 48000, channels: planes(0.1, 0.2, 0.3, 0.5) })).toBe(true);
    // 5.1 in Chrome's decoder order (L, R, C, LFE, SL, SR): L + √½(C + SL), R + √½(C + SR); LFE dropped.
    expect(writer.write({ timestamp: 20 / 48000, sampleRate: 48000, channels: planes(0.1, 0.2, 0.3, 0.9, 0.05, 0.15) })).toBe(true);
    // Layouts without a 'speakers' downmix are not stored (the caller reports them).
    for (const n of [3, 5, 8]) {
      expect(writer.write({ timestamp: 30 / 48000, sampleRate: 48000, channels: planes(...new Array<number>(n).fill(0.5)) })).toBe(false);
    }
    const l = new Float32Array(40);
    const r = new Float32Array(40);
    expect(store.read(0, 40, l, r)).toBe(30);
    expect([l[0], r[0]]).toEqual([0.25, 0.25]);
    expect(l[15]).toBeCloseTo(0.2, 6);
    expect(r[15]).toBeCloseTo(0.35, 6);
    expect(l[25]).toBeCloseTo(0.1 + Math.SQRT1_2 * 0.35, 6);
    expect(r[25]).toBeCloseTo(0.2 + Math.SQRT1_2 * 0.45, 6);
    expect(l[35]).toBe(0);
  });

  it('downmixes 5.1 output of a 44.1 kHz decoder before resampling', () => {
    const store = new PcmStore();
    const writer = new PcmWriter(store);
    const n = 4410;
    const c = (v: number) => new Float32Array(n).fill(v);
    writer.write({ timestamp: 1, sampleRate: 44100, channels: [c(0.1), c(0.2), c(0.3), c(1), c(0.1), c(0.2)] });
    writer.finish();
    const l = new Float32Array(2000);
    const r = new Float32Array(2000);
    store.read(48000 + 1000, 2000, l, r);
    expect(l[1000]).toBeCloseTo(0.1 + Math.SQRT1_2 * 0.4, 4);
    expect(r[1000]).toBeCloseTo(0.2 + Math.SQRT1_2 * 0.5, 4);
  });

  it('writes only inside its clip range', () => {
    const store = new PcmStore();
    const writer = new PcmWriter(store, { clip: { start: 100, end: 250 } });
    for (let k = 0; k < 4; k++) writer.write({ timestamp: (k * 96) / 48000, sampleRate: 48000, channels: [new Float32Array(96).fill(k + 1)] });
    expect(store.ranges()).toEqual([{ start: 100, end: 250 }]);
    const l = new Float32Array(150);
    store.read(100, 150, l, new Float32Array(150));
    expect([l[0], l[91], l[92], l[149]]).toEqual([2, 2, 3, 3]);
  });

  it("keeps settled audio under a decoder's unsettled start and pre-roll, and still stores new audio there", () => {
    const tone = (gain: number, from: number, n: number) => Float32Array.from({ length: n }, (_, i) => gain * Math.sin((from + i) / 7));
    /** A decoder whose first 1600 samples are off (unsettled), writing tone(gain) over [0, 9600) in 960-sample outputs. */
    const decode = (writer: PcmWriter, gain: number) => {
      for (let k = 0; k < 10; k++) {
        const l = tone(gain, 960 * k, 960).map((v, i) => (960 * k + i < 1600 ? 0.4 * v : v));
        writer.write({ timestamp: (960 * k) / 48000, sampleRate: 48000, channels: [l, l] });
      }
      writer.finish();
    };
    const read = (store: PcmStore) => {
      const l = new Float32Array(9600);
      store.read(0, 9600, l, new Float32Array(9600));
      return l;
    };
    const store = new PcmStore();
    store.write(0, tone(0.5, 0, 9600), tone(0.5, 0, 9600));
    const settled = read(store);
    const changes: [number, number][] = [];
    const onChange = (start: number, end: number) => changes.push([start, end]);
    // The same audio again from a decoder with pre-roll (output before 1920 is of frames stored before)…
    decode(new PcmWriter(store, { onChange, settledFrom: 3840, replaceFrom: 1920 }), 0.5);
    // …and from one without: the stored audio stays, nothing is reported.
    decode(new PcmWriter(store, { onChange, settledFrom: 3840, replaceFrom: 0 }), 0.5);
    expect(changes).toEqual([]);
    expect(read(store)).toEqual(settled);
    expect(store.provisionalRanges()).toEqual([]);
    // Other audio, without pre-roll: the settled output differs, so all of it is new audio.
    decode(new PcmWriter(store, { onChange, settledFrom: 3840, replaceFrom: 0 }), 0.1);
    expect(changes[0]![0]).toBe(0);
    expect(changes.every(([start], i) => i === 0 || start === changes[i - 1]![1])).toBe(true);
    expect(changes[changes.length - 1]![1]).toBe(9600);
    expect(read(store)[100]).toBeCloseTo(0.4 * tone(0.1, 100, 1)[0]!, 6);
    expect(read(store)[5000]).toBeCloseTo(tone(0.1, 5000, 1)[0]!, 6);

    // Into nothing stored: the unsettled start is kept as provisional, and settled audio replaces it silently.
    const empty = new PcmStore();
    decode(new PcmWriter(empty, { onChange, settledFrom: 3840, replaceFrom: 0 }), 0.5);
    expect(empty.ranges()).toEqual([{ start: 0, end: 9600 }]);
    expect(empty.provisionalRanges()).toEqual([{ start: 0, end: 3840 }]);
    changes.length = 0;
    const l = tone(0.5, 0, 9600);
    new PcmWriter(empty, { onChange }).write({ timestamp: 0, sampleRate: 48000, channels: [l, l] });
    expect(changes).toEqual([]);
    expect(empty.provisionalRanges()).toEqual([]);
    expect(read(empty)).toEqual(settled);
  });

  it('reports writes that replace stored audio with different audio, not identical rewrites', () => {
    const store = new PcmStore();
    const changes: [number, number][] = [];
    const writer = new PcmWriter(store, { onChange: (start, end) => changes.push([start, end]) });
    const tone = (gain: number) => {
      const out = new Float32Array(960);
      for (let i = 0; i < out.length; i++) out[i] = gain * Math.sin(i / 7);
      return out;
    };
    writer.write({ timestamp: 0, sampleRate: 48000, channels: [tone(0.5), tone(0.5)] });
    expect(changes).toEqual([]);
    // Same audio again (an overlapping re-append of identical data).
    new PcmWriter(store, { onChange: (start, end) => changes.push([start, end]) }).write({ timestamp: 0, sampleRate: 48000, channels: [tone(0.5), tone(0.5)] });
    expect(changes).toEqual([]);
    // Different audio over the second half.
    new PcmWriter(store, { onChange: (start, end) => changes.push([start, end]) }).write({
      timestamp: 480 / 48000,
      sampleRate: 48000,
      channels: [tone(0.1), tone(0.1)],
    });
    expect(changes).toEqual([[480, 1440]]);
  });

  it('resamples 44.1 kHz decoder output with exact seams', () => {
    const n = 44100 * 4;
    const l = signal(44100, n, 11);
    const r = signal(44100, n, 12);
    const store = new PcmStore();
    const writer = new PcmWriter(store);
    const t0 = 3.5; // seconds
    for (let k = 0; k * 1024 < n; k++) {
      const a = k * 1024;
      const b = Math.min(n, a + 1024);
      const timestamp = Math.round((t0 + a / 44100) * 1e6) / 1e6;
      writer.write({ timestamp, sampleRate: 44100, channels: [l.slice(a, b), r.slice(a, b)] });
    }
    writer.finish();
    const start = Math.round(t0 * 44100);
    const first = Math.ceil((start * 48000) / 44100);
    const last = Math.ceil(((start + n) * 48000) / 44100);
    expect(store.ranges()).toEqual([{ start: first, end: last }]);
    const outL = new Float32Array(last - first);
    const outR = new Float32Array(last - first);
    store.read(first, last - first, outL, outR);
    const refL = resampleRange(l, start, 44100, 48000, first, last - first);
    const refR = resampleRange(r, start, 44100, 48000, first, last - first);
    let worst = 0;
    for (let i = 0; i < outL.length; i++) worst = Math.max(worst, Math.abs(outL[i]! - refL[i]!), Math.abs(outR[i]! - refR[i]!));
    expect(worst).toBeLessThan(1e-6);
  });

  it('stores 44.1 kHz decoder output of mix.wav at the media indices of the 48 kHz original', () => {
    const mix = readFixtureWav('mix.wav');
    const n48 = 10 * 48000;
    const n44 = 10 * 44100;
    // What an AAC decoder at 44.1 kHz would output for media time [5 s, 15 s).
    const src = [0, 1].map((c) => resampleRange(mix.channels[c]!, 0, 48000, 44100, 5 * 44100, n44));
    const store = new PcmStore();
    const writer = new PcmWriter(store);
    for (let a = 0; a < n44; a += 1024) {
      const b = Math.min(n44, a + 1024);
      writer.write({ timestamp: Math.round((5 + a / 44100) * 1e6) / 1e6, sampleRate: 44100, channels: src.map((c) => c.slice(a, b)) });
    }
    writer.finish();
    const l = new Float32Array(n48);
    const r = new Float32Array(n48);
    store.read(5 * 48000, n48, l, r);
    // Away from the run edges the round trip only loses the band above 19.8 kHz; any time offset
    // would make a shifted comparison match better.
    const snrAt = (lag: number) => {
      let signal = 0;
      let error = 0;
      for (let i = 4800; i < n48 - 4800; i++) {
        const ref = mix.channels[0]![5 * 48000 + i + lag]!;
        signal += ref * ref;
        error += (l[i]! - ref) ** 2;
      }
      return 10 * Math.log10(signal / error);
    };
    const snr = snrAt(0);
    console.log(`44.1 kHz decode path: SNR ${snr.toFixed(1)} dB against the 48 kHz original (lag ±1: ${snrAt(-1).toFixed(1)}, ${snrAt(1).toFixed(1)} dB)`);
    expect(snr).toBeGreaterThan(30);
    expect(snr).toBeGreaterThan(snrAt(-1) + 10);
    expect(snr).toBeGreaterThan(snrAt(1) + 10);
  });
});
