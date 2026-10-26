// Look-ahead model worker: decodes the audio YouTube buffered ahead of the playhead (WebCodecs),
// separates speech with the build's vocal model (Kim_Vocal_2 or SCNet; ONNX Runtime Web, WebGPU)
// and streams the result to the worklet. The logic lives in LookaheadCore; this file provides the
// browser backends.
import * as ort from 'onnxruntime-web/jspi';
import type { LaToWorker, LookaheadStatus } from '@/lib/protocol';
import type { Settings } from '@/lib/settings';
import { BackendUnavailableError } from '@/lib/mdx/mdx';
import { SessionBackend, type ModelSession } from '@/lib/mdx/session-backend';
import { LookaheadCore, type DecoderFactory } from '@/lib/lookahead/lookahead-core';
import { KIM_VOCAL_2, SCNET, type LookaheadModel } from '@/lib/lookahead/models';
import type { FromLookaheadWorker, ToLookaheadWorker } from './messages';

/**
 * The model this build ships (LOOKAHEAD_MODEL, a compile-time constant set by wxt.config.ts, which
 * packages its file only). The other model's code is left out of the bundle.
 */
const MODEL: LookaheadModel = import.meta.env.LOOKAHEAD_MODEL === 'scnet' ? SCNET : KIM_VOCAL_2;
/** Audio of one model run, in ms. */
const CHUNK_MS = (MODEL.chunkSize / MODEL.sampleRate) * 1000;
const NO_GPU_REASON = 'No usable GPU for look-ahead processing. Using real-time mode.';

const report = (status: LookaheadStatus) =>
  (self as unknown as Worker).postMessage({ type: 'la-status', status } satisfies FromLookaheadWorker);
/** The worker's clock: playheads are stamped with it when they arrive (see PlayheadInfo.at). */
const now = () => performance.now();

// The JSPI bundle embeds its loader; Vite emits the .wasm next to this worker (import.meta.url).
ort.env.wasm.proxy = false;
ort.env.logLevel = 'error';

/** Execution provider of the current session (reported in the status). */
let executionProvider: 'webgpu' | 'wasm' | null = null;

/**
 * Loads the model with WebGPU. WASM is only an option in a cross-origin isolated context, where it
 * can use several threads; the engine iframe never is one (single-threaded WASM is far too slow).
 */
async function createSession(): Promise<ModelSession> {
  const providers: ('webgpu' | 'wasm')[] = [];
  const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
  if (adapter) providers.push('webgpu');
  if (self.crossOriginIsolated) providers.push('wasm');
  if (providers.length === 0) throw new BackendUnavailableError(NO_GPU_REASON);
  const res = await fetch(new URL(`/models/${MODEL.file}`, self.location.origin));
  if (!res.ok) throw new BackendUnavailableError(`The look-ahead model is missing (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let lastError: unknown = null;
  for (const ep of providers) {
    try {
      if (ep === 'wasm') ort.env.wasm.numThreads = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
      const session = await ort.InferenceSession.create(bytes, {
        // 'lazyRelease' frees the activation buffers after each run instead of caching their peak
        // size (Kim_Vocal_2: about 270 MB of GPU memory instead of 1.9 GB, for 5 % more time).
        executionProviders: [ep === 'webgpu' ? { name: 'webgpu', storageBufferCacheMode: 'lazyRelease' } : 'wasm'],
        graphOptimizationLevel: 'all',
      });
      executionProvider = ep;
      return wrapSession(session);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function wrapSession(session: ort.InferenceSession): ModelSession {
  const input = session.inputNames[0]!;
  const output = session.outputNames[0]!;
  return {
    async run(data) {
      const tensor = new ort.Tensor('float32', data, MODEL.dims);
      try {
        const result = await session.run({ [input]: tensor });
        const out = result[output]!;
        try {
          return (await out.getData()) as Float32Array;
        } finally {
          out.dispose();
        }
      } finally {
        tensor.dispose();
      }
    },
    release: () => session.release(),
  };
}

const decoderFactory: DecoderFactory = (config, onOutput, onError) => {
  const init: AudioDecoderConfig = {
    codec: config.codec,
    sampleRate: config.sampleRate,
    numberOfChannels: config.channels,
    ...(config.description ? { description: config.description } : {}),
  };
  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        const channels: Float32Array[] = [];
        for (let c = 0; c < data.numberOfChannels; c++) {
          const plane = new Float32Array(data.numberOfFrames);
          data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          channels.push(plane);
        }
        onOutput({ timestamp: data.timestamp / 1e6, sampleRate: data.sampleRate, channels });
      } finally {
        data.close();
      }
    },
    error: (e) => onError(e.message),
  });
  decoder.configure(init);
  return {
    decode(frame, timestamp) {
      if (decoder.state !== 'configured') return;
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(timestamp * 1e6),
          duration: Math.round(frame.duration * 1e6),
          data: frame.data,
        }),
      );
    },
    flush: () => (decoder.state === 'configured' ? decoder.flush() : Promise.resolve()),
    reset() {
      if (decoder.state === 'closed') return;
      decoder.reset();
      decoder.configure(init);
    },
    close() {
      if (decoder.state !== 'closed') decoder.close();
    },
  };
};

// A run longer than 5× its audio can never keep up. The first run of a session also compiles the
// WebGPU shaders, which can take tens of seconds with a cold shader cache.
const backend = new SessionBackend({ create: createSession, runTimeoutMs: 5 * CHUNK_MS, firstRunTimeoutMs: 120_000, createTimeoutMs: 120_000 });
let core: LookaheadCore | null = null;
let worklet: MessagePort | null = null;

function ensureCore(): LookaheadCore {
  core ??= new LookaheadCore({
    model: MODEL,
    backend,
    decoderFactory,
    postWorklet: (msg, transfer) => worklet?.postMessage(msg, transfer ?? []),
    now,
    onStatus: (status) => report({ ...status, backend: executionProvider ?? undefined }),
  });
  return core;
}

function applySettings(s: Settings) {
  ensureCore().setEnabled(s.enabled && s.quality === 'auto');
}

self.onmessage = (e: MessageEvent<ToLookaheadWorker>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      applySettings(msg.settings);
      break;
    case 'connect': {
      const port = e.ports[0];
      if (!port) break;
      worklet?.close();
      worklet = port;
      port.onmessage = (m: MessageEvent<LaToWorker>) => core?.onProbe(m.data);
      break;
    }
    case 'settings':
      applySettings(msg.settings);
      break;
    case 'hook':
      ensureCore().onHook(msg.message);
      break;
    case 'active-timeline':
      ensureCore().setActiveTimeline(msg.msId);
      break;
    case 'playhead':
      // Re-stamped on arrival: the sender's clock may disagree with this one by hours.
      ensureCore().setPlayhead({ ...msg.playhead, at: now() });
      break;
  }
};
