#!/usr/bin/env node
// Benchmarks the DSP primitives and the JavaScript side of MdxStream (identity model) for both
// look-ahead models, and optionally a real model on onnxruntime-node's CPU EP.
//
// Usage: node scripts/bench-mdx.mjs [--model Kim_Vocal_2|UVR-MDX-NET-Voc_FT|SCNet]
import { build } from 'esbuild';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argModel = process.argv.indexOf('--model');
const modelName = argModel > 0 ? process.argv[argModel + 1] : null;

// Bundle the TypeScript library code into a temporary ES module.
const outDir = mkdtempSync(join(tmpdir(), 'bench-mdx-'));
const outfile = join(outDir, 'lib.mjs');
await build({
  stdin: {
    contents: ['fft', 'stft', 'resample', 'align'].map((m) => `export * from './src/lib/dsp/${m}';`).join('\n') +
      "\nexport * from './src/lib/mdx/mdx';\nexport * from './src/lib/mdx/mdx-stream';\nexport * from './src/lib/lookahead/models';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'warning',
});
const lib = await import(pathToFileURL(outfile).href);
rmSync(outDir, { recursive: true, force: true });

/** Median of `runs` timings (ms) after one warm-up call. */
function bench(fn, runs = 7) {
  fn();
  const t = [];
  for (let r = 0; r < runs; r++) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return t.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

function noise(n, seed = 1) {
  let s = seed;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = (s / 4294967296 - 0.5) * 0.8;
  }
  return out;
}

const rows = [];
const report = (name, value) => rows.push([name, value]);

// FFT
for (const n of [3840, 7680, 65536, 1 << 18]) {
  const rfft = new lib.RealFFT(n);
  const x = noise(n);
  const re = new Float64Array(rfft.bins);
  const im = new Float64Array(rfft.bins);
  const reps = Math.max(1, Math.round(4e6 / n));
  report(`RealFFT(${n}) forward`, `${((bench(() => { for (let r = 0; r < reps; r++) rfft.forward(x, re, im); }) / reps) * 1000).toFixed(1)} µs`);
}

// STFT / codecs
for (const model of [lib.KIM_VOCAL_2, lib.SCNET]) {
  const codec = model.createCodec();
  const chunkL = noise(codec.chunkSize, 2);
  const chunkR = noise(codec.chunkSize, 3);
  const tensor = codec.encode(chunkL, chunkR);
  report(`${model.name} codec encode (stereo chunk)`, `${bench(() => codec.encode(chunkL, chunkR)).toFixed(1)} ms`);
  report(`${model.name} codec decode (stereo chunk)`, `${bench(() => codec.decode(tensor)).toFixed(1)} ms`);
}

// Resampler
const sec = 10;
const in48 = noise(48000 * sec, 4);
const out44 = new Float32Array(44100 * sec);
const out48 = new Float32Array(48000 * sec);
const down = bench(() => lib.resampleRange(in48, 0, 48000, 44100, 0, out44.length, out44), 5);
const up = bench(() => lib.resampleRange(out44, 0, 44100, 48000, 0, out48.length, out48), 5);
report('resample 48k->44.1k (stereo)', `${((sec * 1000) / (2 * down)).toFixed(0)}x real time`);
report('resample 44.1k->48k (stereo)', `${((sec * 1000) / (2 * up)).toFixed(0)}x real time`);

// Alignment
const ref = noise(200000, 5);
const probe = ref.slice(123456, 123456 + 4096);
report('alignProbe 4096 vs 200000', `${bench(() => lib.alignProbe(probe, ref), 15).toFixed(2)} ms`);

// MdxStream JS overhead (identity model)
/** Audio finalized per chunk (after the first), in seconds. */
const stepSeconds = (model) => Math.floor((1 - model.stream.overlap) * model.chunkSize) / model.sampleRate;
async function streamChunks(model, backend, seconds, onChunk) {
  const n = 48000 * seconds;
  const left = noise(n, 6);
  const right = noise(n, 7);
  const stream = lib.createModelStream(model, backend);
  stream.reset(0);
  const slice = (x, s, e) => {
    const o = new Float32Array(e - s);
    const a = Math.max(0, s), b = Math.min(x.length, e);
    if (b > a) o.set(x.subarray(a, b), a - s);
    return o;
  };
  while (stream.finalizedEnd < n) {
    const { start, end } = stream.nextInputRange();
    const l = slice(left, start, end);
    const r = slice(right, start, end);
    const t = performance.now();
    await stream.processNext(l, r);
    onChunk(performance.now() - t);
  }
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
for (const model of [lib.KIM_VOCAL_2, lib.SCNET]) {
  const identityTimes = [];
  await streamChunks(model, { run: async (x) => x }, 40, (t) => identityTimes.push(t));
  identityTimes.shift(); // warm-up
  report(
    `${model.name} MdxStream JS per chunk (identity model)`,
    `${mean(identityTimes).toFixed(0)} ms mean, ${Math.max(...identityTimes).toFixed(0)} ms max (chunk step = ${stepSeconds(model).toFixed(2)} s of audio)`,
  );
}

if (modelName) {
  const models = { Kim_Vocal_2: lib.KIM_VOCAL_2, 'UVR-MDX-NET-Voc_FT': lib.mdxModel('UVR-MDX-NET-Voc_FT'), SCNet: lib.SCNET };
  const model = models[modelName];
  if (!model) throw new Error(`--model must be one of ${Object.keys(models).join(', ')}`);
  // The packaged models are in public/models, the comparison model in .cache/models (fetch-models --all).
  const path = ['public/models', '.cache/models'].map((dir) => join(root, dir, model.file)).find((p) => existsSync(p));
  if (!path) throw new Error(`missing ${model.file} (run pnpm fetch-models --all)`);
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(path, { executionProviders: ['cpu'] });
  const modelTimes = [];
  const totals = [];
  const backend = {
    run: async (data) => {
      const t = performance.now();
      const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, model.dims) });
      modelTimes.push(performance.now() - t);
      return res[session.outputNames[0]].data;
    },
  };
  await streamChunks(model, backend, 30, (t) => totals.push(t));
  report(`${modelName} model run, CPU EP`, `${mean(modelTimes).toFixed(0)} ms mean per chunk`);
  report(`${modelName} JS overhead per chunk`, `${mean(totals.map((t, i) => t - modelTimes[i])).toFixed(0)} ms mean`);
  report(`${modelName} real-time factor (CPU)`, `${(mean(totals) / (stepSeconds(model) * 1000)).toFixed(3)}`);
}

const width = Math.max(...rows.map(([n]) => n.length));
for (const [name, value] of rows) console.log(`${name.padEnd(width)}  ${value}`);
