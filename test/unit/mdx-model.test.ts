// Separation quality of the real UVR models through MdxStream, with onnxruntime-node (CPU EP).
// Skipped when the model files are missing (run `pnpm fetch-models --all`).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MDX_MODELS, type MdxBackend, type MdxModelName } from '../../src/lib/mdx/mdx';
import { MdxStream } from '../../src/lib/mdx/mdx-stream';
import { ROOT, readFixture, siSdr, sliceZeroFilled } from './helpers/dsp-audio';

const MODELS: MdxModelName[] = ['Kim_Vocal_2', 'UVR-MDX-NET-Voc_FT'];

async function onnxBackend(path: string, dims: number[]): Promise<{ backend: MdxBackend; times: number[] }> {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(path, { executionProviders: ['cpu'] });
  const input = session.inputNames[0]!;
  const output = session.outputNames[0]!;
  const times: number[] = [];
  const backend: MdxBackend = {
    run: async (data) => {
      const t = performance.now();
      const result = await session.run({ [input]: new ort.Tensor('float32', data, dims) });
      times.push(performance.now() - t);
      return result[output]!.data as Float32Array;
    },
  };
  return { backend, times };
}

describe.each(MODELS)('MDX model %s', (name) => {
  const cfg = MDX_MODELS[name];
  // The packaged model is in public/models; the comparison model only in .cache/models (fetch-models --all).
  const path = join(ROOT, name === 'Kim_Vocal_2' ? 'public/models' : '.cache/models', cfg.file);

  it.skipIf(!existsSync(path))(
    'separates speech from music in mix.wav',
    async () => {
      const mix = readFixture('mix.wav').channels;
      const speech = readFixture('speech.wav').channels;
      const music = readFixture('music.wav').channels;
      const n = mix[0]!.length;
      const { backend, times } = await onnxBackend(path, [1, 4, cfg.dimF, cfg.dimT]);
      const stream = new MdxStream(cfg, backend);
      stream.reset(0);
      const vocals = [new Float32Array(n), new Float32Array(n)];
      const totals: number[] = [];
      while (stream.finalizedEnd < n) {
        const { start, end } = stream.nextInputRange();
        const t = performance.now();
        const block = await stream.processNext(sliceZeroFilled(mix[0]!, start, end), sliceZeroFilled(mix[1]!, start, end));
        totals.push(performance.now() - t);
        if (!block) continue;
        const len = Math.min(block.vocalsL.length, n - block.start);
        vocals[0]!.set(block.vocalsL.subarray(0, len), block.start);
        vocals[1]!.set(block.vocalsR.subarray(0, len), block.start);
      }
      const residual = [0, 1].map((c) => mix[c]!.map((v, i) => v - cfg.compensate * vocals[c]![i]!));
      const fmt = (x: number) => x.toFixed(2).padStart(6);
      const lines: string[] = [];
      let vocalGain = 0;
      for (const c of [0, 1]) {
        const baseSpeech = siSdr(mix[c]!, speech[c]!);
        const baseMusic = siSdr(mix[c]!, music[c]!);
        const vs = siSdr(vocals[c]!, speech[c]!);
        const rm = siSdr(residual[c]!, music[c]!);
        vocalGain += vs / 2;
        lines.push(
          `  ${c ? 'R' : 'L'}: vocals vs speech ${fmt(vs)} dB (mix ${fmt(baseSpeech)}), residual vs music ${fmt(rm)} dB (mix ${fmt(baseMusic)})`,
        );
        expect(vs).toBeGreaterThan(10);
        expect(vs - baseSpeech).toBeGreaterThan(8);
        expect(rm).toBeGreaterThan(baseMusic + 5);
      }
      const jsOverhead = totals.map((t, i) => t - (times[i] ?? 0));
      const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
      console.log(
        [
          `${name}: ${totals.length} chunks for ${(n / 48000).toFixed(0)} s, mean SI-SDR vocals ${vocalGain.toFixed(2)} dB`,
          ...lines,
          `  model run (CPU EP) per chunk: ${times.map((t) => t.toFixed(0)).join(', ')} ms`,
          `  JS overhead per chunk (resample + STFT + iSTFT + OLA): mean ${avg(jsOverhead).toFixed(0)} ms, max ${Math.max(...jsOverhead).toFixed(0)} ms`,
        ].join('\n'),
      );
    },
    600_000,
  );
});
