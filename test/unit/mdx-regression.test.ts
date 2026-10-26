// Regression of the Kim_Vocal_2 path: the model-agnostic stream (createModelStream(KIM_VOCAL_2))
// gives bit-identical model inputs and vocals to the MDX-only implementation it replaced
// (MdxStream(MDX_MODELS.Kim_Vocal_2, backend)). The hashes were recorded with that code; an intended
// change of the Kim path records them again.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createModelStream, KIM_VOCAL_2 } from '../../src/lib/lookahead/models';
import type { MdxBackend } from '../../src/lib/mdx/mdx';
import { noise, sliceZeroFilled } from './helpers/dsp-audio';

/** Noise with slow envelopes plus tones (48 kHz stereo), with 8 s of silence from 6 s on. */
function regressionSignal(seconds: number): [Float32Array, Float32Array] {
  const n = seconds * 48000;
  const left = noise(n, 0.4, 11);
  const right = noise(n, 0.4, 12);
  for (let i = 0; i < n; i++) {
    const t = i / 48000;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.3 * t);
    left[i] = left[i]! * env + 0.3 * Math.sin(2 * Math.PI * 220 * t);
    right[i] = right[i]! * (1 - env) + 0.2 * Math.sin(2 * Math.PI * 330 * t + 1);
  }
  // 8 s of silence: the stream skips the model for the chunks inside it.
  left.fill(0, 6 * 48000, 14 * 48000);
  right.fill(0, 6 * 48000, 14 * 48000);
  return [left, right];
}

const hex = (a: Float32Array) => createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex');

describe('Kim_Vocal_2 stream regression', () => {
  it('is bit-identical to the implementation before the model abstraction', async () => {
    const tensors: string[] = [];
    // Identity model: the vocals are the model input, so the output covers encode, decode,
    // peak normalisation, overlap-add and both resamplings.
    const backend: MdxBackend = {
      run: async (input) => {
        tensors.push(hex(input).slice(0, 16));
        return input;
      },
    };
    const [left, right] = regressionSignal(20);
    const stream = createModelStream(KIM_VOCAL_2, backend);
    stream.reset(1234);
    const out = createHash('sha256');
    while (stream.finalizedEnd < left.length) {
      const { start, end } = stream.nextInputRange();
      const block = await stream.processNext(sliceZeroFilled(left, start, end), sliceZeroFilled(right, start, end));
      if (!block) continue;
      out.update(new Uint8Array(block.vocalsL.buffer));
      out.update(new Uint8Array(block.vocalsR.buffer));
    }
    expect(tensors).toEqual(['a08dbe056f6d2cdc', 'fe0f2c179dc2da46', '691982bb5846cf22', 'b71849aa755d853f', 'e8411a30a1db1541']);
    expect(out.digest('hex')).toBe('206ead3c0864cdaaf10ab5a80530904d36100cbf93eb148127e5e201d53aaf4f');
  });
});
