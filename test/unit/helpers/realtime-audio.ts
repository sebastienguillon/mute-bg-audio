// Test helpers for the real-time (DeepFilterNet) module: fixtures, WAV reading, metrics.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const FIXTURES = `${ROOT}test/fixtures/generated/`;

let compiled: WebAssembly.Module | undefined;

/** The vendored DeepFilterNet WASM, compiled once per test file. */
export function dfnWasm(): WebAssembly.Module {
  compiled ??= new WebAssembly.Module(readFileSync(`${ROOT}public/dfn/df_bg.wasm`));
  return compiled;
}

/** Reads a float32 WAV file into one Float32Array per channel. */
export function readWav(path: string): { sampleRate: number; channels: Float32Array[] } {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path}: not a WAV file`);
  }
  let fmt: { tag: number; channels: number; sampleRate: number; bits: number } | undefined;
  let data: Buffer | undefined;
  for (let pos = 12; pos + 8 <= buf.length; ) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        tag: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt or data chunk`);
  if (fmt.tag !== 3 || fmt.bits !== 32) throw new Error(`${path}: expected float32 samples`);
  const interleaved = new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const nch = fmt.channels;
  const frames = Math.floor(interleaved.length / nch);
  const channels = Array.from({ length: nch }, (_, c) => {
    const ch = new Float32Array(frames);
    for (let i = 0; i < frames; i++) ch[i] = interleaved[i * nch + c]!;
    return ch;
  });
  return { sampleRate: fmt.sampleRate, channels };
}

/** Mid channel (L + R) / 2 of a stereo signal. */
export function mid(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(left.length);
  for (let i = 0; i < out.length; i++) out[i] = 0.5 * (left[i]! + right[i]!);
  return out;
}

/** Loads the generated fixtures used by the real-time tests (mono: mid of mix, speech, music). */
export function loadFixtures(): {
  mix: Float32Array;
  speech: Float32Array;
  music: Float32Array;
  speechRegions: Array<[number, number]>;
} {
  const mixWav = readWav(`${FIXTURES}mix.wav`);
  const speechWav = readWav(`${FIXTURES}speech.wav`);
  const musicWav = readWav(`${FIXTURES}music.wav`);
  const [mixL, mixR] = mixWav.channels;
  const [speechL] = speechWav.channels;
  const [musicL, musicR] = musicWav.channels;
  if (!mixL || !mixR || !speechL || !musicL || !musicR) throw new Error('fixtures must be stereo');
  const timeline = JSON.parse(readFileSync(`${FIXTURES}timeline.json`, 'utf8')) as {
    sampleRate: number;
    placements: Array<{ start: number; end: number }>;
  };
  const speechRegions = timeline.placements.map(
    (p): [number, number] => [Math.round(p.start * timeline.sampleRate), Math.round(p.end * timeline.sampleRate)],
  );
  return { mix: mid(mixL, mixR), speech: speechL, music: mid(musicL, musicR), speechRegions };
}

/** Frame ranges [start, end) not covered by `regions` within [0, length), shrunk by `margin` on each side. */
export function complement(regions: Array<[number, number]>, length: number, margin: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cursor = 0;
  for (const [start, end] of [...regions].sort((a, b) => a[0] - b[0])) {
    if (start - margin > cursor + margin) out.push([cursor + margin, start - margin]);
    cursor = Math.max(cursor, end);
  }
  if (length - margin > cursor + margin) out.push([cursor + margin, length - margin]);
  return out;
}

/**
 * Scale-invariant SDR (dB) of `estimate` against `reference` over the frames where `mask` is set
 * (all frames when omitted). `shift` compares estimate[i] with reference[i + shift].
 */
export function siSdr(estimate: Float32Array, reference: Float32Array, mask?: Uint8Array, shift = 0): number {
  let dot = 0;
  let refEnergy = 0;
  const lo = Math.max(0, -shift);
  const hi = Math.min(estimate.length, reference.length - shift);
  for (let i = lo; i < hi; i++) {
    if (mask && !mask[i]) continue;
    const r = reference[i + shift]!;
    dot += estimate[i]! * r;
    refEnergy += r * r;
  }
  const alpha = dot / refEnergy;
  let target = 0;
  let noise = 0;
  for (let i = lo; i < hi; i++) {
    if (mask && !mask[i]) continue;
    const t = alpha * reference[i + shift]!;
    const e = estimate[i]! - t;
    target += t * t;
    noise += e * e;
  }
  return 10 * Math.log10(target / noise);
}

/** Energy ratio (dB) of `a` relative to `b` over the given frame ranges. */
export function energyRatioDb(a: Float32Array, b: Float32Array, ranges: Array<[number, number]>): number {
  let ea = 0;
  let eb = 0;
  for (const [start, end] of ranges) {
    for (let i = start; i < end; i++) {
      ea += a[i]! * a[i]!;
      eb += b[i]! * b[i]!;
    }
  }
  return 10 * Math.log10(ea / eb);
}

/**
 * Splits the error of `estimate` (over the masked frames) into the part explained by the
 * interferer and the rest, after projecting on `target` as in SI-SDR. Returns, in dB relative to
 * the scaled target: `sir` (interference: music left in) and `sar` (artifacts: speech distortion).
 */
export function interferenceArtifacts(
  estimate: Float32Array,
  target: Float32Array,
  interferer: Float32Array,
  mask: Uint8Array,
): { sir: number; sar: number } {
  let et = 0;
  let tt = 0;
  for (let i = 0; i < estimate.length; i++) {
    if (!mask[i]) continue;
    et += estimate[i]! * target[i]!;
    tt += target[i]! * target[i]!;
  }
  const alpha = et / tt;
  let ri = 0;
  let ii = 0;
  for (let i = 0; i < estimate.length; i++) {
    if (!mask[i]) continue;
    ri += (estimate[i]! - alpha * target[i]!) * interferer[i]!;
    ii += interferer[i]! * interferer[i]!;
  }
  const beta = ri / ii;
  let interference = 0;
  let artifacts = 0;
  for (let i = 0; i < estimate.length; i++) {
    if (!mask[i]) continue;
    const r = estimate[i]! - alpha * target[i]!;
    const m = beta * interferer[i]!;
    interference += m * m;
    artifacts += (r - m) * (r - m);
  }
  const targetEnergy = alpha * alpha * tt;
  return { sir: 10 * Math.log10(targetEnergy / interference), sar: 10 * Math.log10(targetEnergy / artifacts) };
}
