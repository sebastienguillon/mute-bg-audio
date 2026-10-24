import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LATENCY, DFN_DELAY, QUANTUM } from '../../src/lib/constants';
import type { FromMixer, MixerStats, ToMixer } from '../../src/lib/protocol';

/** Minimal AudioWorkletGlobalScope: the processor's port and registerProcessor. */
class FakePort {
  onmessage: ((e: { data: ToMixer; ports: MessagePort[] }) => void) | null = null;
  readonly posted: FromMixer[] = [];
  postMessage(msg: FromMixer): void {
    this.posted.push(msg);
  }
}

interface Processor {
  readonly port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}
type ProcessorClass = new (options?: AudioWorkletNodeOptions) => Processor;

const globals = globalThis as unknown as Record<string, unknown>;
let Mixer: ProcessorClass;

beforeAll(async () => {
  globals.AudioWorkletProcessor = class {
    readonly port = new FakePort();
  };
  globals.registerProcessor = (name: string, ctor: ProcessorClass) => {
    if (name === 'bgmr-mixer') Mixer = ctor;
  };
  const worklet = await import('../../src/entrypoints/worklet');
  worklet.default.main();
});

afterAll(() => {
  delete globals.AudioWorkletProcessor;
  delete globals.registerProcessor;
});

/** Real-time output latency reported by a processor created with `options`. */
function reportedLatency(options?: AudioWorkletNodeOptions): number {
  const node = new Mixer(options);
  const config = { enabled: true, residualGain: 0.5, gapReduction: false, lookahead: false, outputLatency: 0 };
  node.port.onmessage!({ data: { type: 'config', config }, ports: [] });
  const input = [new Float32Array(QUANTUM).fill(0.1), new Float32Array(QUANTUM).fill(0.1)];
  const output = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  for (let q = 0; q < 200; q++) node.process([input], [output]);
  const stats = node.port.posted.flatMap((m): MixerStats[] => (m.type === 'stats' ? [m.stats] : []));
  expect(stats.length).toBeGreaterThan(0);
  return stats.at(-1)!.latency;
}

describe('mixer worklet entry', () => {
  it('passes processorOptions.jitter to the mixer core', () => {
    expect(reportedLatency({ processorOptions: { jitter: 3000 } })).toBe(DFN_DELAY + 3000);
  });

  it('uses the default jitter without valid options', () => {
    expect(reportedLatency()).toBe(DEFAULT_LATENCY);
    expect(reportedLatency({ processorOptions: { jitter: '3000' } })).toBe(DEFAULT_LATENCY);
    expect(reportedLatency({ processorOptions: null })).toBe(DEFAULT_LATENCY);
  });
});
