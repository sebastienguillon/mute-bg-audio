import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { GCProfiler, getHeapSpaceStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { DFN_DELAY, PROBE_LENGTH, QUANTUM } from '../../src/lib/constants';
import { MixerCore } from '../../src/lib/mixer/mixer-core';
import type { LaFromWorker, MixerConfig, RtFromWorker } from '../../src/lib/protocol';
import { makeMedia, playMedia } from './helpers/mixer-signals';

const SR = 48000;

type RigMode = 'bypass' | 'realtime' | 'lookahead' | 'probing' | 'idle';

/**
 * Lean, allocation-free driver: the fake workers answer synchronously after each quantum with
 * reused message objects, and input/output live in fixed buffers. 'idle' plays digital silence.
 * `firstFrame` starts the core's frame counter there (as after hours of uptime).
 */
function leanRig(mode: RigMode, firstFrame = 0) {
  const seconds = 36;
  const off = SR / 2;
  const media = makeMedia((seconds + 1) * SR, 5);
  const [srcL, srcR] = playMedia(media, seconds * SR, () => off);
  if (mode === 'idle') {
    srcL.fill(0);
    srcR.fill(0);
  }
  let hopIndex = -1;
  let hopData: Float32Array | null = null;
  let probeId = 0;
  let probeEnd = 0;
  /** Frames rendered so far (the media position is this + off, whatever the core's counter). */
  let frame = 0;
  const speechMsg: RtFromWorker = { type: 'speech', index: 0, data: new Float32Array(0) };
  const core = new MixerCore({
    postRt: (msg) => {
      if (msg.type !== 'hop') return;
      hopIndex = msg.index;
      hopData = msg.data;
    },
    postLa: (msg) => {
      probeId = msg.id;
      probeEnd = msg.frameEnd;
      probeLocalEnd = frame + QUANTUM; // posted during the quantum, at its end
    },
    postMain: () => {},
  }, { firstFrame });
  let probeLocalEnd = 0;
  core.setRtConnected(true);
  core.onRt({ type: 'ready' });
  core.setLaConnected(true);
  for (let start = 0; start < media.speechL.length; start += SR) {
    const end = Math.min(media.speechL.length, start + SR);
    core.onLa({
      type: 'block',
      timelineId: mode === 'probing' ? 2 : 1,
      start,
      speechL: media.speechL.slice(start, end),
      speechR: media.speechR.slice(start, end),
      residualL: media.residualL.slice(start, end),
      residualR: media.residualR.slice(start, end),
    });
  }
  const config: MixerConfig = {
    enabled: mode !== 'bypass',
    residualGain: 0.25,
    gapReduction: true,
    lookahead: mode === 'lookahead' || mode === 'probing',
    outputLatency: 0,
  };
  core.onMain({ type: 'config', config });
  const probeResult: LaFromWorker = {
    type: 'probe-result',
    id: 0,
    frameEnd: 0,
    found: mode === 'lookahead',
    timelineId: 1,
    mediaEnd: 0,
    gain: 1,
    score: 1,
  };
  const inL = new Float32Array(QUANTUM);
  const inR = new Float32Array(QUANTUM);
  const input = [inL, inR];
  const output = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
  /** Processes `quanta` quanta (wrapping around the source signal). */
  const run = (quanta: number) => {
    for (let q = 0; q < quanta; q++) {
      const f0 = frame % srcL.length;
      for (let i = 0; i < QUANTUM; i++) {
        inL[i] = srcL[f0 + i]!;
        inR[i] = srcR[f0 + i]!;
      }
      core.process(input, output);
      frame += QUANTUM;
      if (hopData !== null) {
        speechMsg.index = hopIndex - DFN_DELAY;
        speechMsg.data = hopData;
        hopData = null;
        core.onRt(speechMsg);
      }
      if (probeId !== 0) {
        probeResult.id = probeId;
        probeResult.frameEnd = probeEnd;
        probeResult.mediaEnd = probeLocalEnd + off;
        probeId = 0;
        core.onLa(probeResult);
      }
    }
  };
  return { core, run, quantaAvailable: Math.floor(srcL.length / QUANTUM) };
}

function newSpaceUsed(): number {
  return getHeapSpaceStatistics().find((s) => s.space_name === 'new_space')!.space_used_size;
}

/** Full GC (so that the measured window starts with an empty young generation). */
function collectGarbage(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

/** Young-generation bytes allocated by `fn` (null when a GC ran meanwhile, which hides them). */
function allocatedBy(fn: () => void): number | null {
  const profiler = new GCProfiler();
  profiler.start();
  const before = newSpaceUsed();
  fn();
  const after = newSpaceUsed();
  return profiler.stop().statistics.length === 0 ? after - before : null;
}

/** Median of a non-empty list. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}

describe('MixerCore steady state', () => {
  // Thresholds are judged on the cleanest of several windows or on medians, so that other test
  // files competing for the CPU (late JIT tiering, preemption) cannot fail them.
  const WINDOW = 2500; // quanta (6.7 s)

  // 'late': look-ahead with the counter started beyond 2^31 frames (12.4 h; also beyond V8's
  // Smi range without pointer compression, as in Node): it is rebased at once.
  for (const [mode, firstFrame] of [
    ['lookahead', 0],
    ['idle', 0],
    ['lookahead', 2 ** 31 + 12345 * QUANTUM],
  ] as const) {
    const label = firstFrame === 0 ? mode : `${mode}-late`;
    it(`allocates nothing in process() after warm-up (${label})`, () => {
      const rig = leanRig(mode, firstFrame);
      rig.run(2000); // warm-up: locks or goes idle, fills the hop pool, lets the JIT settle
      expect(rig.core.lockState).toBe(mode === 'lookahead' ? 'locked' : 'unlocked');
      const buffers = rig.core.hopBuffersAllocated;
      expect(buffers).toBeLessThanOrEqual(4);

      collectGarbage();
      rig.run(1000); // a full GC drops optimized code: let it re-tier before measuring
      const windows: number[] = [];
      for (let k = 0; k < 4; k++) {
        const bytes = allocatedBy(() => rig.run(WINDOW));
        if (bytes !== null) windows.push(bytes);
      }
      expect(rig.core.hopBuffersAllocated).toBe(buffers);
      expect(rig.core.lockState).toBe(mode === 'lookahead' ? 'locked' : 'unlocked');
      expect(windows.length).toBeGreaterThan(0);
      // A single boxed number per quantum would be 40 kB per window. What remains (< 16 kB) is
      // the measurement itself and the 2 Hz stats report (~250 B each).
      const cleanest = Math.min(...windows);
      expect(cleanest).toBeLessThan(16 * 1024);
      mkdirSync('test/fixtures/generated/mixer', { recursive: true });
      writeFileSync(
        `test/fixtures/generated/mixer/alloc-${label}.json`,
        JSON.stringify({ quantaPerWindow: WINDOW, youngGenBytes: windows, hopBuffers: buffers }),
      );
    });
  }

  it('measures the cost of process() per render quantum', () => {
    const results: Record<string, number> = {};
    for (const mode of ['bypass', 'realtime', 'lookahead', 'probing', 'idle'] as const) {
      const rig = leanRig(mode);
      rig.run(2000);
      const chunk = 250;
      const chunks: number[] = [];
      for (let k = 0; k < Math.floor((rig.quantaAvailable - 2000) / chunk); k++) {
        const t0 = performance.now();
        rig.run(chunk);
        chunks.push(((performance.now() - t0) * 1000) / chunk);
      }
      const us = median(chunks);
      results[mode] = Math.round(us * 100) / 100;
      // Budget: one quantum is 2667 µs of audio; the worklet must stay far below it.
      expect(us).toBeLessThan(150);
    }
    mkdirSync('test/fixtures/generated/mixer', { recursive: true });
    writeFileSync(
      'test/fixtures/generated/mixer/perf.json',
      JSON.stringify({ usPerQuantum: results, quantumUs: (QUANTUM / SR) * 1e6, probeLength: PROBE_LENGTH }, null, 2),
    );
  });
});
