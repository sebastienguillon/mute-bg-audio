// Engine iframe (extension origin). Hosts the model workers for one page and relays control
// messages from the page controller. Audio itself flows worklet ⇄ workers directly.
import type { EngineIn, EngineOut, LookaheadStatus, RuntimeMessage } from '@/lib/protocol';
import { ConnectGate } from './connect-gate';
import lookaheadWorkerUrl from './lookahead.worker.ts?worker&url';
import type { FromLookaheadWorker, ToLookaheadWorker } from './messages';
import { RealtimeHost } from './realtime-host';
import realtimeWorkerUrl from './realtime.worker.ts?worker&url';
import { workerUrl } from './worker-url';

const HELLO = 'bgmr-engine-hello';
const CONNECT = 'bgmr-engine-connect';

let ctl: MessagePort | null = null;
let laWorker: Worker | null = null;
const rt = new RealtimeHost(() => new Worker(workerUrl(realtimeWorkerUrl, import.meta.url), { type: 'module' }), scheduleStatus);
let la: LookaheadStatus = { state: 'off' };
let lastStatus = '';
let statusTimer: ReturnType<typeof setTimeout> | null = null;

const post = (msg: EngineOut) => ctl?.postMessage(msg);

function postLa(msg: ToLookaheadWorker, transfer: Transferable[] = []) {
  laWorker?.postMessage(msg, transfer);
}

function scheduleStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    const json = JSON.stringify([rt.status, la]);
    if (json === lastStatus) return;
    lastStatus = json;
    post({ type: 'status', realtime: rt.status, lookahead: la });
  }, 250);
}

function startLookahead(msg: Extract<EngineIn, { type: 'init' }>) {
  if (laWorker || !msg.lookahead) return;
  laWorker = new Worker(workerUrl(lookaheadWorkerUrl, import.meta.url), { type: 'module' });
  laWorker.onmessage = (e: MessageEvent<FromLookaheadWorker>) => {
    la = e.data.status;
    scheduleStatus();
  };
  laWorker.onerror = (e) => {
    la = { state: 'error', reason: e.message || 'The look-ahead model failed to start.' };
    scheduleStatus();
  };
  postLa({ type: 'init', settings: msg.settings });
}

async function gpuName(): Promise<string | null> {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) return null;
    const info = adapter.info;
    return [info.vendor, info.architecture].filter(Boolean).join(' ') || 'WebGPU';
  } catch {
    return null;
  }
}

function onControl(msg: EngineIn, ports: readonly MessagePort[]) {
  switch (msg.type) {
    case 'init':
      rt.start();
      startLookahead(msg);
      void gpuName().then((gpu) => post({ type: 'ready', gpu }));
      break;
    case 'settings':
      postLa({ type: 'settings', settings: msg.settings });
      break;
    case 'connect-worklet': {
      const [rtPort, laPort] = ports;
      if (rtPort) rt.connect(rtPort);
      if (laPort) {
        if (laWorker) postLa({ type: 'connect' }, [laPort]);
        else laPort.close();
      }
      break;
    }
    case 'restart-realtime':
      // The look-ahead worker and its connection stay.
      rt.restart(ports[0]);
      break;
    case 'hook':
      postLa(msg, msg.message.type === 'sb-append' ? [msg.message.data] : []);
      break;
    case 'active-timeline':
    case 'playhead':
      postLa(msg);
      break;
    case 'dispose':
      rt.stop();
      laWorker?.terminate();
      laWorker = null;
      ctl?.close();
      ctl = null;
      break;
  }
}

/** Asks the background whether the token was issued to a content script of this tab. */
async function verifyToken(token: string): Promise<boolean> {
  const reply = (await browser.runtime.sendMessage({ type: 'engine-verify', token } satisfies RuntimeMessage)) as { ok?: unknown } | undefined;
  return reply?.ok === true;
}

const gate = new ConnectGate(verifyToken, (port) => {
  ctl = port;
  ctl.onmessage = (m: MessageEvent<EngineIn>) => onControl(m.data, m.ports);
});

window.addEventListener('message', (e) => {
  const port = e.ports[0];
  if (e.source !== window.parent || e.data?.type !== CONNECT || !port) return;
  gate.offer(e.data.token, port);
});
window.parent.postMessage({ type: HELLO }, '*');
