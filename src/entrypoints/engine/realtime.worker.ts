// Real-time model worker: DeepFilterNet3 on the CPU. Speaks RtToWorker/RtFromWorker with the
// worklet over a transferred MessagePort; reports readiness and speed to the hosting page. The
// model loads as soon as the worker starts, while the engine connects the worklet.
import type { RtToWorker } from '@/lib/protocol';
import { Dfn } from '@/lib/realtime/dfn';
import { RtProcessor } from '@/lib/realtime/rt-processor';
import type { FromRealtimeWorker, ToRealtimeWorker } from './messages';

const report = (msg: FromRealtimeWorker) => (self as unknown as Worker).postMessage(msg);
let dfn: Promise<Dfn> | null = null;
/** The model state is shared, so only one worklet connection is fed at a time. */
let current: MessagePort | null = null;

function loadDfn(): Promise<Dfn> {
  dfn ??= (async () => {
    const res = await fetch(new URL('/dfn/df_bg.wasm', self.location.origin));
    if (!res.ok) throw new Error(`Could not load the real-time model (HTTP ${res.status}).`);
    const module = await WebAssembly.compileStreaming(res);
    return Dfn.create(module);
  })();
  return dfn;
}

void loadDfn().catch(() => {});

self.onmessage = async (e: MessageEvent<ToRealtimeWorker>) => {
  if (e.data?.type !== 'connect' || !e.ports[0]) return;
  const port = e.ports[0];
  current?.close();
  current = port;
  try {
    const model = await loadDfn();
    const processor = new RtProcessor(model, (msg, transfer) => {
      port.postMessage(msg, transfer ?? []);
      // The processor keeps answering after a model error (with the input unchanged).
      if (msg.type === 'stats') report({ type: 'rt-status', ready: true, rtf: msg.rtf });
      else if (msg.type === 'error') report({ type: 'rt-status', ready: true, error: msg.message });
    });
    port.onmessage = (m: MessageEvent<RtToWorker>) => processor.onMessage(m.data);
    port.postMessage({ type: 'ready' });
    report({ type: 'rt-status', ready: true });
  } catch (err) {
    // Hops sent to a closed port are dropped instead of queuing up here.
    port.close();
    report({ type: 'rt-status', ready: false, error: err instanceof Error ? err.message : String(err) });
  }
};
