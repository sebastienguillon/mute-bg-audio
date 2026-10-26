import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROBE_LENGTH } from '../../src/lib/constants';
import type { LookaheadCoreOptions } from '../../src/lib/lookahead/lookahead-core';
import { KIM_VOCAL_2, SCNET } from '../../src/lib/lookahead/models';
import type { MdxBackend } from '../../src/lib/mdx/mdx';
import type { LaFromWorker } from '../../src/lib/protocol';
import {
  SR,
  appendCopies as appendMixCopies,
  blockSpan,
  copiesAt,
  createHarness,
  fakeDecoderFactory,
  fixturePath,
  noise,
  playheadAt,
  readFixtureWav,
  remixError as blocksRemixError,
  settle,
  waitFor,
  webmAppends,
  zeroBackend,
  type BlockMsg,
  type Harness,
  type ProbeResultMsg,
  type Wav,
} from './helpers/lookahead-media';

const COMPENSATE = KIM_VOCAL_2.compensate;
/** Input-rate samples finalized per MDX chunk after the first (step = 0.75 · 261120 at 44.1 kHz). */
const STEP48 = Math.ceil((195840 * SR) / 44100);

let mix: Wav;
let webm: Uint8Array;

beforeAll(() => {
  mix = readFixtureWav('mix.wav');
  webm = new Uint8Array(readFileSync(fixturePath('mix.webm')));
});

function harness(opts: Partial<LookaheadCoreOptions> = {}): Harness {
  return createHarness({ decoderFactory: fakeDecoderFactory(mix), ...opts });
}

function appendCopies(h: Harness, msId: number, copies: number, offset = 0): void {
  appendMixCopies(h, webm, msId, copies, offset);
}

/** Decoded mix at media index m of a timeline made by appendCopies(…, copies, offset). */
function mixAt(channel: 0 | 1, m: number, copies: number, offset = 0): number {
  return copiesAt(mix, channel, m, copies, offset);
}

const playhead = playheadAt;

/** Worst |speech + residual − mix| over the blocks. */
function remixError(blocks: BlockMsg[], copies: number, offset = 0): number {
  return blocksRemixError(blocks, (channel, m) => mixAt(channel, m, copies, offset));
}

/** SNR (dB) of the speech blocks against compensate · mix (identity model: speech ≈ compensate · mix). */
function identitySnr(blocks: BlockMsg[], copies: number): number {
  let signal = 0;
  let error = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.speechL.length; i++) {
      const ref = COMPENSATE * mixAt(0, b.start + i, copies);
      signal += ref * ref;
      error += (b.speechL[i]! - ref) ** 2;
    }
  }
  return 10 * Math.log10(signal / error);
}

function indexOfType(posts: LaFromWorker[], pred: (m: LaFromWorker) => boolean, from = 0): number {
  for (let i = from; i < posts.length; i++) if (pred(posts[i]!)) return i;
  return -1;
}

describe('LookaheadCore processing', () => {
  it('emits contiguous blocks up to the target ahead of the playhead, with speech + residual = mix', async () => {
    const h = harness({ aheadSeconds: 12 });
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 2);
    h.core.setPlayhead(playhead(h, 0));
    await waitFor(() => h.blockEnd(1) >= 12 * SR, 20_000, 'blocks up to 12 s');
    await settle(h);
    const blocks = h.blocks(1);
    const span = blockSpan(blocks)!;
    expect(span.start).toBe(0);
    expect(span.contiguous).toBe(true);
    // Stops once the target is reached (paused playhead).
    expect(span.end).toBeGreaterThanOrEqual(12 * SR);
    expect(span.end).toBeLessThan(12 * SR + STEP48 + 1);
    expect(remixError(blocks, 2)).toBeLessThan(1e-6);
    const snr = identitySnr(blocks, 2);
    expect(snr).toBeGreaterThan(25);
    // Every block transfers its four buffers.
    for (let i = 0; i < h.posts.length; i++) {
      const msg = h.posts[i]!;
      if (msg.type !== 'block') continue;
      const buffers = new Set(h.transfers[i]);
      expect(buffers.size).toBe(4);
      for (const a of [msg.speechL, msg.speechR, msg.residualL, msg.residualR]) expect(buffers.has(a.buffer)).toBe(true);
    }

    // Playback moves on: processing follows, without flushing.
    h.clock.now = 1000;
    h.core.setPlayhead(playhead(h, 10, { paused: false }));
    await waitFor(() => h.blockEnd(1) >= 22 * SR, 20_000, 'blocks up to 22 s');
    await settle(h);
    const more = blockSpan(h.blocks(1))!;
    expect(more.start).toBe(0);
    expect(more.contiguous).toBe(true);
    expect(more.end).toBeLessThan(22 * SR + STEP48 + 1);
    expect(h.posts.filter((m) => m.type === 'flush').length).toBe(1); // the one of setActiveTimeline
    expect(remixError(h.blocks(1), 2)).toBeLessThan(1e-6);
    console.log(`identity model: speech vs compensate · mix ${snr.toFixed(1)} dB over ${(span.end / SR).toFixed(2)} s`);
    h.core.dispose();
  });

  it('flushes and restarts at the new origin on seeks', async () => {
    const h = harness({ aheadSeconds: 8, backend: zeroBackend });
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 2);
    h.core.setPlayhead(playhead(h, 1));
    await waitFor(() => h.blockEnd(1) >= 9 * SR, 20_000, 'first blocks');
    await settle(h, 150);
    expect(h.blocks(1)[0]!.start).toBe(SR);

    // Seek forwards far away.
    const before = h.posts.length;
    h.core.setPlayhead(playhead(h, 40.3, { seeking: true }));
    await waitFor(() => h.blockEnd(1) >= 48.3 * SR, 20_000, 'blocks after the seek');
    await settle(h, 150);
    const flushAt = indexOfType(h.posts, (m) => m.type === 'flush', before);
    expect(h.posts[flushAt]).toEqual({ type: 'flush', timelineId: 1 });
    const after = h.posts.slice(flushAt + 1).filter((m): m is BlockMsg => m.type === 'block');
    const span = blockSpan(after)!;
    expect(span.start).toBe(Math.round(40.3 * SR));
    expect(span.contiguous).toBe(true);
    expect(span.end).toBeLessThan(48.3 * SR + STEP48 + 1);
    expect(remixError(after, 2)).toBe(0); // zero model: residual = mix exactly
    // No stale block of the old region after the flush.
    expect(after.every((b) => b.start >= Math.round(40.3 * SR))).toBe(true);

    // Seek backwards before the origin (within the 30 s of PCM kept behind the playhead).
    const before2 = h.posts.length;
    h.core.setPlayhead(playhead(h, 15));
    await waitFor(() => h.blockEnd(1) >= 23 * SR && h.blockEnd(1) < 40 * SR, 20_000, 'blocks after seeking back');
    const flush2 = indexOfType(h.posts, (m) => m.type === 'flush', before2);
    expect(h.posts[flush2]).toEqual({ type: 'flush', timelineId: 1 });
    expect(blockSpan(h.posts.slice(flush2 + 1).filter((m): m is BlockMsg => m.type === 'block'))!.start).toBe(15 * SR);
    h.core.dispose();
  });

  it('flushes the worklet and restarts on the new timeline when the active timeline changes', async () => {
    const h = harness({ aheadSeconds: 6, backend: zeroBackend });
    appendCopies(h, 1, 1);
    appendCopies(h, 2, 1, 100);
    h.core.setActiveTimeline(1);
    h.core.setPlayhead(playhead(h, 2));
    await waitFor(() => h.blockEnd(1) >= 8 * SR, 20_000, 'timeline 1 blocks');
    await settle(h, 150);
    const before = h.posts.length;
    h.core.setActiveTimeline(2);
    expect(h.posts[before]).toEqual({ type: 'flush' });
    // Nothing happens until the playhead of the new timeline is known.
    await settle(h, 150);
    expect(h.posts.length).toBe(before + 1);
    h.core.setPlayhead(playhead(h, 103));
    await waitFor(() => h.blockEnd(2) >= 109 * SR, 20_000, 'timeline 2 blocks');
    await settle(h, 150);
    const blocks = h.posts.slice(before + 1).filter((m): m is BlockMsg => m.type === 'block');
    expect(blocks.every((b) => b.timelineId === 2)).toBe(true);
    expect(blockSpan(blocks)!.start).toBe(103 * SR);
    expect(remixError(blocks, 1, 100)).toBe(0);
    h.core.dispose();
  });

  it('processes up to the end of the decoded audio when it runs short, then continues when more arrives', async () => {
    const h = harness({ aheadSeconds: 30, backend: zeroBackend });
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 1); // [0, 1501 · 960)
    const end = 1501 * 960;
    h.core.setPlayhead(playhead(h, 20));
    await settle(h);
    // Plenty of processed audio ahead: only chunks whose input is fully decoded.
    const first = blockSpan(h.blocks(1))!;
    expect(first.start).toBe(20 * SR);
    expect(first.end).toBeLessThan(end - 5 * SR);
    // Less than 3 s of processed audio left: the next chunks run with silence after the decoded end.
    h.core.setPlayhead(playhead(h, first.end / SR - 2.5));
    await settle(h);
    const second = blockSpan(h.blocks(1))!;
    expect(second.end).toBeGreaterThan(first.end);
    expect(second.end).toBeLessThan(end);
    h.core.setPlayhead(playhead(h, second.end / SR - 2.5));
    await waitFor(() => h.blockEnd(1) >= end, 20_000, 'blocks up to the end');
    await settle(h);
    // Blocks stop exactly at the end of the decoded audio.
    expect(h.blockEnd(1)).toBe(end);
    expect(blockSpan(h.blocks(1))!.contiguous).toBe(true);
    // The page appends the next part: processing resumes at the cut, without a flush.
    for (const msg of webmAppends(1, 1, webm, { timestampOffset: end / SR })) h.core.onHook(msg);
    await waitFor(() => h.blockEnd(1) >= 40 * SR, 20_000, 'blocks after the cut');
    await settle(h);
    const span = blockSpan(h.blocks(1))!;
    expect(span.contiguous).toBe(true);
    expect(span.start).toBe(20 * SR);
    expect(h.posts.filter((m) => m.type === 'flush').length).toBe(1);
    // The blocks after the cut were computed from the new audio (speech + residual = mix).
    const after = h.blocks(1).filter((b) => b.start >= end);
    expect(after.length).toBeGreaterThan(0);
    let worst = 0;
    for (const b of after) {
      for (let i = 0; i < b.residualL.length; i++) worst = Math.max(worst, Math.abs(b.residualL[i]! - mix.channels[0]![b.start + i - end]!));
    }
    expect(worst).toBe(0);
    h.core.dispose();
  });

  it.each([
    ['Kim_Vocal_2', KIM_VOCAL_2],
    ['SCNet', SCNET],
  ] as const)('%s: the first chunk waits for audio that is still being decoded instead of running short', async (_name, model) => {
    // The hook's replay at the start hands the decoder everything appended so far; its output
    // comes over the next 300 ms. A short first block would leave look-ahead without blocks while
    // the chunk at its end runs.
    const h = harness({ model, aheadSeconds: 12, backend: zeroBackend, decoderFactory: fakeDecoderFactory(mix, undefined, { batch: 25, batchMs: 10 }) });
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 1);
    h.core.setPlayhead(playhead(h, 0));
    await waitFor(() => h.blocks(1).length > 0, 20_000, 'the first block');
    const step = Math.floor((1 - model.stream.overlap!) * model.chunkSize);
    // The whole first chunk's block: everything before its overlap with the next chunk.
    const full = Math.floor(((step - model.stream.trim!) * SR) / model.sampleRate);
    expect(h.blocks(1)[0]!.speechL.length).toBeGreaterThan(full - 100);
    await waitFor(() => h.blockEnd(1) >= 12 * SR, 20_000, 'blocks up to 12 s');
    expect(blockSpan(h.blocks(1))!.contiguous).toBe(true);
    h.core.dispose();
  });

  it('starts at the first decoded sample when the audio begins just after the playhead', async () => {
    const h = harness({ aheadSeconds: 5, backend: zeroBackend });
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 1, 0.1);
    h.core.setPlayhead(playhead(h, 0));
    await waitFor(() => h.blockEnd(1) >= 5 * SR, 20_000, 'blocks');
    expect(h.blocks(1)[0]!.start).toBe(0.1 * SR);
    h.core.dispose();
  });

  it('drops the PCM of removed ranges and the blocks of a gone timeline', async () => {
    const h = harness({ aheadSeconds: 4, backend: zeroBackend });
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 2);
    h.core.setPlayhead(playhead(h, 0));
    await waitFor(() => h.blockEnd(1) >= 4 * SR, 20_000, 'blocks');
    await settle(h, 150);
    const probeAt = (m: number, id: number): ProbeResultMsg => {
      const data = new Float32Array(PROBE_LENGTH);
      for (let i = 0; i < PROBE_LENGTH; i++) data[i] = 0.5 * (mixAt(0, m - PROBE_LENGTH + i, 2) + mixAt(1, m - PROBE_LENGTH + i, 2));
      h.core.setPlayhead(playhead(h, m / SR));
      h.core.onProbe({ type: 'probe', id, frameEnd: 1e6, data });
      return h.posts[h.posts.length - 1] as ProbeResultMsg;
    };
    expect(probeAt(45 * SR, 1).found).toBe(true);
    h.core.onHook({ type: 'sb-remove', msId: 1, sbId: 1, start: 40, end: 60 });
    expect(probeAt(45 * SR, 2).found).toBe(false);
    h.core.setPlayhead(playhead(h, 0));
    h.core.onHook({ type: 'sb-gone', msId: 1, sbId: 1 });
    expect(h.posts[h.posts.length - 1]).toEqual({ type: 'flush', timelineId: 1 });
    h.core.dispose();
  });
  it('keeps the PCM of the most recently active timeline only', async () => {
    const h = harness({ backend: zeroBackend });
    h.core.setEnabled(false);
    for (const id of [1, 2, 3]) appendCopies(h, id, 1);
    await new Promise((r) => setTimeout(r, 10));
    const probe = (id: number): boolean => {
      const m = 10 * SR;
      const data = new Float32Array(PROBE_LENGTH);
      for (let i = 0; i < PROBE_LENGTH; i++) data[i] = 0.5 * (mixAt(0, m - PROBE_LENGTH + i, 1) + mixAt(1, m - PROBE_LENGTH + i, 1));
      h.core.setPlayhead(playhead(h, 10));
      h.core.onProbe({ type: 'probe', id, frameEnd: 0, data });
      return (h.posts[h.posts.length - 1] as ProbeResultMsg).found;
    };
    h.clock.now = 1;
    h.core.setActiveTimeline(1);
    expect(probe(1)).toBe(true);
    h.clock.now = 2;
    h.core.setActiveTimeline(2);
    h.clock.now = 3;
    h.core.setActiveTimeline(3); // 1 is pruned, 2 is kept
    expect(probe(3)).toBe(true);
    h.clock.now = 4;
    h.core.setActiveTimeline(2);
    expect(probe(2)).toBe(true);
    h.clock.now = 5;
    h.core.setActiveTimeline(1);
    expect(probe(1)).toBe(false);
    h.core.dispose();
  });
});

describe('LookaheadCore probes', () => {
  /** 0.5 · mono decoded mix ending (exclusive) at media index m, plus noise. */
  function probeData(m: number, gain = 0.5, noiseAmp = 1e-3, seed = 9): Float32Array {
    const data = noise(PROBE_LENGTH, noiseAmp, seed);
    for (let i = 0; i < PROBE_LENGTH; i++) {
      const j = m - PROBE_LENGTH + i;
      data[i] = data[i]! + gain * 0.5 * (mixAt(0, j, 2) + mixAt(1, j, 2));
    }
    return data;
  }

  async function probeHarness(): Promise<Harness> {
    const h = harness();
    h.core.setEnabled(false); // probes do not need processing
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 2);
    await new Promise((r) => setTimeout(r, 10));
    return h;
  }

  it('finds a probe near the extrapolated playhead exactly, with its gain', async () => {
    const h = await probeHarness();
    const m = 20 * SR + 1234;
    h.clock.now = 1000;
    h.core.setPlayhead(playhead(h, 19.5, { paused: false, at: 1000 }));
    h.clock.now = 1800; // extrapolated playhead: 20.3 s
    h.core.onProbe({ type: 'probe', id: 7, frameEnd: 987654, data: probeData(m) });
    const result = h.posts[h.posts.length - 1] as ProbeResultMsg;
    expect(result).toMatchObject({ type: 'probe-result', id: 7, frameEnd: 987654, found: true, timelineId: 1, mediaEnd: m });
    expect(result.gain).toBeCloseTo(0.5, 2);
    expect(result.score).toBeGreaterThan(0.95);

    // Next probe: predicted from the previous match even with a wrong playhead.
    // (A playhead at 45 s still keeps 21 s of PCM: 30 s are kept behind the playhead.)
    h.core.setPlayhead(playhead(h, 45));
    h.core.onProbe({ type: 'probe', id: 8, frameEnd: 987654 + 96000, data: probeData(m + 96000, 0.8) });
    const predicted = h.posts[h.posts.length - 1] as ProbeResultMsg;
    expect(predicted).toMatchObject({ id: 8, found: true, mediaEnd: m + 96000 });
    expect(predicted.gain).toBeCloseTo(0.8, 2);
    h.core.dispose();
  });

  it('answers found:false for unrelated audio or audio far from the playhead', async () => {
    const h = await probeHarness();
    h.core.setPlayhead(playhead(h, 20));
    h.core.onProbe({ type: 'probe', id: 1, frameEnd: 5000, data: noise(PROBE_LENGTH, 0.1, 3) });
    expect(h.posts[h.posts.length - 1]).toMatchObject({ type: 'probe-result', id: 1, found: false, timelineId: 1 });
    h.core.onProbe({ type: 'probe', id: 2, frameEnd: 5000, data: probeData(5 * SR) });
    expect(h.posts[h.posts.length - 1]).toMatchObject({ id: 2, found: false });
    h.core.onProbe({ type: 'probe', id: 3, frameEnd: 5000, data: new Float32Array(PROBE_LENGTH) });
    expect(h.posts[h.posts.length - 1]).toMatchObject({ id: 3, found: false });
    // No active timeline.
    h.core.setActiveTimeline(null);
    h.core.onProbe({ type: 'probe', id: 4, frameEnd: 5000, data: probeData(20 * SR) });
    expect(h.posts[h.posts.length - 1]).toMatchObject({ id: 4, found: false, timelineId: -1 });
    h.core.dispose();
  });

  it('answers a probe in a few milliseconds', async () => {
    const h = await probeHarness();
    h.core.setPlayhead(playhead(h, 20));
    const data = probeData(20 * SR);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      h.core.onProbe({ type: 'probe', id: i, frameEnd: 0, data });
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    console.log(`probe: median ${times[10]!.toFixed(2)} ms, max ${times[19]!.toFixed(2)} ms`);
    expect(times[10]).toBeLessThan(20);
    h.core.dispose();
  });
});

describe('LookaheadCore status', () => {
  it('goes from loading to ready and reports the processed audio ahead of the playhead', async () => {
    const h = harness({ aheadSeconds: 10, now: () => performance.now() });
    const t0 = performance.now();
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 2);
    h.core.setPlayhead({ time: 3, paused: true, rate: 1, seeking: false, audible: true, at: performance.now() });
    await waitFor(() => h.blockEnd(1) >= 13 * SR, 20_000, 'blocks');
    await settle(h, 400);
    const elapsed = performance.now() - t0;
    expect(h.statuses[0]!.state).toBe('loading');
    const last = h.statuses[h.statuses.length - 1]!;
    expect(last.state).toBe('ready');
    expect(last.aheadSeconds).toBeCloseTo(h.blockEnd(1) / SR - 3, 2);
    expect(last.rtf).toBeGreaterThan(0);
    expect(last.rtf).toBeLessThan(1);
    // Throttled to at most 4 per second (plus the first one).
    expect(h.statuses.length).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 1);
    expect(h.statuses.findIndex((s) => s.state === 'ready')).toBeGreaterThan(0);
    console.log(`status: ${h.statuses.length} reports in ${elapsed.toFixed(0)} ms; last ${JSON.stringify(last)}`);
    h.core.dispose();
  });

  it('reports off while disabled and stops processing, then resumes', async () => {
    const h = harness({ aheadSeconds: 5, backend: zeroBackend });
    h.core.setEnabled(false);
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 1);
    h.core.setPlayhead(playhead(h, 0));
    await settle(h, 300);
    expect(h.blocks().length).toBe(0);
    expect(h.statuses[h.statuses.length - 1]).toEqual({ state: 'off' });
    h.core.setEnabled(true);
    await waitFor(() => h.blockEnd(1) >= 5 * SR, 20_000, 'blocks');
    await settle(h, 300);
    expect(h.statuses[h.statuses.length - 1]!.state).toBe('ready');
    h.core.dispose();
  });

  it('reports unavailable for MSE in a worker and errors of the backend', async () => {
    let calls = 0;
    const failing: MdxBackend = {
      run: async () => {
        calls++;
        throw new Error('GPU device lost');
      },
    };
    const h = harness({ aheadSeconds: 5, backend: failing });
    h.core.onHook({ type: 'ms-worker' });
    await settle(h, 300);
    expect(h.statuses[h.statuses.length - 1]!.state).toBe('unavailable');
    h.core.setActiveTimeline(1);
    appendCopies(h, 1, 1);
    h.core.setPlayhead(playhead(h, 0));
    await settle(h, 300);
    expect(h.statuses[h.statuses.length - 1]).toEqual({ state: 'error', reason: 'Look-ahead processing failed: GPU device lost' });
    expect(calls).toBe(1);
    // Moving the playhead does not retry; re-enabling does.
    h.core.setPlayhead(playhead(h, 1));
    await settle(h, 300);
    expect(calls).toBe(1);
    h.core.setEnabled(false);
    h.core.setEnabled(true);
    await settle(h, 300);
    expect(calls).toBe(2);
    h.core.dispose();
  });
});
