// Audio analysis helpers for the end-to-end tests (Node).
//
// A recording holds the mixer's undelayed input x[f] and its output y[f] for the same frames.
// The output is not aligned with the input: in look-ahead mode it leads by the sink latency D (it
// is heard in sync with the picture), in real-time mode it lags by L. So the input and the output
// are each located in the source stems by correlation.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { alignProbe } from '../../src/lib/dsp/align';
import { SAMPLE_RATE } from '../../src/lib/constants';
import type { Recording } from './fixtures';

export function readWav(path: string): Float32Array[] {
  const b = readFileSync(path);
  let p = 12;
  let fmt: { tag: number; ch: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.tag !== 3 || fmt.bits !== 32) throw new Error('expected float32 wav');
  const n = data.length / 4 / fmt.ch;
  const out = Array.from({ length: fmt.ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) out[c]![i] = data.readFloatLE((i * fmt.ch + c) * 4);
  return out;
}

export const mid = (ch: Float32Array[]) => {
  const n = ch[0]!.length;
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = 0.5 * (ch[0]![i]! + (ch[1] ?? ch[0]!)[i]!);
  return m;
};

export const rms = (a: Float32Array, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i]! * a[i]!;
  return Math.sqrt(s / Math.max(1, to - from));
};

/** Scale-invariant SDR of est against ref (same length). */
export function siSdr(est: Float32Array, ref: Float32Array): number {
  let dot = 0, rr = 0;
  for (let i = 0; i < ref.length; i++) { dot += est[i]! * ref[i]!; rr += ref[i]! * ref[i]!; }
  const a = dot / (rr || 1);
  let s = 0, e = 0;
  for (let i = 0; i < ref.length; i++) { const t = a * ref[i]!; s += t * t; const d = est[i]! - t; e += d * d; }
  return 10 * Math.log10(s / (e || 1e-20));
}

/** Mid channels of the 30 s test clip's stems (time-aligned with each other). */
export interface Stems { mix: Float32Array; speech: Float32Array; music: Float32Array }

let stems: Stems | null = null;
export function testStems(): Stems {
  const load = (name: string) => mid(readWav(resolve('test/fixtures/generated', name)));
  stems ??= { mix: load('mix.wav'), speech: load('speech.wav'), music: load('music.wav') };
  return stems;
}

const PROBE = 4096;

/** Start of the loudest PROBE-sample stretch of `a` within [from, to) (2048-sample steps). */
function loudest(a: Float32Array, from = 0, to = a.length): number {
  let best = from, bestE = -1;
  for (let s = from; s + PROBE <= to; s += 2048) {
    const e = rms(a, s, s + PROBE);
    if (e > bestE) { bestE = e; best = s; }
  }
  return best;
}

export interface Location {
  /** Index in the reference of recording sample 0. */
  offset: number;
  /** Normalised correlation of the probe at that offset. */
  score: number;
}

/** Locates a recorded signal in a reference by correlating its loudest 4096-sample stretch. */
export function locate(rec: Float32Array, ref: Float32Array, minScore = 0.5): Location | null {
  const at = loudest(rec);
  const r = alignProbe(rec.subarray(at, at + PROBE), ref, { minScore });
  return r.found ? { offset: r.offset - at, score: r.score } : null;
}

/** Locates the input in the mix, and the output in whichever stem it resembles best (speech when the music is removed). */
export function alignToStems(rec: Recording, s: Stems = testStems()): { input: Location; output: Location } {
  const input = locate(mid(rec.input), s.mix);
  if (!input) throw new Error('could not locate the recorded input in the source mix');
  const outM = mid(rec.output);
  const candidates = [locate(outM, s.speech), locate(outM, s.mix)].filter((l): l is Location => l !== null);
  const output = candidates.sort((a, b) => b.score - a.score)[0];
  if (!output) throw new Error('could not locate the recorded output in the stems');
  return { input, output };
}

export interface Quality {
  inputSiSdr: number;
  outputSiSdr: number;
  improvement: number;
  outRms: number;
  inRms: number;
  /** Mix index of input sample 0. */
  mixOffset: number;
  /** Frames by which the output leads the input (negative: it lags). */
  leadFrames: number;
}

/**
 * SI-SDR of the recorded input and output against the clean speech stem, over the content both
 * cover (each at its own position in the stems).
 */
export function speechQuality(rec: Recording, s: Stems = testStems()): Quality {
  const inM = mid(rec.input), outM = mid(rec.output);
  const { input, output } = alignToStems(rec, s);
  const n = inM.length;
  // Content indices c: input sample c − input.offset, output sample c − output.offset.
  const from = Math.max(0, input.offset, output.offset);
  const to = Math.min(s.speech.length, input.offset + n, output.offset + n);
  const ref = s.speech.subarray(from, to);
  const inputSiSdr = siSdr(inM.subarray(from - input.offset, to - input.offset), ref);
  const outputSiSdr = siSdr(outM.subarray(from - output.offset, to - output.offset), ref);
  return {
    inputSiSdr,
    outputSiSdr,
    improvement: outputSiSdr - inputSiSdr,
    outRms: rms(outM),
    inRms: rms(inM),
    mixOffset: input.offset,
    leadFrames: output.offset - input.offset,
  };
}

/**
 * Gain (dB) of the music stem inside the recorded output relative to the input: projections onto
 * the time-aligned music stem (speech and music are uncorrelated, so this isolates the music part;
 * relative to the input, it absorbs the element volume and codec gain).
 */
export function musicGainDb(rec: Recording, s: Stems = testStems()): number {
  const inM = mid(rec.input), outM = mid(rec.output);
  const { input, output } = alignToStems(rec, s);
  const project = (x: Float32Array, offset: number) => {
    const from = Math.max(0, -offset), to = Math.min(x.length, s.music.length - offset);
    let dot = 0, mm = 0;
    for (let i = from; i < to; i++) {
      const m = s.music[i + offset]!;
      dot += x[i]! * m;
      mm += m * m;
    }
    return dot / (mm || 1);
  };
  return 20 * Math.log10(Math.abs(project(outM, output.offset)) / Math.abs(project(inM, input.offset)));
}

/**
 * Frames by which the output leads the input, measured by correlating a loud stretch of the output
 * with the input (which contains everything the output keeps): ≈ D in look-ahead mode, ≈ −L in
 * real-time mode. `maxLag` bounds the search.
 */
export function outputLead(rec: Recording, maxLag = 0.25 * SAMPLE_RATE): Location & { lead: number } {
  const inM = mid(rec.input), outM = mid(rec.output);
  const at = loudest(outM, maxLag, outM.length - maxLag);
  const ref = inM.subarray(at - maxLag, at + PROBE + maxLag);
  const r = alignProbe(outM.subarray(at, at + PROBE), ref, { minScore: 0.5 });
  if (!r.found) throw new Error(`output and input do not correlate (score ${r.score.toFixed(2)})`);
  // Output sample `at` holds the content of input sample at − maxLag + r.offset.
  const lead = r.offset - maxLag;
  return { lead, offset: lead, score: r.score };
}

/** RMS of output − gain · input after aligning them by `lead`, relative to the input RMS (how much the audio was changed). */
export function alignedDifference(rec: Recording, lead: number): number {
  const x = mid(rec.input), y = mid(rec.output);
  const from = Math.max(0, -lead), to = Math.min(y.length, x.length - lead);
  let xy = 0, xx = 0;
  for (let i = from; i < to; i++) { xy += y[i]! * x[i + lead]!; xx += x[i + lead]! ** 2; }
  const g = xy / (xx || 1);
  let d = 0;
  for (let i = from; i < to; i++) d += (y[i]! - g * x[i + lead]!) ** 2;
  return Math.sqrt(d / Math.max(1, to - from)) / (rms(x, from + lead, to + lead) || 1);
}

/**
 * Longest stretch (ms) in which the output is more than 30 dB below a playing (non-silent) input,
 * in 10 ms windows; and how long the input itself was silent (the element seeking).
 */
export function longestDropoutMs(rec: Recording): { dropoutMs: number; elementSilenceMs: number } {
  const x = rec.input[0]!, y = rec.output[0]!;
  const W = SAMPLE_RATE / 100;
  let run = 0, maxRun = 0, silent = 0;
  for (let i = 0; i + W <= y.length; i += W) {
    const inR = rms(x, i, i + W);
    if (inR < 1e-3) silent++;
    run = inR >= 1e-3 && rms(y, i, i + W) < inR * 0.0316 ? run + 1 : 0;
    maxRun = Math.max(maxRun, run);
  }
  return { dropoutMs: maxRun * 10, elementSilenceMs: silent * 10 };
}

/** Mid channels of a clip's mix and speech stem (float32 WAV files), e.g. the gapped clip of media.mjs. */
export function loadStems(mixPath: string, speechPath: string): Pick<Stems, 'mix' | 'speech'> {
  return { mix: mid(readWav(resolve(mixPath))), speech: mid(readWav(resolve(speechPath))) };
}

/** Start and length of the longest run of exact zeros in `x` within [from, to). */
export function longestZeroRun(x: Float32Array, from = 0, to = x.length): { start: number; length: number } {
  let best = { start: from, length: 0 };
  for (let i = from, start = -1; i <= to; i++) {
    if (i < to && x[i] === 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start > best.length) best = { start, length: i - start };
      start = -1;
    }
  }
  return best;
}

/** Index of the first non-zero sample of `x` (x.length when there is none). */
export function firstSound(x: Float32Array): number {
  let i = 0;
  while (i < x.length && x[i] === 0) i++;
  return i;
}

/** Index from which `x` is exact zeros up to its end (x.length when its last sample is not zero). */
export function trailingSilence(x: Float32Array): number {
  let i = x.length;
  while (i > 0 && x[i - 1] === 0) i--;
  return i;
}

export interface SpeechCoverage {
  /** Windows of clear speech checked. */
  windows: number;
  /** Content times (s) of the windows the output does not contain. */
  missing: number[];
  /** Longest run of consecutive missing windows, ms of content. */
  longestMissingMs: number;
  /** Windows found where look-ahead output plays them (D ahead of the input), and where real-time output does (L behind it). */
  lookahead: number;
  realtime: number;
  /** Lowest correlation of a window that was found. */
  lowestScore: number;
}

const WINDOW = 1920;
const HOP = 960;
/** Windows at least this loud relative to the loudest speech of the stem are checked. */
const CLEAR_SPEECH = 0.3;
/** Window correlation below which speech counts as missing from the output. */
const FOUND_SCORE = 0.5;
/** Search around the expected position of a window in the output (5 ms). */
const TOLERANCE = 240;

/**
 * Whether the output plays every stretch of clear speech of content [from, to) (indices in the
 * stems), so that nothing was skipped: each 40 ms window (20 ms steps) of the speech stem within
 * 10 dB of its loudest is searched where look-ahead output plays it (`sinkLatency` ahead of the
 * input) and where real-time output does (`realtimeLatency` behind it), ± 5 ms. `inputOffset` is
 * the content index of input sample 0 (locate the input in the mix: it must be continuous content
 * from `from` on). Windows the recording cannot hold at either position are not checked.
 *
 * A skip of L + D (60 + 38 ms here) inside a word leaves at least two windows missing; sustained
 * vowels can match the content a few ms away, so shorter skips may go unnoticed.
 */
export function speechCoverage(
  rec: Recording,
  speech: Float32Array,
  inputOffset: number,
  from: number,
  to: number,
  sinkLatency: number,
  realtimeLatency: number,
): SpeechCoverage {
  const outM = mid(rec.output);
  let loudest = 0;
  for (let c = 0; c + WINDOW <= speech.length; c += HOP) loudest = Math.max(loudest, rms(speech, c, c + WINDOW));
  const result: SpeechCoverage = { windows: 0, missing: [], longestMissingMs: 0, lookahead: 0, realtime: 0, lowestScore: 1 };
  let run = 0;
  for (let c = from; c + WINDOW <= to; c += HOP) {
    const probe = speech.subarray(c, c + WINDOW);
    if (rms(probe) < CLEAR_SPEECH * loudest) continue;
    let best = 0, where: 'lookahead' | 'realtime' | null = null, checkable = false;
    for (const [kind, at] of [['lookahead', c - inputOffset - sinkLatency], ['realtime', c - inputOffset + realtimeLatency]] as const) {
      if (at - TOLERANCE < 0 || at + TOLERANCE + WINDOW > outM.length) continue;
      checkable = true;
      const score = alignProbe(probe, outM.subarray(at - TOLERANCE, at + TOLERANCE + WINDOW), { minScore: 0 }).score;
      if (score > best) { best = score; where = kind; }
    }
    if (!checkable) continue;
    result.windows++;
    if (best >= FOUND_SCORE && where) {
      result[where]++;
      result.lowestScore = Math.min(result.lowestScore, best);
      run = 0;
    } else {
      result.missing.push(c / SAMPLE_RATE);
      run++;
      result.longestMissingMs = Math.max(result.longestMissingMs, ((run - 1) * HOP + WINDOW) / (SAMPLE_RATE / 1000));
    }
  }
  return result;
}
