// Simulated playback: the page appends clusters a few seconds ahead of an advancing playhead (at
// about 8× real time), the core must keep blocks ahead of the playhead without flushing, through
// to the end of the media. The clock advances by a fixed step per 20 ms timer tick, so a loaded
// machine slows playback down instead of letting it outrun processing. On a slower GPU, model runs
// take simulated time and the page buffers little: the blocks must still cover the playhead.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { KIM_VOCAL_2, SCNET, type LookaheadModel } from '../../src/lib/lookahead/models';
import type { MdxBackend } from '../../src/lib/mdx/mdx';
import type { HookMessage } from '../../src/lib/protocol';
import {
  SR,
  blockSpan,
  createHarness,
  fakeDecoderFactory,
  fixturePath,
  readFixtureWav,
  sbAdd,
  splitWebm,
  sbAppend,
  zeroBackend,
  type Harness,
  type Wav,
} from './helpers/lookahead-media';

const SPEED = 8;
/** Real time per step of the simulated clock (ms); the clock advances SPEED times as much. */
const STEP_MS = 20;
/** The page keeps this much audio buffered ahead of the playhead. */
const BUFFER_AHEAD = 12;

let mix: Wav;
let webm: Uint8Array;

beforeAll(() => {
  mix = readFixtureWav('mix.wav');
  webm = new Uint8Array(readFileSync(fixturePath('mix.webm')));
});

describe('LookaheadCore during playback', () => {
  it('stays ahead of an advancing playhead with appends arriving just in time', async () => {
    const h = createHarness({ decoderFactory: fakeDecoderFactory(mix), backend: zeroBackend, aheadSeconds: 10 });
    const clock = h.clock;
    // Two copies of the file: 60 s of media in 14 appends with their start times.
    const { init, clusters } = splitWebm(webm);
    const appends: { at: number; msg: HookMessage }[] = [];
    for (let copy = 0; copy < 2; copy++) {
      const opts = { timestampOffset: 30 * copy, ...(copy === 0 ? { appendWindowEnd: 30 } : {}) };
      appends.push({ at: 30 * copy, msg: sbAppend(1, 1, init, opts) });
      clusters.forEach((c, i) => appends.push({ at: 30 * copy + 5 * i, msg: sbAppend(1, 1, c, opts) }));
    }
    const mediaEnd = 30 * SR + 1501 * 960;
    h.core.setActiveTimeline(1);
    h.core.onHook(sbAdd(1, 1));
    let worstLead = Infinity;
    let firstBlockAt: number | null = null;
    for (let time = 0; time < mediaEnd / SR; time = clock.now / 1000) {
      while (appends.length > 0 && appends[0]!.at <= time + BUFFER_AHEAD) h.core.onHook(appends.shift()!.msg);
      h.core.setPlayhead({ time, paused: false, rate: 1, seeking: false, audible: true, at: clock.now });
      if (h.blocks().length > 0) {
        firstBlockAt ??= time;
        // Once started, processed audio stays ahead of the playhead until the end of the media.
        if (time > firstBlockAt + 1 && h.blockEnd(1) < mediaEnd) worstLead = Math.min(worstLead, h.blockEnd(1) / SR - time);
      }
      await new Promise((r) => setTimeout(r, STEP_MS));
      clock.now += STEP_MS * SPEED;
    }
    const span = blockSpan(h.blocks(1))!;
    expect(h.posts.filter((m) => m.type === 'flush')).toEqual([{ type: 'flush' }]);
    // The stream starts at the playhead extrapolated to the moment processing begins.
    expect(span.start).toBeLessThan(0.1 * SR);
    expect(span.contiguous).toBe(true);
    expect(span.end).toBe(mediaEnd);
    // First block within 3 s of (nominal) real time; it includes JIT warm-up of the DSP.
    expect(firstBlockAt! / SPEED).toBeLessThan(3);
    expect(worstLead).toBeGreaterThan(0.5);
    const last = h.statuses[h.statuses.length - 1]!;
    expect(last.state).toBe('ready');
    console.log(
      `playback at ${SPEED}×: first block at media ${firstBlockAt!.toFixed(2)} s (${((firstBlockAt! / SPEED) * 1000).toFixed(0)} ms real), ` +
        `worst lead ${worstLead.toFixed(2)} s, ` +
        `${h.blocks().length} blocks, rtf ${last.rtf?.toFixed(3)} (simulated clock)`,
    );
    h.core.dispose();
  });
});

describe('LookaheadCore on a slower GPU, with a short page buffer', () => {
  // Every model run takes RTF × one chunk step of simulated time: 4.5 s with SCNet (7.5 s steps),
  // 2.7 s with Kim_Vocal_2 (4.4 s), under the 0.7 speed limit. The page keeps only SHORT_BUFFER s
  // appended ahead of the playhead (a live stream, limited bandwidth), less than the next chunk's
  // input needs, so chunks run cut. Each must start early enough for its run to end before the
  // processed audio runs out, also at the end of the media.
  const RTF = 0.6;
  const SHORT_BUFFER = 9;
  /** The controller sends a playhead every 250 ms; the simulated clock advances by as much per tick. */
  const TICK_MS = 250;

  /** Seconds of new audio per chunk (MdxStream's step). */
  function stepSeconds(model: LookaheadModel): number {
    return Math.floor((1 - model.stream.overlap!) * model.chunkSize) / model.sampleRate;
  }

  it.each([
    ['Kim_Vocal_2', KIM_VOCAL_2],
    ['SCNet', SCNET],
  ] as const)('%s at 0.6 × real time: once the speed is measured, blocks cover the playhead to the end of the media', async (_name, model) => {
    const runMs = RTF * stepSeconds(model) * 1000;
    /** Model runs in flight, done once the simulated clock reaches `due`. */
    const running: { due: number; done: () => void }[] = [];
    let runs = 0;
    let h: Harness;
    const backend: MdxBackend = {
      run: (input) =>
        new Promise((resolve) => {
          runs++;
          running.push({ due: h.clock.now + runMs, done: () => resolve(new Float32Array(input.length)) });
        }),
    };
    h = createHarness({ model, backend, decoderFactory: fakeDecoderFactory(mix), aheadSeconds: 30 });
    const clock = h.clock;
    // Three copies of the file: 90 s of media, appended one cluster at a time.
    const { init, clusters } = splitWebm(webm);
    const clusterSeconds = 30 / clusters.length;
    const appends: { at: number; msg: HookMessage }[] = [];
    for (let copy = 0; copy < 3; copy++) {
      const opts = { timestampOffset: 30 * copy, ...(copy < 2 ? { appendWindowEnd: 30 * (copy + 1) } : {}) };
      appends.push({ at: 30 * copy, msg: sbAppend(1, 1, init, opts) });
      clusters.forEach((c, i) => appends.push({ at: 30 * copy + i * clusterSeconds, msg: sbAppend(1, 1, c, opts) }));
    }
    const mediaEnd = 60 * SR + 1501 * 960;
    h.core.setActiveTimeline(1);
    h.core.onHook(sbAdd(1, 1));
    let done = 0;
    let measuredAt: number | null = null;
    /** Ticks without a block at the playhead, and the least processed audio ahead before the end. */
    let uncovered = 0;
    let worstLead = Infinity;
    for (let time = 0; time < mediaEnd / SR; time = clock.now / 1000) {
      while (appends.length > 0 && appends[0]!.at < time + SHORT_BUFFER) h.core.onHook(appends.shift()!.msg);
      h.core.setPlayhead({ time, paused: false, rate: 1, seeking: false, audible: true, at: clock.now });
      for (const run of running.filter((r) => r.due <= clock.now)) {
        running.splice(running.indexOf(run), 1);
        run.done();
        done++;
      }
      // Lets the core take the results and start the next runs (all microtasks).
      await new Promise((r) => setTimeout(r, 0));
      // The real-time factor is known once a run after the warm-up (the first) is done.
      if (done >= 2) measuredAt ??= time;
      if (measuredAt !== null) {
        if (h.blockEnd(1) <= Math.round(time * SR)) uncovered++;
        if (h.blockEnd(1) < mediaEnd) worstLead = Math.min(worstLead, h.blockEnd(1) / SR - time);
      }
      clock.now += TICK_MS;
    }
    const span = blockSpan(h.blocks(1))!;
    console.log(
      `${model.name} at ${RTF} × real time, page buffering ${SHORT_BUFFER} s ahead: ${runs} runs, speed measured at media ${measuredAt!.toFixed(2)} s, ` +
        `then ${uncovered} ticks without a block at the playhead, worst lead ${worstLead.toFixed(2)} s`,
    );
    expect(measuredAt!).toBeLessThan(15);
    // Blocks reach beyond the playhead at every tick (the mixer leaves look-ahead without them),
    // with a margin of more than two playhead messages, contiguous, without restarts, and the last
    // one came before the media ended.
    expect(uncovered).toBe(0);
    expect(worstLead).toBeGreaterThan(0.5);
    expect(h.posts.filter((m) => m.type === 'flush')).toEqual([{ type: 'flush' }]);
    expect(span.contiguous).toBe(true);
    expect(span.end).toBe(mediaEnd);
    h.core.dispose();
  });
});
