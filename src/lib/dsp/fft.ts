/**
 * Complex and real FFTs of arbitrary size, Float64 internally.
 *
 * Sizes whose prime factors are only 2, 3 and 5 use a self-sorting (Stockham) mixed-radix
 * algorithm with radix-4/2/3/5 butterflies. Every other size goes through Bluestein's chirp-z
 * algorithm on top of a power-of-two transform. Twiddles and work buffers are precomputed per
 * instance, so transforms never allocate. Instances own scratch memory and are not re-entrant.
 */

const TAU = 2 * Math.PI;

interface Plan {
  /** In-place forward transform of the first n elements. */
  transform(re: Float64Array, im: Float64Array): void;
}

interface Stage {
  radix: number;
  /** Distance between consecutive elements of one butterfly input (product of earlier radices). */
  stride: number;
  /** Butterflies per stride step: (remaining length) / radix. */
  m: number;
  /** Twiddles w^(r*q), stored as [(r - 1) * m + q] for r = 1..radix-1, q = 0..m-1. */
  twRe: Float64Array;
  twIm: Float64Array;
}

/** Radices for a 2,3,5-smooth size (largest radices first), or null if another prime divides n. */
function smoothRadices(n: number): number[] | null {
  const radices: number[] = [];
  let rest = n;
  while (rest % 4 === 0) {
    radices.push(4);
    rest /= 4;
  }
  if (rest % 2 === 0) {
    radices.push(2);
    rest /= 2;
  }
  while (rest % 3 === 0) {
    radices.push(3);
    rest /= 3;
  }
  while (rest % 5 === 0) {
    radices.push(5);
    rest /= 5;
  }
  return rest === 1 ? radices : null;
}

/** True when n > 0 is an integer whose only prime factors are 2, 3 and 5. */
export function isSmoothSize(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && smoothRadices(n) !== null;
}

/** Smallest even 2,3,5-smooth size >= n (sizes for which FFT/RealFFT are fastest). */
export function nextSmoothSize(n: number): number {
  let size = Math.max(2, Math.ceil(n));
  if (size % 2 === 1) size++;
  while (!isSmoothSize(size)) size += 2;
  return size;
}

/** Self-sorting Stockham autosort FFT (decimation in frequency) for 2,3,5-smooth sizes. */
class StockhamPlan implements Plan {
  private readonly stages: Stage[] = [];
  private readonly workRe: Float64Array;
  private readonly workIm: Float64Array;

  constructor(n: number, radices: number[]) {
    this.workRe = new Float64Array(n);
    this.workIm = new Float64Array(n);
    let len = n;
    let stride = 1;
    for (const radix of radices) {
      const m = len / radix;
      const twRe = new Float64Array((radix - 1) * m);
      const twIm = new Float64Array((radix - 1) * m);
      for (let r = 1; r < radix; r++) {
        for (let q = 0; q < m; q++) {
          const angle = (-TAU * r * q) / len;
          twRe[(r - 1) * m + q] = Math.cos(angle);
          twIm[(r - 1) * m + q] = Math.sin(angle);
        }
      }
      this.stages.push({ radix, stride, m, twRe, twIm });
      len = m;
      stride *= radix;
    }
  }

  transform(re: Float64Array, im: Float64Array): void {
    let xr = re;
    let xi = im;
    let yr = this.workRe;
    let yi = this.workIm;
    for (const stage of this.stages) {
      switch (stage.radix) {
        case 4:
          radix4(xr, xi, yr, yi, stage);
          break;
        case 2:
          radix2(xr, xi, yr, yi, stage);
          break;
        case 3:
          radix3(xr, xi, yr, yi, stage);
          break;
        default:
          radix5(xr, xi, yr, yi, stage);
      }
      const tr = xr;
      const ti = xi;
      xr = yr;
      xi = yi;
      yr = tr;
      yi = ti;
    }
    if (xr !== re) {
      re.set(xr);
      im.set(xi);
    }
  }
}

// Each butterfly reads a_j = x[k + s*(q + j*m)] and writes y[k + s*(radix*q + r)] = DFT_radix(a)[r] * w^(r*q).

function radix2(xr: Float64Array, xi: Float64Array, yr: Float64Array, yi: Float64Array, st: Stage): void {
  const { stride: s, m, twRe, twIm } = st;
  for (let q = 0; q < m; q++) {
    const wr = twRe[q]!;
    const wi = twIm[q]!;
    const i0 = s * q;
    const i1 = i0 + s * m;
    const o0 = 2 * s * q;
    const o1 = o0 + s;
    for (let k = 0; k < s; k++) {
      const ar = xr[i0 + k]!;
      const ai = xi[i0 + k]!;
      const br = xr[i1 + k]!;
      const bi = xi[i1 + k]!;
      yr[o0 + k] = ar + br;
      yi[o0 + k] = ai + bi;
      const dr = ar - br;
      const di = ai - bi;
      yr[o1 + k] = dr * wr - di * wi;
      yi[o1 + k] = dr * wi + di * wr;
    }
  }
}

function radix4(xr: Float64Array, xi: Float64Array, yr: Float64Array, yi: Float64Array, st: Stage): void {
  const { stride: s, m, twRe, twIm } = st;
  const sm = s * m;
  for (let q = 0; q < m; q++) {
    const w1r = twRe[q]!;
    const w1i = twIm[q]!;
    const w2r = twRe[m + q]!;
    const w2i = twIm[m + q]!;
    const w3r = twRe[2 * m + q]!;
    const w3i = twIm[2 * m + q]!;
    const i0 = s * q;
    const o0 = 4 * s * q;
    for (let k = 0; k < s; k++) {
      const j0 = i0 + k;
      const a0r = xr[j0]!;
      const a0i = xi[j0]!;
      const a1r = xr[j0 + sm]!;
      const a1i = xi[j0 + sm]!;
      const a2r = xr[j0 + 2 * sm]!;
      const a2i = xi[j0 + 2 * sm]!;
      const a3r = xr[j0 + 3 * sm]!;
      const a3i = xi[j0 + 3 * sm]!;
      const t0r = a0r + a2r;
      const t0i = a0i + a2i;
      const t1r = a0r - a2r;
      const t1i = a0i - a2i;
      const t2r = a1r + a3r;
      const t2i = a1i + a3i;
      // t3 = -i * (a1 - a3)
      const t3r = a1i - a3i;
      const t3i = a3r - a1r;
      const k0 = o0 + k;
      yr[k0] = t0r + t2r;
      yi[k0] = t0i + t2i;
      const b1r = t1r + t3r;
      const b1i = t1i + t3i;
      yr[k0 + s] = b1r * w1r - b1i * w1i;
      yi[k0 + s] = b1r * w1i + b1i * w1r;
      const b2r = t0r - t2r;
      const b2i = t0i - t2i;
      yr[k0 + 2 * s] = b2r * w2r - b2i * w2i;
      yi[k0 + 2 * s] = b2r * w2i + b2i * w2r;
      const b3r = t1r - t3r;
      const b3i = t1i - t3i;
      yr[k0 + 3 * s] = b3r * w3r - b3i * w3i;
      yi[k0 + 3 * s] = b3r * w3i + b3i * w3r;
    }
  }
}

const SIN_60 = Math.sqrt(3) / 2;

function radix3(xr: Float64Array, xi: Float64Array, yr: Float64Array, yi: Float64Array, st: Stage): void {
  const { stride: s, m, twRe, twIm } = st;
  const sm = s * m;
  for (let q = 0; q < m; q++) {
    const w1r = twRe[q]!;
    const w1i = twIm[q]!;
    const w2r = twRe[m + q]!;
    const w2i = twIm[m + q]!;
    const i0 = s * q;
    const o0 = 3 * s * q;
    for (let k = 0; k < s; k++) {
      const j0 = i0 + k;
      const a0r = xr[j0]!;
      const a0i = xi[j0]!;
      const a1r = xr[j0 + sm]!;
      const a1i = xi[j0 + sm]!;
      const a2r = xr[j0 + 2 * sm]!;
      const a2i = xi[j0 + 2 * sm]!;
      const sr = a1r + a2r;
      const si = a1i + a2i;
      // d = -i * sin(60°) * (a1 - a2)
      const dr = SIN_60 * (a1i - a2i);
      const di = -SIN_60 * (a1r - a2r);
      const cr = a0r - 0.5 * sr;
      const ci = a0i - 0.5 * si;
      const k0 = o0 + k;
      yr[k0] = a0r + sr;
      yi[k0] = a0i + si;
      const b1r = cr + dr;
      const b1i = ci + di;
      yr[k0 + s] = b1r * w1r - b1i * w1i;
      yi[k0 + s] = b1r * w1i + b1i * w1r;
      const b2r = cr - dr;
      const b2i = ci - di;
      yr[k0 + 2 * s] = b2r * w2r - b2i * w2i;
      yi[k0 + 2 * s] = b2r * w2i + b2i * w2r;
    }
  }
}

const C1 = Math.cos(TAU / 5);
const C2 = Math.cos((2 * TAU) / 5);
const S1 = Math.sin(TAU / 5);
const S2 = Math.sin((2 * TAU) / 5);

function radix5(xr: Float64Array, xi: Float64Array, yr: Float64Array, yi: Float64Array, st: Stage): void {
  const { stride: s, m, twRe, twIm } = st;
  const sm = s * m;
  for (let q = 0; q < m; q++) {
    const w1r = twRe[q]!;
    const w1i = twIm[q]!;
    const w2r = twRe[m + q]!;
    const w2i = twIm[m + q]!;
    const w3r = twRe[2 * m + q]!;
    const w3i = twIm[2 * m + q]!;
    const w4r = twRe[3 * m + q]!;
    const w4i = twIm[3 * m + q]!;
    const i0 = s * q;
    const o0 = 5 * s * q;
    for (let k = 0; k < s; k++) {
      const j0 = i0 + k;
      const a0r = xr[j0]!;
      const a0i = xi[j0]!;
      const a1r = xr[j0 + sm]!;
      const a1i = xi[j0 + sm]!;
      const a2r = xr[j0 + 2 * sm]!;
      const a2i = xi[j0 + 2 * sm]!;
      const a3r = xr[j0 + 3 * sm]!;
      const a3i = xi[j0 + 3 * sm]!;
      const a4r = xr[j0 + 4 * sm]!;
      const a4i = xi[j0 + 4 * sm]!;
      const b1r = a1r + a4r;
      const b1i = a1i + a4i;
      const b2r = a2r + a3r;
      const b2i = a2i + a3i;
      const d1r = a1r - a4r;
      const d1i = a1i - a4i;
      const d2r = a2r - a3r;
      const d2i = a2i - a3i;
      // X1,4 = a0 + C1 b1 + C2 b2 ∓ i (S1 d1 + S2 d2); X2,3 = a0 + C2 b1 + C1 b2 ∓ i (S2 d1 - S1 d2)
      const p1r = a0r + C1 * b1r + C2 * b2r;
      const p1i = a0i + C1 * b1i + C2 * b2i;
      const p2r = a0r + C2 * b1r + C1 * b2r;
      const p2i = a0i + C2 * b1i + C1 * b2i;
      const q1r = S1 * d1r + S2 * d2r;
      const q1i = S1 * d1i + S2 * d2i;
      const q2r = S2 * d1r - S1 * d2r;
      const q2i = S2 * d1i - S1 * d2i;
      const k0 = o0 + k;
      yr[k0] = a0r + b1r + b2r;
      yi[k0] = a0i + b1i + b2i;
      // -i * (x + iy) = y - ix
      const x1r = p1r + q1i;
      const x1i = p1i - q1r;
      yr[k0 + s] = x1r * w1r - x1i * w1i;
      yi[k0 + s] = x1r * w1i + x1i * w1r;
      const x2r = p2r + q2i;
      const x2i = p2i - q2r;
      yr[k0 + 2 * s] = x2r * w2r - x2i * w2i;
      yi[k0 + 2 * s] = x2r * w2i + x2i * w2r;
      const x3r = p2r - q2i;
      const x3i = p2i + q2r;
      yr[k0 + 3 * s] = x3r * w3r - x3i * w3i;
      yi[k0 + 3 * s] = x3r * w3i + x3i * w3r;
      const x4r = p1r - q1i;
      const x4i = p1i + q1r;
      yr[k0 + 4 * s] = x4r * w4r - x4i * w4i;
      yi[k0 + 4 * s] = x4r * w4i + x4i * w4r;
    }
  }
}

/**
 * Bluestein's algorithm: X[k] = c[k] · Σ_j (x[j] c[j]) · conj(c[k - j]) with c[j] = e^{-iπj²/n},
 * evaluated as a circular convolution of power-of-two size m >= 2n - 1.
 */
class BluesteinPlan implements Plan {
  private readonly n: number;
  private readonly inner: StockhamPlan;
  private readonly chirpRe: Float64Array;
  private readonly chirpIm: Float64Array;
  /** FFT of the conjugate chirp filter, pre-scaled by 1/m (the inverse transform is unscaled). */
  private readonly filterRe: Float64Array;
  private readonly filterIm: Float64Array;
  private readonly workRe: Float64Array;
  private readonly workIm: Float64Array;

  constructor(n: number) {
    this.n = n;
    let m = 1;
    while (m < 2 * n - 1) m *= 2;
    this.inner = new StockhamPlan(m, smoothRadices(m)!);
    this.chirpRe = new Float64Array(n);
    this.chirpIm = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      // j² mod 2n keeps the angle small and exact (j² < 2^53 for every supported n).
      const angle = (-Math.PI * ((j * j) % (2 * n))) / n;
      this.chirpRe[j] = Math.cos(angle);
      this.chirpIm[j] = Math.sin(angle);
    }
    this.filterRe = new Float64Array(m);
    this.filterIm = new Float64Array(m);
    for (let j = 0; j < n; j++) {
      const re = this.chirpRe[j]! / m;
      const im = -this.chirpIm[j]! / m;
      this.filterRe[j] = re;
      this.filterIm[j] = im;
      if (j > 0) {
        this.filterRe[m - j] = re;
        this.filterIm[m - j] = im;
      }
    }
    this.inner.transform(this.filterRe, this.filterIm);
    this.workRe = new Float64Array(m);
    this.workIm = new Float64Array(m);
  }

  transform(re: Float64Array, im: Float64Array): void {
    const { n, chirpRe, chirpIm, filterRe, filterIm, workRe, workIm } = this;
    const m = workRe.length;
    for (let j = 0; j < n; j++) {
      const xr = re[j]!;
      const xi = im[j]!;
      const cr = chirpRe[j]!;
      const ci = chirpIm[j]!;
      workRe[j] = xr * cr - xi * ci;
      workIm[j] = xr * ci + xi * cr;
    }
    workRe.fill(0, n);
    workIm.fill(0, n);
    this.inner.transform(workRe, workIm);
    // Multiply by the filter and conjugate, so that a forward transform performs the inverse.
    for (let j = 0; j < m; j++) {
      const ar = workRe[j]!;
      const ai = workIm[j]!;
      const br = filterRe[j]!;
      const bi = filterIm[j]!;
      workRe[j] = ar * br - ai * bi;
      workIm[j] = -(ar * bi + ai * br);
    }
    this.inner.transform(workRe, workIm);
    for (let j = 0; j < n; j++) {
      const yr = workRe[j]!;
      const yi = -workIm[j]!;
      const cr = chirpRe[j]!;
      const ci = chirpIm[j]!;
      re[j] = yr * cr - yi * ci;
      im[j] = yr * ci + yi * cr;
    }
  }
}

/** In-place complex FFT of a fixed size n (any n >= 1). */
export class FFT {
  readonly n: number;
  private readonly plan: Plan | null;

  constructor(n: number) {
    if (!Number.isInteger(n) || n < 1) throw new RangeError(`FFT size must be a positive integer, got ${n}`);
    this.n = n;
    const radices = smoothRadices(n);
    this.plan = n === 1 ? null : radices ? new StockhamPlan(n, radices) : new BluesteinPlan(n);
  }

  /** X[k] = Σ x[j] e^{-2πi jk/n}, in place on the first n elements. */
  forward(re: Float64Array, im: Float64Array): void {
    this.check(re, im);
    this.plan?.transform(re, im);
  }

  /** Unscaled inverse, x[j] = Σ X[k] e^{+2πi jk/n}, in place on the first n elements. */
  inverse(re: Float64Array, im: Float64Array): void {
    this.check(re, im);
    if (!this.plan) return;
    const n = this.n;
    for (let j = 0; j < n; j++) im[j] = -im[j]!;
    this.plan.transform(re, im);
    for (let j = 0; j < n; j++) im[j] = -im[j]!;
  }

  private check(re: Float64Array, im: Float64Array): void {
    if (re.length < this.n || im.length < this.n) {
      throw new RangeError(`FFT(${this.n}) needs arrays of at least ${this.n} elements`);
    }
  }
}

/**
 * FFT of a real signal of even length n through a complex FFT of size n/2.
 * The spectrum is one-sided: n/2 + 1 bins.
 */
export class RealFFT {
  readonly n: number;
  /** Number of spectrum bins, n/2 + 1. */
  readonly bins: number;
  private readonly half: number;
  private readonly fft: FFT;
  private readonly zRe: Float64Array;
  private readonly zIm: Float64Array;
  /** cos/sin(2πk/n) for k = 0..n/2. */
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;

  constructor(n: number) {
    if (!Number.isInteger(n) || n < 2 || n % 2 !== 0) {
      throw new RangeError(`RealFFT size must be a positive even integer, got ${n}`);
    }
    this.n = n;
    this.half = n / 2;
    this.bins = this.half + 1;
    this.fft = new FFT(this.half);
    this.zRe = new Float64Array(this.half);
    this.zIm = new Float64Array(this.half);
    this.cos = new Float64Array(this.half + 1);
    this.sin = new Float64Array(this.half + 1);
    for (let k = 0; k <= this.half; k++) {
      this.cos[k] = Math.cos((TAU * k) / n);
      this.sin[k] = Math.sin((TAU * k) / n);
    }
  }

  /** X[k] = Σ x[j] e^{-2πi jk/n} for k = 0..n/2, from the first n samples of input. */
  forward(input: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    const { half, zRe, zIm, cos, sin } = this;
    if (input.length < this.n || outRe.length < this.bins || outIm.length < this.bins) {
      throw new RangeError(`RealFFT(${this.n}): input needs ${this.n} samples and outputs ${this.bins} bins`);
    }
    for (let j = 0; j < half; j++) {
      zRe[j] = input[2 * j]!;
      zIm[j] = input[2 * j + 1]!;
    }
    this.fft.forward(zRe, zIm);
    for (let k = 0; k <= half; k++) {
      const a = k === half ? 0 : k;
      const b = k === 0 ? 0 : half - k;
      const ar = zRe[a]!;
      const ai = zIm[a]!;
      const br = zRe[b]!;
      const bi = zIm[b]!;
      // Even part Fe = (Z[k] + conj Z[h-k]) / 2, odd part Fo = (Z[k] - conj Z[h-k]) / 2i.
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai - bi);
      const or = 0.5 * (ai + bi);
      const oi = -0.5 * (ar - br);
      // X[k] = Fe + e^{-2πik/n} Fo
      const c = cos[k]!;
      const s = sin[k]!;
      outRe[k] = er + c * or + s * oi;
      outIm[k] = ei + c * oi - s * or;
    }
  }

  /**
   * Inverse of forward(), scaled by 1/n so that inverse(forward(x)) = x. Reads bins 0..n/2 and,
   * like a C2R transform, ignores the imaginary parts of the DC and Nyquist bins.
   */
  inverse(re: ArrayLike<number>, im: ArrayLike<number>, out: Float64Array | Float32Array): void {
    const { half, zRe, zIm, cos, sin } = this;
    if (re.length < this.bins || im.length < this.bins || out.length < this.n) {
      throw new RangeError(`RealFFT(${this.n}): inputs need ${this.bins} bins and output ${this.n} samples`);
    }
    for (let k = 0; k < half; k++) {
      const ar = re[k]!;
      const ai = k === 0 ? 0 : im[k]!;
      const br = re[half - k]!;
      const bi = k === 0 ? 0 : im[half - k]!;
      // 2·Fe = X[k] + conj X[h-k];  2·Fo = (X[k] - conj X[h-k]) e^{+2πik/n};  Z = Fe + i Fo
      const er = ar + br;
      const ei = ai - bi;
      const dr = ar - br;
      const di = ai + bi;
      const c = cos[k]!;
      const s = sin[k]!;
      const gr = dr * c - di * s;
      const gi = dr * s + di * c;
      zRe[k] = er - gi;
      zIm[k] = ei + gr;
    }
    this.fft.inverse(zRe, zIm);
    const scale = 1 / this.n;
    for (let j = 0; j < half; j++) {
      out[2 * j] = zRe[j]! * scale;
      out[2 * j + 1] = zIm[j]! * scale;
    }
  }
}
