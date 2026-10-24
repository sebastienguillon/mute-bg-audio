import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { DFN_DELAY, RT_HOP, SAMPLE_RATE } from '../../src/lib/constants';
import { Dfn } from '../../src/lib/realtime/dfn';
import { dfnWasm, energyRatioDb, loadFixtures, ROOT, siSdr } from './helpers/realtime-audio';

/** Runs `signal` through `dfn` hop by hop and returns the raw (not delay-compensated) output. */
function runRaw(dfn: Dfn, signal: Float32Array, hops = Math.floor(signal.length / RT_HOP)): Float32Array {
  const out = new Float32Array(hops * RT_HOP);
  for (let k = 0; k < hops; k++) {
    out.set(dfn.process(signal.subarray(k * RT_HOP, (k + 1) * RT_HOP)), k * RT_HOP);
  }
  return out;
}

/** Undoes the model delay: estimate[i] = raw[i + delay]. */
function compensate(raw: Float32Array, delay: number): Float32Array {
  const est = new Float32Array(raw.length);
  est.set(raw.subarray(delay));
  return est;
}

describe('Dfn', () => {
  let fx: ReturnType<typeof loadFixtures>;
  beforeAll(() => {
    fx = loadFixtures();
  });

  // First test of the file: the WASM is instantiated here, from raw bytes.
  it('instantiates from raw bytes and reports the expected hop and delay', () => {
    const dfn = Dfn.create(readFileSync(`${ROOT}public/dfn/df_bg.wasm`));
    expect(dfn.hop).toBe(RT_HOP);
    expect(dfn.delay).toBe(DFN_DELAY);
    expect(dfn.process(new Float32Array(RT_HOP))).toHaveLength(RT_HOP);
  });

  it('reuses the instance when created again with a compiled module', () => {
    expect(Dfn.create(dfnWasm()).process(new Float32Array(RT_HOP))).toHaveLength(RT_HOP);
  });

  it('has an algorithmic delay of exactly DFN_DELAY samples', () => {
    // On clean speech the model is close to identity, so the output is the input delayed.
    const seconds = 10;
    const input = fx.speech.subarray(0, seconds * SAMPLE_RATE);
    const raw = runRaw(Dfn.create(dfnWasm()), input);
    let bestLag = -1;
    let best = -Infinity;
    for (let lag = DFN_DELAY - 2 * RT_HOP; lag <= DFN_DELAY + 2 * RT_HOP; lag++) {
      let dot = 0;
      for (let i = lag; i < raw.length; i++) dot += raw[i]! * input[i - lag]!;
      if (dot > best) {
        best = dot;
        bestLag = lag;
      }
    }
    expect(bestLag).toBe(DFN_DELAY);
    expect(siSdr(compensate(raw, DFN_DELAY), input)).toBeGreaterThan(15);
  });

  it('processes in place with the same result as into a new array', () => {
    const a = Dfn.create(dfnWasm());
    const b = Dfn.create(dfnWasm());
    for (let k = 0; k < 300; k++) {
      const hop = fx.mix.slice(k * RT_HOP, (k + 1) * RT_HOP);
      const fresh = a.process(hop);
      const inPlace = b.process(hop, hop);
      expect(inPlace).toBe(hop);
      expect(fresh).toEqual(inPlace);
    }
  });

  it('rejects wrong lengths with a RangeError and keeps working', () => {
    const dfn = Dfn.create(dfnWasm());
    expect(() => dfn.process(new Float32Array(RT_HOP - 1))).toThrow(RangeError);
    expect(() => dfn.process(new Float32Array(RT_HOP), new Float32Array(RT_HOP * 2))).toThrow(RangeError);
    expect(dfn.process(new Float32Array(RT_HOP))).toHaveLength(RT_HOP);
  });

  it('survives NaN, infinite and huge input samples', () => {
    const seconds = 10;
    const clean = fx.mix.subarray(0, seconds * SAMPLE_RATE);
    const corrupted = clean.slice();
    const at = 2 * SAMPLE_RATE;
    corrupted[at] = Number.NaN;
    corrupted[at + RT_HOP] = Number.POSITIVE_INFINITY;
    corrupted[at + 2 * RT_HOP] = -3e38;
    corrupted[at + 3 * RT_HOP] = 1e6;
    const raw = runRaw(Dfn.create(dfnWasm()), corrupted);
    expect(raw.every(Number.isFinite)).toBe(true);
    // One second later the output is as good as without the corrupt samples.
    const from = at + SAMPLE_RATE;
    const to = clean.length - DFN_DELAY;
    const reference = fx.speech.subarray(from, to);
    const score = (r: Float32Array) => siSdr(compensate(r, DFN_DELAY).subarray(from, to), reference);
    expect(score(raw)).toBeGreaterThan(score(runRaw(Dfn.create(dfnWasm()), clean)) - 0.5);
  });

  it('applies the attenuation limit and post-filter settings', () => {
    const seconds = 5;
    const music = fx.music.subarray(0, seconds * SAMPLE_RATE);
    const settled: Array<[number, number]> = [[SAMPLE_RATE, music.length - DFN_DELAY]];
    const unlimited = compensate(runRaw(Dfn.create(dfnWasm()), music), DFN_DELAY);
    const limitedDfn = Dfn.create(dfnWasm());
    limitedDfn.setAttenLimDb(6);
    const limited = compensate(runRaw(limitedDfn, music), DFN_DELAY);
    const unlimitedDb = energyRatioDb(unlimited, music, settled);
    const limitedDb = energyRatioDb(limited, music, settled);
    expect(unlimitedDb).toBeLessThan(-12);
    expect(limitedDb).toBeGreaterThan(-7);
    expect(limitedDb).toBeLessThan(0);

    const postFiltered = Dfn.create(dfnWasm(), { postFilterBeta: 0.05 });
    const plain = Dfn.create(dfnWasm(), { postFilterBeta: 0 });
    const mixture = fx.mix.subarray(0, seconds * SAMPLE_RATE);
    expect(runRaw(postFiltered, mixture)).not.toEqual(runRaw(plain, mixture));
  });
});
