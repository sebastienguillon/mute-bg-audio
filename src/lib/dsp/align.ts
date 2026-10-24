/**
 * Locates a short probe inside reference PCM by normalised cross-correlation, computed with one
 * real FFT of the reference, one of the probe and one inverse (O(n log n) for every lag at once).
 */
import { RealFFT } from './fft';

export interface AlignResult {
  /** True when a match with score >= minScore was found. */
  found: boolean;
  /** Best lag: probe[i] ≈ gain · ref[offset + i]. */
  offset: number;
  /** Least-squares gain <p, r_lag> / |r_lag|². */
  gain: number;
  /** Normalised correlation <p, r_lag> / (|p| · |r_lag|), in [0, 1] for the reported lag. */
  score: number;
}

export interface AlignOptions {
  /** Minimum normalised correlation for `found` (default 0.6). */
  minScore?: number;
}

const DEFAULT_MIN_SCORE = 0.6;
/** Probes quieter than this RMS (-100 dBFS) carry no usable signal. */
const MIN_PROBE_RMS = 1e-5;
/** Reference windows more than 100 dB below the loudest window are treated as silence. */
const MIN_WINDOW_ENERGY_RATIO = 1e-10;

interface Workspace {
  size: number;
  fft: RealFFT;
  buffer: Float64Array;
  refRe: Float64Array;
  refIm: Float64Array;
  probeRe: Float64Array;
  probeIm: Float64Array;
  /** Prefix sums of ref²: energy[i] = Σ_{j<i} ref[j]². */
  energy: Float64Array;
}

/** Workspaces kept, most recently used last: callers alternate between a few window sizes (two in practice). */
const MAX_WORKSPACES = 4;
const workspaces = new Map<number, Workspace>();
let workspacesCreated = 0;

/** Number of FFT workspaces allocated so far (for allocation tests). */
export function alignWorkspacesCreated(): number {
  return workspacesCreated;
}

/** Scratch for transforms of `size` (a power of two), created on first use. */
function getWorkspace(size: number): Workspace {
  let workspace = workspaces.get(size);
  if (workspace) {
    workspaces.delete(size);
  } else {
    if (workspaces.size >= MAX_WORKSPACES) workspaces.delete(workspaces.keys().next().value!);
    const bins = size / 2 + 1;
    workspacesCreated++;
    workspace = {
      size,
      fft: new RealFFT(size),
      buffer: new Float64Array(size),
      refRe: new Float64Array(bins),
      refIm: new Float64Array(bins),
      probeRe: new Float64Array(bins),
      probeIm: new Float64Array(bins),
      energy: new Float64Array(size + 1),
    };
  }
  workspaces.set(size, workspace);
  return workspace;
}

const NOT_FOUND: AlignResult = { found: false, offset: 0, gain: 0, score: 0 };

/**
 * Finds the lag of `ref` that best matches `probe` (maximum normalised correlation over all
 * lags 0..ref.length - probe.length). found is false when the probe is silent, the reference is
 * shorter than the probe, or the best score is below minScore (the best candidate is still
 * reported).
 */
export function alignProbe(probe: Float32Array, ref: Float32Array, opts: AlignOptions = {}): AlignResult {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const p = probe.length;
  const r = ref.length;
  if (p === 0 || r < p) return { ...NOT_FOUND };
  let probeEnergy = 0;
  for (let i = 0; i < p; i++) probeEnergy += probe[i]! * probe[i]!;
  if (probeEnergy <= p * MIN_PROBE_RMS * MIN_PROBE_RMS) return { ...NOT_FOUND };

  // Circular correlation of size >= r has no wrap-around for lags 0..r-p.
  let size = 2;
  while (size < r) size *= 2;
  const ws = getWorkspace(size);
  const { fft, buffer, refRe, refIm, probeRe, probeIm, energy } = ws;

  buffer.fill(0);
  for (let i = 0; i < p; i++) buffer[i] = probe[i]!;
  fft.forward(buffer, probeRe, probeIm);
  buffer.fill(0);
  energy[0] = 0;
  for (let i = 0; i < r; i++) {
    const v = ref[i]!;
    buffer[i] = v;
    energy[i + 1] = energy[i]! + v * v;
  }
  fft.forward(buffer, refRe, refIm);
  // corr[lag] = Σ p[i] ref[lag + i]  <=>  spectrum conj(P) · R.
  for (let k = 0; k < fft.bins; k++) {
    const ar = probeRe[k]!;
    const ai = probeIm[k]!;
    const br = refRe[k]!;
    const bi = refIm[k]!;
    refRe[k] = ar * br + ai * bi;
    refIm[k] = ar * bi - ai * br;
  }
  fft.inverse(refRe, refIm, buffer);

  const lags = r - p + 1;
  let maxWindow = 0;
  for (let lag = 0; lag < lags; lag++) maxWindow = Math.max(maxWindow, energy[lag + p]! - energy[lag]!);
  const minWindow = maxWindow * MIN_WINDOW_ENERGY_RATIO;
  let bestLag = -1;
  let bestScore = -Infinity;
  let bestEnergy = 0;
  for (let lag = 0; lag < lags; lag++) {
    const e = energy[lag + p]! - energy[lag]!;
    if (e <= minWindow) continue;
    const score = buffer[lag]! / Math.sqrt(probeEnergy * e);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
      bestEnergy = e;
    }
  }
  if (bestLag < 0 || bestScore <= 0) return { ...NOT_FOUND };
  const gain = buffer[bestLag]! / bestEnergy;
  const score = Math.min(1, bestScore);
  return { found: score >= minScore, offset: bestLag, gain, score };
}
