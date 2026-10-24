import { describe, expect, it } from 'vitest';
import { MDX_MODELS, type MdxBackend } from '../../src/lib/mdx/mdx';
import { MdxStream } from '../../src/lib/mdx/mdx-stream';
import { bandLimit, fadeEnds, readFixture, sliceZeroFilled } from './helpers/dsp-audio';

const cfg = MDX_MODELS.Kim_Vocal_2;
const RATE = 48000;
const identity: MdxBackend = { run: async (input) => input };

/** 60 s of mix.wav looped, band-limited to 100 Hz..16 kHz (inside the MDX band) and faded in/out. */
function testSignal(): [Float32Array, Float32Array] {
  const wav = readFixture('mix.wav');
  const n = 60 * RATE;
  return wav.channels.slice(0, 2).map((ch) => {
    const looped = new Float32Array(n);
    for (let i = 0; i < n; i++) looped[i] = ch[i % ch.length]!;
    return fadeEnds(bandLimit(looped, RATE, 100, 16000), RATE / 10);
  }) as [Float32Array, Float32Array];
}

interface RunResult {
  left: Float32Array;
  right: Float32Array;
  chunks: number;
  ms: number;
}

/** Feeds the stream until `end` is finalized, checking that blocks are contiguous. */
async function runStream(stream: MdxStream, left: Float32Array, right: Float32Array, origin: number, end: number): Promise<RunResult> {
  stream.reset(origin);
  const outL = new Float32Array(end);
  const outR = new Float32Array(end);
  let expected = origin;
  let chunks = 0;
  const t = performance.now();
  while (stream.finalizedEnd < end) {
    const range = stream.nextInputRange();
    const block = await stream.processNext(sliceZeroFilled(left, range.start, range.end), sliceZeroFilled(right, range.start, range.end));
    chunks++;
    if (!block) continue;
    expect(block.start).toBe(expected);
    expect(block.vocalsR.length).toBe(block.vocalsL.length);
    const len = Math.min(block.vocalsL.length, end - block.start);
    outL.set(block.vocalsL.subarray(0, len), block.start);
    outR.set(block.vocalsR.subarray(0, len), block.start);
    expected += block.vocalsL.length;
    expect(stream.finalizedEnd).toBe(expected);
  }
  return { left: outL, right: outR, chunks, ms: performance.now() - t };
}

/** Worst 10 ms block error relative to the RMS of the whole reference, in dB. */
function worstBlockErrorDb(out: Float32Array, ref: Float32Array, from: number, to: number): number {
  let refEnergy = 0;
  for (let i = from; i < to; i++) refEnergy += ref[i]! * ref[i]!;
  const refRms = Math.sqrt(refEnergy / (to - from));
  let worst = 0;
  for (let b = from; b < to; b += 480) {
    const e = Math.min(to, b + 480);
    let err = 0;
    for (let i = b; i < e; i++) err += (out[i]! - ref[i]!) ** 2;
    worst = Math.max(worst, Math.sqrt(err / (e - b)));
  }
  return 20 * Math.log10(worst / refRms);
}

describe('MdxStream', () => {
  const [left, right] = testSignal();

  it('needs the trim context before the origin and the resampler margins', () => {
    const stream = new MdxStream(cfg, identity);
    stream.reset(10000);
    const range = stream.nextInputRange();
    // Chunk 0 covers 44.1 kHz samples [-3840, 257280) around the origin.
    expect(range.start).toBeLessThan(10000 - Math.ceil((3840 * RATE) / 44100));
    expect(range.end).toBeGreaterThan(10000 + Math.floor((257280 * RATE) / 44100));
    expect(range.end - range.start).toBeLessThan(Math.ceil((261120 * RATE) / 44100) + 200);
    expect(stream.finalizedEnd).toBe(10000);
  });

  it.each([0, 123457])('identity model: output = band-limited input after origin %i, no seams', async (origin) => {
    const stream = new MdxStream(cfg, identity);
    const n = left.length;
    const run = await runStream(stream, left, right, origin, n);
    const worstL = worstBlockErrorDb(run.left, left, origin, n);
    const worstR = worstBlockErrorDb(run.right, right, origin, n);
    console.log(
      `identity stream from ${origin}: ${run.chunks} chunks, worst 10 ms error L ${worstL.toFixed(1)} dB / R ${worstR.toFixed(1)} dB, ` +
        `${(run.ms / run.chunks).toFixed(0)} ms JS per chunk`,
    );
    expect(worstL).toBeLessThan(-60);
    expect(worstR).toBeLessThan(-60);
    // Chunk starts and ends (44.1 kHz grid k·step − trim, + chunkSize) are seamless.
    let seamWorst = -Infinity;
    for (let k = 1; ; k++) {
      const seams = [k * 195840 - 3840, (k - 1) * 195840 - 3840 + 261120].map((j) => origin + Math.round((j * RATE) / 44100));
      if (seams[0]! + 960 > n) break;
      for (const at of seams) seamWorst = Math.max(seamWorst, worstBlockErrorDb(run.left, left, at - 480, at + 480));
    }
    expect(seamWorst).toBeLessThan(-80);
  });

  it('supports other overlaps', async () => {
    const stream = new MdxStream(cfg, identity, { overlap: 0.5 });
    const end = 20 * RATE;
    const run = await runStream(stream, left, right, 777, end);
    expect(worstBlockErrorDb(run.left, left, 777, end - RATE)).toBeLessThan(-60);
    expect(() => new MdxStream(cfg, identity, { overlap: 0 })).toThrow(RangeError);
    expect(() => new MdxStream(cfg, identity, { overlap: 1 })).toThrow(RangeError);
  });

  it('is deterministic across resets and independent of block boundaries', async () => {
    const stream = new MdxStream(cfg, identity);
    const end = 15 * RATE;
    const a = await runStream(stream, left, right, 5000, end);
    const b = await runStream(stream, left, right, 5000, end);
    expect(b.left).toEqual(a.left);
  });

  it('peak-normalises chunks and skips the model for silence', async () => {
    const inputs: number[] = [];
    const recording: MdxBackend = {
      run: async (input) => {
        let peak = 0;
        for (const v of input) peak = Math.max(peak, Math.abs(v));
        inputs.push(peak);
        return input;
      },
    };
    const stream = new MdxStream(cfg, recording);
    const quiet = left.map((v) => v * 0.01);
    const silent = new Float32Array(left.length);
    // One chunk of quiet audio: the model sees the same spectrum level as for full-scale audio.
    stream.reset(RATE * 10);
    let range = stream.nextInputRange();
    const block = await stream.processNext(quiet.slice(range.start, range.end), quiet.slice(range.start, range.end));
    expect(inputs.length).toBe(1);
    expect(inputs[0]).toBeGreaterThan(100);
    expect(block).not.toBeNull();
    // Output is scaled back: the quiet input is reproduced at its own level.
    let err = 0;
    let ref = 0;
    for (let i = 0; i < block!.vocalsL.length; i++) {
      err += (block!.vocalsL[i]! - quiet[block!.start + i]!) ** 2;
      ref += quiet[block!.start + i]! ** 2;
    }
    expect(10 * Math.log10(err / ref)).toBeLessThan(-60);
    range = stream.nextInputRange();
    const next = await stream.processNext(silent.slice(range.start, range.end), silent.slice(range.start, range.end));
    expect(inputs.length).toBe(1);
    expect(next).not.toBeNull();
  });

  it('rejects input that does not cover nextInputRange()', async () => {
    const stream = new MdxStream(cfg, identity);
    await expect(stream.processNext(new Float32Array(10), new Float32Array(10))).rejects.toThrow(RangeError);
  });

  it('discards a chunk that was in flight during reset()', async () => {
    let release: () => void = () => {};
    const slow: MdxBackend = { run: (input) => new Promise((resolve) => (release = () => resolve(input))) };
    const stream = new MdxStream(cfg, slow);
    const range = stream.nextInputRange();
    const pending = stream.processNext(sliceZeroFilled(left, range.start, range.end), sliceZeroFilled(right, range.start, range.end));
    await expect(stream.processNext(new Float32Array(1), new Float32Array(1))).rejects.toThrow(/already running/);
    stream.reset(RATE);
    release();
    expect(await pending).toBeNull();
    expect(stream.finalizedEnd).toBe(RATE);
  });
});
