// AudioWorklet module ('bgmr-mixer'): a thin wrapper that wires MessagePorts to MixerCore.
// Loaded by web pages (content scripts) and by the offscreen document.
import { MixerCore, type MixerPorts } from '@/lib/mixer/mixer-core';
import type { LaFromWorker, RtFromWorker, ToMixer } from '@/lib/protocol';

declare const AudioWorkletProcessor: { new (): { readonly port: MessagePort } };
declare function registerProcessor(name: string, ctor: unknown): void;

/** `processorOptions.jitter`: initial jitter allowance in frames (MixerCore clamps it). */
function initialJitter(options: AudioWorkletNodeOptions | undefined): number | undefined {
  const processorOptions: unknown = options?.processorOptions;
  if (typeof processorOptions !== 'object' || processorOptions === null) return undefined;
  const jitter: unknown = (processorOptions as { jitter?: unknown }).jitter;
  return typeof jitter === 'number' ? jitter : undefined;
}

export default defineUnlistedScript(() => {
  class MixerProcessor extends AudioWorkletProcessor {
    private rt: MessagePort | null = null;
    private la: MessagePort | null = null;
    private readonly core: MixerCore;

    constructor(options?: AudioWorkletNodeOptions) {
      super();
      const ports: MixerPorts = {
        postRt: (msg, transfer) => this.rt?.postMessage(msg, transfer ?? []),
        postLa: (msg, transfer) => this.la?.postMessage(msg, transfer ?? []),
        postMain: (msg, transfer) => this.port.postMessage(msg, transfer ?? []),
      };
      this.core = new MixerCore(ports, { jitter: initialJitter(options) });
      this.port.onmessage = (e: MessageEvent<ToMixer>) => {
        const msg = e.data;
        if (msg.type === 'connect-rt' && e.ports[0]) {
          this.rt?.close();
          this.rt = e.ports[0];
          this.rt.onmessage = (m: MessageEvent<RtFromWorker>) => this.core.onRt(m.data);
          this.core.setRtConnected(true);
        } else if (msg.type === 'connect-la' && e.ports[0]) {
          this.la?.close();
          this.la = e.ports[0];
          this.la.onmessage = (m: MessageEvent<LaFromWorker>) => this.core.onLa(m.data);
          this.core.setLaConnected(true);
        } else {
          this.core.onMain(msg);
        }
      };
    }

    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const out = outputs[0];
      if (out) this.core.process(inputs[0], out);
      return true;
    }
  }
  registerProcessor('bgmr-mixer', MixerProcessor);
});
