// Engine iframe helpers: the token-checked control handshake, the merged real-time status, the
// real-time worker's replacement and worker URLs under the dev server.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectGate } from '../../src/entrypoints/engine/connect-gate';
import type { FromRealtimeWorker, ToRealtimeWorker } from '../../src/entrypoints/engine/messages';
import { RealtimeHost, type RealtimeWorkerLike } from '../../src/entrypoints/engine/realtime-host';
import { RealtimeStatusTracker } from '../../src/entrypoints/engine/realtime-status';
import { workerUrl } from '../../src/entrypoints/engine/worker-url';

/** Stand-in for a MessagePort that records close(). */
function port(name: string): MessagePort & { name: string; closed: boolean } {
  const p = { name, closed: false, close: () => void (p.closed = true) };
  return p as unknown as MessagePort & { name: string; closed: boolean };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ConnectGate', () => {
  it('accepts the first CONNECT whose token the background verifies, and refuses all others', async () => {
    const asked: string[] = [];
    const accepted: string[] = [];
    let answer!: (ok: boolean) => void;
    const gate = new ConnectGate(
      (token) => {
        asked.push(token);
        // The page's token is unknown to the background; the controller's one is answered later.
        return token === 'good' ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(false);
      },
      (p) => accepted.push((p as unknown as { name: string }).name),
    );
    const page = port('page');
    const controller = port('controller');
    const noToken = port('no token');
    gate.offer('forged', page);
    gate.offer(undefined, noToken);
    gate.offer('good', controller);
    await tick();
    expect(asked).toEqual(['forged', 'good']);
    expect(page.closed).toBe(true);
    expect(noToken.closed).toBe(true);
    expect(accepted).toEqual([]);
    answer(true);
    await tick();
    expect(accepted).toEqual(['controller']);
    expect(controller.closed).toBe(false);
    // Once connected, later CONNECTs (even with a valid token) are refused without asking.
    const late = port('late');
    gate.offer('good', late);
    await tick();
    expect(late.closed).toBe(true);
    expect(asked).toEqual(['forged', 'good']);
  });

  it('refuses the port when the background cannot be reached', async () => {
    const accepted: MessagePort[] = [];
    const gate = new ConnectGate(() => Promise.reject(new Error('Receiving end does not exist.')), (p) => accepted.push(p));
    const p = port('controller');
    gate.offer('token', p);
    await tick();
    expect(p.closed).toBe(true);
    expect(accepted).toEqual([]);
  });
});

describe('RealtimeStatusTracker', () => {
  it('keeps a model error until 15 clean reports in a row, and keeps the last rtf', () => {
    const rt = new RealtimeStatusTracker();
    expect(rt.current).toEqual({ ready: false });
    rt.report({ ready: true });
    rt.report({ ready: true, rtf: 0.2 });
    expect(rt.current).toEqual({ ready: true, rtf: 0.2 });
    rt.report({ ready: true, error: 'DeepFilterNet failed: unreachable' });
    expect(rt.current).toEqual({ ready: true, rtf: 0.2, error: 'DeepFilterNet failed: unreachable' });
    for (let i = 0; i < 14; i++) rt.report({ ready: true, rtf: 0.3 });
    expect(rt.current.error).toBe('DeepFilterNet failed: unreachable');
    // A new error restarts the count.
    rt.report({ ready: true, error: 'DeepFilterNet failed: unreachable' });
    for (let i = 0; i < 14; i++) rt.report({ ready: true, rtf: 0.3 });
    expect(rt.current.error).toBe('DeepFilterNet failed: unreachable');
    rt.report({ ready: true, rtf: 0.25 });
    expect(rt.current).toEqual({ ready: true, rtf: 0.25 });
  });

  it('reports a start failure', () => {
    const rt = new RealtimeStatusTracker();
    rt.report({ ready: false, error: 'Could not load the real-time model (HTTP 404).' });
    expect(rt.current).toEqual({ ready: false, error: 'Could not load the real-time model (HTTP 404).' });
  });
});

/** A Worker stand-in recording what it was sent. */
class FakeWorker implements RealtimeWorkerLike {
  onmessage: ((e: MessageEvent<FromRealtimeWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  sent: { msg: ToRealtimeWorker; transfer: Transferable[] }[] = [];
  terminated = false;
  postMessage(msg: ToRealtimeWorker, transfer: Transferable[]): void {
    this.sent.push({ msg, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  report(data: Omit<FromRealtimeWorker, 'type'>): void {
    this.onmessage?.({ data: { type: 'rt-status', ...data } } as MessageEvent<FromRealtimeWorker>);
  }
}

describe('RealtimeHost', () => {
  it('replaces the worker on restart: the new one gets the port, the old one is terminated and no longer heard', () => {
    const workers: FakeWorker[] = [];
    let updates = 0;
    const host = new RealtimeHost(
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      () => updates++,
    );
    host.start();
    host.start();
    expect(workers).toHaveLength(1);
    const first = port('rt 1');
    host.connect(first);
    expect(workers[0]!.sent).toEqual([{ msg: { type: 'connect' }, transfer: [first] }]);
    workers[0]!.report({ ready: true, rtf: 0.2 });
    expect(host.status).toEqual({ ready: true, rtf: 0.2 });

    // The worker stopped answering: the controller sends 'restart-realtime' with a new port.
    const second = port('rt 2');
    const before = updates;
    host.restart(second);
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.sent).toEqual([{ msg: { type: 'connect' }, transfer: [second] }]);
    expect(host.status).toEqual({ ready: false });
    expect(updates).toBeGreaterThan(before);
    workers[0]!.report({ ready: true, error: 'late message of the old worker' });
    expect(host.status).toEqual({ ready: false });
    workers[1]!.report({ ready: true });
    expect(host.status).toEqual({ ready: true });

    // Without a worker, ports are closed.
    host.stop();
    expect(workers[1]!.terminated).toBe(true);
    const late = port('late');
    host.connect(late);
    expect(late.closed).toBe(true);
  });

  it('reports a worker that fails to start', () => {
    const worker = new FakeWorker();
    const host = new RealtimeHost(() => worker, () => {});
    host.start();
    worker.onerror?.({ message: '' } as ErrorEvent);
    expect(host.status).toEqual({ ready: false, error: 'The real-time model failed to start.' });
  });
});

describe('workerUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts same-origin workers directly, and dev-server workers through a same-origin module that imports them', async () => {
    vi.stubGlobal('location', { origin: 'chrome-extension://abc' });
    // Build: the worker chunk is part of the extension.
    expect(workerUrl('/assets/realtime.worker-x.js', 'chrome-extension://abc/chunks/engine.js')).toBe('chrome-extension://abc/assets/realtime.worker-x.js');
    // `pnpm dev`: Vite serves it from localhost.
    const url = workerUrl('/src/entrypoints/engine/realtime.worker.ts?worker_file&type=module', 'http://localhost:3000/src/entrypoints/engine/main.ts');
    expect(url.startsWith('blob:')).toBe(true);
    const source = await (await fetch(url)).text();
    expect(source).toContain('import "http://localhost:3000/src/entrypoints/engine/realtime.worker.ts?worker_file&type=module";');
    expect(source).toContain('URL.revokeObjectURL(import.meta.url)');
    URL.revokeObjectURL(url);
  });
});
