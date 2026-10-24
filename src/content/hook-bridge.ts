// ISOLATED-world end of the MAIN-world MediaSource hook (see entrypoints/youtube-hook.content.ts).
import { HOOK_HANDSHAKE, type HookMessage } from '@/lib/protocol';

export class HookBridge {
  private constructor(private readonly port: MessagePort) {}

  /** Connects to the hook; it replays the init segments and recent appends it kept. */
  static connect(onMessage: (msg: HookMessage) => void): HookBridge {
    const channel = new MessageChannel();
    channel.port1.onmessage = (e: MessageEvent<HookMessage>) => {
      if (e.data && typeof e.data.type === 'string') onMessage(e.data);
    };
    window.postMessage({ [HOOK_HANDSHAKE]: true }, '*', [channel.port2]);
    return new HookBridge(channel.port1);
  }

  close(): void {
    this.port.onmessage = null;
    this.port.close();
  }
}
