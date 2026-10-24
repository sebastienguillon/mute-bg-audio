/**
 * Band-limited windowed-sinc (Kaiser) resampler with an exact, zero-phase time mapping.
 *
 * Input sample i of a stream at `fromRate` sits at time i / fromRate and output sample k at
 * time k / toRate, both measured from the same origin. Every output sample is computed
 * independently from the input samples around its position, so a long stream can be processed
 * in independent blocks: a block whose input covers resampleInputRange() of its outputs yields
 * exactly the samples a single pass over the whole stream would.
 *
 * The filter is flat (within 1e-4) up to 0.9 × the lower Nyquist frequency and attenuates
 * everything above the lower Nyquist by more than 95 dB (100 dB Kaiser design), so nothing
 * aliases. Rates must be positive integers. When the reduced ratio has a
 * denominator of at most MAX_EXACT_PHASES (all common audio rates, e.g. 48000/44100 = 160/147)
 * the polyphase table holds every exact phase; otherwise 1024 phases are interpolated linearly.
 */

/** Kaiser design attenuation in dB. */
const STOPBAND_DB = 100;
/** Passband edge as a fraction of the lower of the two Nyquist frequencies. */
const PASSBAND = 0.9;
const MAX_EXACT_PHASES = 1024;
const INTERPOLATED_PHASES = 1024;

interface Kernel {
  /** p = j · num / den is the input position of output sample j. */
  num: number;
  den: number;
  /** Taps on each side of the output position; a row has 2·half taps. */
  half: number;
  taps: number;
  /** true: one row per exact phase (den rows); false: INTERPOLATED_PHASES + 1 rows. */
  exact: boolean;
  table: Float64Array;
}

const kernels = new Map<string, Kernel>();

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** floor(a / b) for integers a and b > 0, exact for |a| < 2^53. */
function floorDiv(a: number, b: number): number {
  let q = Math.floor(a / b);
  const r = a - q * b;
  if (r < 0) q--;
  else if (r >= b) q++;
  return q;
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; term > 1e-17 * sum; k++) {
    term *= q / (k * k);
    sum += term;
  }
  return sum;
}

function checkRate(rate: number): void {
  if (!Number.isInteger(rate) || rate <= 0) throw new RangeError(`sample rates must be positive integers, got ${rate}`);
}

function getKernel(fromRate: number, toRate: number): Kernel {
  const key = `${fromRate}:${toRate}`;
  const cached = kernels.get(key);
  if (cached) return cached;
  checkRate(fromRate);
  checkRate(toRate);
  const g = gcd(fromRate, toRate);
  const num = fromRate / g;
  const den = toRate / g;
  const nyquist = Math.min(fromRate, toRate) / 2;
  // Normalised to the input rate (cycles per input sample).
  const cutoff = ((1 + PASSBAND) / 2) * (nyquist / fromRate);
  const transition = (1 - PASSBAND) * (nyquist / fromRate);
  const length = (STOPBAND_DB - 7.95) / (14.36 * transition);
  const half = 2 * Math.ceil(length / 4); // even, so rows are a multiple of 4 taps
  const taps = 2 * half;
  const beta = 0.1102 * (STOPBAND_DB - 8.7);
  const i0Beta = besselI0(beta);
  const exact = den <= MAX_EXACT_PHASES;
  const rows = exact ? den : INTERPOLATED_PHASES + 1;
  const table = new Float64Array(rows * taps);
  for (let r = 0; r < rows; r++) {
    const phase = exact ? r / den : r / INTERPOLATED_PHASES;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      // Tap t multiplies input index floor(p) - half + 1 + t, at distance u = p - index.
      const u = phase + half - 1 - t;
      const x = 2 * cutoff * u;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = u / half;
      const kaiser = Math.abs(w) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - w * w)) / i0Beta;
      const h = 2 * cutoff * sinc * kaiser;
      table[r * taps + t] = h;
      sum += h;
    }
    // Unit DC gain for every phase.
    for (let t = 0; t < taps; t++) table[r * taps + t] = table[r * taps + t]! / sum;
  }
  const kernel: Kernel = { num, den, half, taps, exact, table };
  kernels.set(key, kernel);
  return kernel;
}

/**
 * Input samples needed on each side: output sample at input position p depends only on input
 * indices i with p - margin < i <= p + margin. 0 when the rates are equal.
 */
export function resampleMargin(fromRate: number, toRate: number): number {
  return fromRate === toRate ? 0 : getKernel(fromRate, toRate).half;
}

/** Input index range [start, end) that output samples [outStart, outStart + outLength) depend on. */
export function resampleInputRange(fromRate: number, toRate: number, outStart: number, outLength: number): { start: number; end: number } {
  if (fromRate === toRate) return { start: outStart, end: outStart + outLength };
  const { num, den, half } = getKernel(fromRate, toRate);
  const first = floorDiv(outStart * num, den);
  if (outLength <= 0) return { start: first, end: first };
  return { start: first - half + 1, end: floorDiv((outStart + outLength - 1) * num, den) + half + 1 };
}

/** Exclusive end of the output samples that depend only on input indices below `inputEnd`. */
export function resampleOutputEnd(fromRate: number, toRate: number, inputEnd: number): number {
  if (fromRate === toRate) return inputEnd;
  const { num, den, half } = getKernel(fromRate, toRate);
  // j is computable iff floor(j·num/den) + half < inputEnd  <=>  j·num < (inputEnd - half)·den
  return -floorDiv(-(inputEnd - half) * den, num);
}

/**
 * Resamples a block of a stream. input[i] is the sample at time (inputStart + i) / fromRate;
 * out[k] receives the band-limited value at time (outStart + k) / toRate. Input outside the
 * array counts as zero. Returns `out` (allocated when omitted).
 */
export function resampleRange(
  input: Float32Array,
  inputStart: number,
  fromRate: number,
  toRate: number,
  outStart: number,
  outLength: number,
  out: Float32Array = new Float32Array(outLength),
): Float32Array {
  if (!Number.isInteger(inputStart) || !Number.isInteger(outStart) || !Number.isInteger(outLength) || outLength < 0) {
    throw new RangeError('resampleRange: indices and lengths must be integers');
  }
  if (out.length < outLength) throw new RangeError(`resampleRange: output needs ${outLength} samples`);
  const n = input.length;
  if (fromRate === toRate) {
    checkRate(fromRate);
    for (let k = 0; k < outLength; k++) {
      const i = outStart + k - inputStart;
      out[k] = i >= 0 && i < n ? input[i]! : 0;
    }
    return out;
  }
  const { num, den, half, taps, exact, table } = getKernel(fromRate, toRate);
  const stepInt = Math.floor(num / den);
  const stepFrac = num - stepInt * den;
  let ip = floorDiv(outStart * num, den);
  let phase = outStart * num - ip * den;
  for (let k = 0; k < outLength; k++) {
    const base = ip - half + 1 - inputStart;
    const inside = base >= 0 && base + taps <= n;
    if (exact) {
      const row = phase * taps;
      out[k] = inside ? dot(table, row, input, base, taps) : dotClipped(table, row, input, base, taps);
    } else {
      const pos = (phase / den) * INTERPOLATED_PHASES;
      const r = Math.floor(pos);
      const mu = pos - r;
      const a = inside ? dot(table, r * taps, input, base, taps) : dotClipped(table, r * taps, input, base, taps);
      const b = inside ? dot(table, (r + 1) * taps, input, base, taps) : dotClipped(table, (r + 1) * taps, input, base, taps);
      out[k] = a + mu * (b - a);
    }
    ip += stepInt;
    phase += stepFrac;
    if (phase >= den) {
      phase -= den;
      ip++;
    }
  }
  return out;
}

/** Σ c[row + t] · x[base + t] for t < taps (taps is a multiple of 4, all indices in range). */
function dot(c: Float64Array, row: number, x: Float32Array, base: number, taps: number): number {
  let a0 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 0;
  for (let t = 0; t < taps; t += 4) {
    a0 += c[row + t]! * x[base + t]!;
    a1 += c[row + t + 1]! * x[base + t + 1]!;
    a2 += c[row + t + 2]! * x[base + t + 2]!;
    a3 += c[row + t + 3]! * x[base + t + 3]!;
  }
  return a0 + a1 + (a2 + a3);
}

/** Like dot(), treating x outside [0, x.length) as zero. */
function dotClipped(c: Float64Array, row: number, x: Float32Array, base: number, taps: number): number {
  const t0 = Math.max(0, -base);
  const t1 = Math.min(taps, x.length - base);
  let acc = 0;
  for (let t = t0; t < t1; t++) acc += c[row + t]! * x[base + t]!;
  return acc;
}
