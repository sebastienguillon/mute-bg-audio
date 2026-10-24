// Real-time model status of the engine, merged from the worker's reports: a model error stays
// visible until the model has run cleanly for a while (the worker reports an error at most every
// 10 s, its stats every second).
import type { EngineOut } from '@/lib/protocol';

export type RealtimeStatus = Extract<EngineOut, { type: 'status' }>['realtime'];

/** Clean reports (stats, about one per second) after which a reported error is cleared. */
const CLEAN_REPORTS_TO_CLEAR = 15;

export class RealtimeStatusTracker {
  private status: RealtimeStatus = { ready: false };
  private clean = 0;

  get current(): RealtimeStatus {
    return this.status;
  }

  /** A new worker replaces the reporting one: not ready, nothing known yet. */
  reset(): void {
    this.status = { ready: false };
    this.clean = 0;
  }

  /** Merges one report of the worker (or of the worker failing to start). */
  report(r: RealtimeStatus): void {
    const rtf = r.rtf ?? this.status.rtf;
    let error = r.error;
    if (error !== undefined) this.clean = 0;
    else if (++this.clean < CLEAN_REPORTS_TO_CLEAR) error = this.status.error;
    this.status = { ready: r.ready, ...(rtf !== undefined ? { rtf } : {}), ...(error !== undefined ? { error } : {}) };
  }
}
