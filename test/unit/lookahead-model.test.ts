// The look-ahead core with the real Kim_Vocal_2 model (onnxruntime-node, CPU EP): processes 20 s
// ahead of the playhead from YouTube-like WebM appends. Skipped when the model file is missing
// (run `pnpm fetch-models`).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MDX_MODELS, type MdxBackend } from '../../src/lib/mdx/mdx';
import {
  ROOT,
  SR,
  blockSpan,
  createHarness,
  fakeDecoderFactory,
  fixturePath,
  readFixtureWav,
  sbAdd,
  siSdr,
  waitFor,
  webmAppends,
} from './helpers/lookahead-media';

const MODEL = MDX_MODELS.Kim_Vocal_2;
const MODEL_PATH = join(ROOT, 'public/models', MODEL.file);
const AHEAD = 20;

async function onnxBackend(): Promise<{ backend: MdxBackend; runs: number[] }> {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(MODEL_PATH, { executionProviders: ['cpu'] });
  const input = session.inputNames[0]!;
  const output = session.outputNames[0]!;
  const runs: number[] = [];
  return {
    runs,
    backend: {
      run: async (data) => {
        const t = performance.now();
        const result = await session.run({ [input]: new ort.Tensor('float32', data, [1, 4, MODEL.dimF, MODEL.dimT]) });
        runs.push(performance.now() - t);
        return result[output]!.data as Float32Array;
      },
    },
  };
}

describe('LookaheadCore with Kim_Vocal_2', () => {
  it.skipIf(!existsSync(MODEL_PATH))(
    `processes ${AHEAD} s ahead of the playhead`,
    async () => {
      const mix = readFixtureWav('mix.wav');
      const speech = readFixtureWav('speech.wav');
      const music = readFixtureWav('music.wav');
      const webm = new Uint8Array(readFileSync(fixturePath('mix.webm')));
      const { backend, runs } = await onnxBackend();
      // The CPU backend of onnxruntime-node is not what the speed guard is for (it may be slow on a busy machine).
      const h = createHarness({ decoderFactory: fakeDecoderFactory(mix), backend, model: MODEL, aheadSeconds: AHEAD, now: () => performance.now(), maxRtf: Infinity });
      const t0 = performance.now();
      h.core.setActiveTimeline(1);
      h.core.onHook(sbAdd(1, 1));
      for (const msg of webmAppends(1, 1, webm)) h.core.onHook(msg);
      h.core.setPlayhead({ time: 0, paused: true, rate: 1, seeking: false, audible: true, at: performance.now() });
      await waitFor(() => h.blocks().length > 0, 60_000, 'first block');
      const firstBlockMs = performance.now() - t0;
      await waitFor(() => h.blockEnd(1) >= AHEAD * SR, 300_000, `${AHEAD} s of blocks`);
      const wallMs = performance.now() - t0;
      const blocks = h.blocks(1);
      const span = blockSpan(blocks)!;
      expect(span.start).toBe(0);
      expect(span.contiguous).toBe(true);

      // Separation quality over the processed region (speech starts at 1.5 s).
      const n = AHEAD * SR;
      const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      for (const b of blocks) {
        const len = Math.min(b.speechL.length, n - b.start);
        if (len <= 0) continue;
        out[0]!.set(b.speechL.subarray(0, len), b.start);
        out[1]!.set(b.speechR.subarray(0, len), b.start);
        out[2]!.set(b.residualL.subarray(0, len), b.start);
        out[3]!.set(b.residualR.subarray(0, len), b.start);
      }
      const from = 1.5 * SR;
      const speechSdr = (siSdr(out[0]!, speech.channels[0]!, from, n) + siSdr(out[1]!, speech.channels[1]!, from, n)) / 2;
      const musicSdr = (siSdr(out[2]!, music.channels[0]!, from, n) + siSdr(out[3]!, music.channels[1]!, from, n)) / 2;
      const baseline = (siSdr(mix.channels[0]!, speech.channels[0]!, from, n) + siSdr(mix.channels[1]!, speech.channels[1]!, from, n)) / 2;
      expect(speechSdr).toBeGreaterThan(baseline + 10);
      expect(musicSdr).toBeGreaterThan(10);
      const status = h.statuses[h.statuses.length - 1];
      console.log(
        [
          `Kim_Vocal_2 (onnxruntime-node CPU): ${(span.end / SR).toFixed(2)} s ahead in ${blocks.length} blocks, ` +
            `wall ${(wallMs / 1000).toFixed(2)} s (first block after ${(firstBlockMs / 1000).toFixed(2)} s)`,
          `  model runs: ${runs.map((t) => t.toFixed(0)).join(', ')} ms; status ${JSON.stringify(status)}`,
          `  SI-SDR speech ${speechSdr.toFixed(2)} dB (mix ${baseline.toFixed(2)} dB), residual vs music ${musicSdr.toFixed(2)} dB`,
        ].join('\n'),
      );
      h.core.dispose();
    },
    600_000,
  );
});
