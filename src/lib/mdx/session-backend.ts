/**
 * MdxBackend over a model session (ONNX Runtime in the look-ahead worker) that is created on the
 * first run(), dropped after any failure or on release(), and re-created by the next run(). A
 * creation or run that does not settle in time fails, so a hung GPU cannot stall the processing
 * loop; a run that times out means the device is far too slow (BackendTooSlowError).
 *
 * A session is never released while a run is executing on it: ONNX Runtime frees the session's
 * memory in the shared WASM heap without waiting for its runs. A dropped session is released once
 * its run settles, or never if the run never settles (a leak rather than a use after free). The
 * next run uses a fresh session meanwhile.
 */
import { BackendTooSlowError, type MdxBackend } from './mdx';

/** A loaded model. */
export interface ModelSession {
  /** Same contract as MdxBackend.run. */
  run(input: Float32Array): Promise<Float32Array>;
  /** Frees the session (GPU buffers, weights). Must not be called while a run is executing. */
  release(): Promise<void>;
}

export interface SessionBackendOptions {
  /** Loads the model; rejects with BackendUnavailableError when it can never run here. */
  create: () => Promise<ModelSession>;
  /** A run taking longer than this (ms) fails with BackendTooSlowError and drops the session. */
  runTimeoutMs: number;
  /** Timeout of a session's first run (ms), which compiles the GPU shaders (default runTimeoutMs). */
  firstRunTimeoutMs?: number;
  /** Creating the session taking longer than this (ms) fails. */
  createTimeoutMs: number;
}

class TimeoutError extends Error {
  override name = 'TimeoutError';
}

/** One session and the runs executing on it. */
interface Slot {
  readonly session: Promise<ModelSession>;
  /** Runs started on the session that have not settled yet (even if their caller timed out). */
  active: number;
  /** A run completed: later runs use the normal timeout. */
  warm: boolean;
  /** Dropped: no new runs; released once no run is active. */
  dropped: boolean;
  released: boolean;
}

export class SessionBackend implements MdxBackend {
  private readonly opts: SessionBackendOptions;
  private current: Slot | null = null;
  /** A creation that timed out and may still be running (ONNX Runtime creates one WebGPU session at a time). */
  private lateCreate: Promise<void> | null = null;

  constructor(opts: SessionBackendOptions) {
    this.opts = opts;
  }

  async run(input: Float32Array): Promise<Float32Array> {
    const slot = (this.current ??= this.open());
    let session: ModelSession;
    try {
      session = await slot.session;
    } catch (e) {
      if (this.current === slot) this.current = null;
      throw e;
    }
    // Released (idle, disposed) while it was being created.
    if (slot.dropped) throw new Error('The look-ahead model was released.');
    const { runTimeoutMs, firstRunTimeoutMs = runTimeoutMs } = this.opts;
    slot.active++;
    const running = session.run(input);
    void running
      .catch(() => {})
      .finally(() => {
        slot.active--;
        this.releaseIfIdle(slot);
      });
    try {
      const output = await withTimeout(running, slot.warm ? runTimeoutMs : firstRunTimeoutMs, 'The look-ahead model did not answer in time.');
      slot.warm = true;
      return output;
    } catch (e) {
      this.drop(slot);
      throw e instanceof TimeoutError ? new BackendTooSlowError() : e;
    }
  }

  /** Drops the session; it is freed once no run is executing on it. */
  release(): void {
    if (this.current) this.drop(this.current);
  }

  /** Starts creating a session (after a creation that timed out has settled, or its timeout). */
  private open(): Slot {
    const { create, createTimeoutMs } = this.opts;
    const prior = this.lateCreate;
    const session = (async () => {
      if (prior) await withTimeout(prior, createTimeoutMs, '').catch(() => {});
      const creating = create();
      try {
        return await withTimeout(creating, createTimeoutMs, 'Loading the look-ahead model timed out.', release);
      } catch (e) {
        if (e instanceof TimeoutError) this.noteLateCreate(creating);
        throw e;
      }
    })();
    return { session, active: 0, warm: false, dropped: false, released: false };
  }

  private noteLateCreate(creating: Promise<ModelSession>): void {
    const settled = creating.then(
      () => {},
      () => {},
    );
    this.lateCreate = settled;
    void settled.then(() => {
      if (this.lateCreate === settled) this.lateCreate = null;
    });
  }

  private drop(slot: Slot): void {
    if (this.current === slot) this.current = null;
    slot.dropped = true;
    this.releaseIfIdle(slot);
  }

  private releaseIfIdle(slot: Slot): void {
    if (!slot.dropped || slot.active > 0 || slot.released) return;
    slot.released = true;
    slot.session.then(release, () => {});
  }
}

function release(session: ModelSession): void {
  session.release().catch(() => {});
}

/** `promise`, or a TimeoutError after `ms`; a value arriving after the timeout goes to `onLate`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new TimeoutError(message));
    }, ms);
    promise.then(
      (value) => {
        if (timedOut) onLate?.(value);
        else {
          clearTimeout(timer);
          resolve(value);
        }
      },
      (e: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(e);
      },
    );
  });
}
