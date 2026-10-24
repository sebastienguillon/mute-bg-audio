// Creates the hidden engine iframe (extension origin) and opens a private control channel to it.
//
// Handshake: the engine posts HELLO to its parent window, the controller answers with CONNECT and
// a MessagePort. Page scripts share that window and see HELLO too, so CONNECT carries a one-time
// token that the controller registered with the background beforehand ('engine-token'); the
// engine has the background verify it ('engine-verify') before accepting the port.
import type { EngineIn, EngineOut } from '@/lib/protocol';

const HELLO = 'bgmr-engine-hello';
const CONNECT = 'bgmr-engine-connect';

/** Registers a token with the background; resolves once it is stored there. */
export type TokenRegistrar = (token: string) => Promise<unknown>;

export class EngineClient {
  private listeners = new Set<(msg: EngineOut) => void>();

  private constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly port: MessagePort,
  ) {
    port.onmessage = (e: MessageEvent<EngineOut>) => {
      for (const l of this.listeners) l(e.data);
    };
  }

  static async create(register: TokenRegistrar, timeoutMs = 20000): Promise<EngineClient> {
    const url = browser.runtime.getURL('/engine.html');
    const origin = new URL(url).origin;
    const token = randomToken();
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText =
      'position:fixed!important;width:0!important;height:0!important;border:0!important;' +
      'visibility:hidden!important;pointer-events:none!important;left:-10px!important;top:-10px!important';
    let cleanup = () => {};
    const hello = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('The processing engine did not start.'));
      }, timeoutMs);
      const onMessage = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow || e.origin !== origin || e.data?.type !== HELLO) return;
        e.stopImmediatePropagation();
        cleanup();
        resolve();
      };
      cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener('message', onMessage, true);
      };
      window.addEventListener('message', onMessage, true);
    });
    // Outside <body>: single-page apps rewrite the body, rarely <html>'s direct children.
    document.documentElement.appendChild(iframe);
    try {
      const [, reply] = await Promise.all([hello, register(token)]);
      if ((reply as { ok?: unknown } | undefined)?.ok === false) throw new Error('The processing engine was refused.');
    } catch (e) {
      cleanup();
      iframe.remove();
      throw e;
    }
    const channel = new MessageChannel();
    iframe.contentWindow!.postMessage({ type: CONNECT, token }, origin, [channel.port2]);
    return new EngineClient(iframe, channel.port1);
  }

  /** False once the page removed the iframe (its workers are gone then). */
  get alive(): boolean {
    return this.iframe.isConnected;
  }

  post(msg: EngineIn, transfer: Transferable[] = []): void {
    this.port.postMessage(msg, transfer);
  }

  onMessage(listener: (msg: EngineOut) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    try {
      this.post({ type: 'dispose' });
    } catch {}
    this.port.onmessage = null;
    this.port.close();
    this.iframe.remove();
    this.listeners.clear();
  }
}

/** 128 random bits as hex (crypto.randomUUID is missing on http: pages, which are not secure contexts). */
function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
