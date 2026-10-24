// DeepFilterNet3 speech estimator: thin wrapper around the vendored wasm-bindgen build
// (vendor/deepfilternet, model embedded in public/dfn/df_bg.wasm). See docs/ARCHITECTURE.md.
import {
  df_create,
  df_get_frame_length,
  df_process_frame,
  df_set_atten_lim,
  df_set_post_filter_beta,
  initSync,
} from '../../../vendor/deepfilternet/df.js';
import { DFN_DELAY } from '../constants';

/** Options for {@link Dfn.create}. */
export interface DfnOptions {
  /** Maximum attenuation applied by the model, in dB. Default 100 (no limit). */
  attenLimDb?: number;
  /** Post-filter strength; 0 disables it. DeepFilterNet suggests at most 0.05. Default 0. */
  postFilterBeta?: number;
}

const DEFAULT_ATTEN_LIM_DB = 100;
const DEFAULT_POST_FILTER_BETA = 0;

/** Empty model bytes select the model embedded in the WASM binary. */
const EMBEDDED_MODEL = new Uint8Array(0);

/**
 * Non-finite input samples become 0 and the others are clamped to ±INPUT_LIMIT before reaching
 * the model: a single NaN, infinity or near-float32-max sample permanently poisons its recurrent
 * state (every later output is NaN), and a finite outlier of 1e6 still degrades it for ~4 s.
 * The limit (+24 dBFS) is far above real audio levels and harmless as an isolated outlier.
 */
const INPUT_LIMIT = 16;

/**
 * DeepFilterNet3 for one 48 kHz channel. Each {@link process} call consumes {@link hop} samples
 * and returns the speech estimate of the samples it received {@link delay} samples earlier:
 * output sample j of call k estimates input sample `hop · k + j − delay` (0 before the start).
 *
 * All instances of a JS realm share one WASM instance; each owns its model state (~300 ms to
 * create, so reuse it rather than re-creating it on discontinuities).
 */
export class Dfn {
  /** Samples consumed and produced per {@link process} call (480 = 10 ms). */
  readonly hop: number;
  /** Algorithmic delay in samples (1440 = 30 ms). */
  readonly delay: number = DFN_DELAY;

  readonly #state: number;
  readonly #sanitized: Float32Array;

  private constructor(state: number) {
    this.#state = state;
    this.hop = df_get_frame_length(state);
    this.#sanitized = new Float32Array(this.hop);
  }

  /**
   * Instantiates the WASM (once per JS realm; later calls reuse the first instance) and creates a
   * model state. Synchronous: pass a precompiled `WebAssembly.Module` (e.g. from
   * `WebAssembly.compileStreaming`), or bytes in a worker or Node (Chrome refuses to compile
   * modules over 8 MB synchronously on the main thread).
   */
  static create(wasm: BufferSource | WebAssembly.Module, opts: DfnOptions = {}): Dfn {
    initSync({ module: wasm });
    const dfn = new Dfn(df_create(EMBEDDED_MODEL, opts.attenLimDb ?? DEFAULT_ATTEN_LIM_DB));
    dfn.setPostFilterBeta(opts.postFilterBeta ?? DEFAULT_POST_FILTER_BETA);
    return dfn;
  }

  /**
   * Processes one hop of `input` (exactly {@link hop} samples) and writes the speech estimate to
   * `out`, which may be `input` itself; a new array is returned when `out` is omitted. `input` is
   * not modified unless it is `out`. Throws a RangeError on a wrong length, and whatever the WASM
   * throws (a WebAssembly.RuntimeError) if it panics; the state stays usable afterwards.
   */
  process(input: Float32Array, out?: Float32Array): Float32Array {
    const hop = this.hop;
    if (input.length !== hop || (out !== undefined && out.length !== hop)) {
      throw new RangeError(`Dfn.process expects ${hop} samples (input ${input.length}, output ${out?.length ?? hop})`);
    }
    const result = df_process_frame(this.#state, isSafe(input) ? input : this.#sanitize(input));
    if (out === undefined) return result;
    out.set(result);
    return out;
  }

  /** Changes the maximum attenuation (dB) without resetting the model state. */
  setAttenLimDb(db: number): void {
    df_set_atten_lim(this.#state, db);
  }

  /** Changes the post-filter strength (0 disables it) without resetting the model state. */
  setPostFilterBeta(beta: number): void {
    df_set_post_filter_beta(this.#state, beta);
  }

  #sanitize(input: Float32Array): Float32Array {
    const dst = this.#sanitized;
    for (let i = 0; i < input.length; i++) {
      const v = input[i]!;
      dst[i] = Number.isFinite(v) ? Math.min(INPUT_LIMIT, Math.max(-INPUT_LIMIT, v)) : 0;
    }
    return dst;
  }
}

/** True when every sample is finite and within ±INPUT_LIMIT. */
function isSafe(samples: Float32Array): boolean {
  for (let i = 0; i < samples.length; i++) {
    if (!(Math.abs(samples[i]!) <= INPUT_LIMIT)) return false;
  }
  return true;
}
