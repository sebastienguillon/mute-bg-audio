// The engine's real-time worker: started on 'init', connected to the worklet, replaced when it
// stopped answering ('restart-realtime'), with its merged status (RealtimeStatusTracker).
import type { FromRealtimeWorker, ToRealtimeWorker } from './messages';
import { RealtimeStatusTracker, type RealtimeStatus } from './realtime-status';

/** The parts of a Worker the host uses. */
export interface RealtimeWorkerLike {
  onmessage: ((e: MessageEvent<FromRealtimeWorker>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  postMessage(msg: ToRealtimeWorker, transfer: Transferable[]): void;
  terminate(): void;
}

export class RealtimeHost {
  private readonly create: () => RealtimeWorkerLike;
  private readonly onStatus: () => void;
  private readonly tracker = new RealtimeStatusTracker();
  private worker: RealtimeWorkerLike | null = null;

  /** `onStatus` is called whenever `status` may have changed. */
  constructor(create: () => RealtimeWorkerLike, onStatus: () => void) {
    this.create = create;
    this.onStatus = onStatus;
  }

  get status(): RealtimeStatus {
    return this.tracker.current;
  }

  /** Starts the worker unless it runs. */
  start(): void {
    if (this.worker) return;
    const worker = this.create();
    this.worker = worker;
    // A replaced worker's last messages are ignored.
    worker.onmessage = (e) => {
      if (this.worker !== worker) return;
      this.tracker.report({ ready: e.data.ready, rtf: e.data.rtf, error: e.data.error });
      this.onStatus();
    };
    worker.onerror = (e) => {
      if (this.worker !== worker) return;
      this.tracker.report({ ready: false, error: e.message || 'The real-time model failed to start.' });
      this.onStatus();
    };
  }

  /** Gives the worker the worklet's end of a channel (closed when no worker runs). */
  connect(port: MessagePort): void {
    if (this.worker) this.worker.postMessage({ type: 'connect' }, [port]);
    else port.close();
  }

  /** Replaces the worker with a new one, connected to `port`: not ready until it reports. */
  restart(port: MessagePort | undefined): void {
    this.stop();
    this.tracker.reset();
    this.onStatus();
    this.start();
    if (port) this.connect(port);
  }

  stop(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
