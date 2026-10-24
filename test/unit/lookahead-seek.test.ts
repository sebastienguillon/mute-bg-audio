// LookaheadCore across seeks and changing PCM: seeks back before what the worklet still holds,
// replay after the end, skewed clocks, chunks cut inside their overlap, and PCM replaced under
// blocks already sent.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROBE_LENGTH } from '../../src/lib/constants';
import { createDemuxer } from '../../src/lib/demux/index';
import type { DecoderFactory, LookaheadCoreOptions } from '../../src/lib/lookahead/lookahead-core';
import type { MdxBackend } from '../../src/lib/mdx/mdx';
import { BlockStore } from '../../src/lib/mixer/block-store';
import type { LaFromWorker } from '../../src/lib/protocol';
import {
  SR,
  appendCopies,
  blockSpan,
  copiesAt,
  createHarness,
  fakeDecoderFactory,
  fixturePath,
  identityBackend,
  playheadAt,
  readFixtureWav,
  remixError,
  sbAdd,
  sbAppend,
  settle,
  splitWebm,
  waitFor,
  webmAppends,
  zeroBackend,
  type BlockMsg,
  type Harness,
  type ProbeResultMsg,
  type Wav,
} from './helpers/lookahead-media';

/** MixerCore's block storage (MAX_BLOCK_SECONDS). */
const WORKLET_SECONDS = 60;

let mix: Wav;
let speech: Wav;
let webm: Uint8Array;

beforeAll(() => {
  mix = readFixtureWav('mix.wav');
  speech = readFixtureWav('speech.wav');
  webm = new Uint8Array(readFileSync(fixturePath('mix.webm')));
});

function harness(opts: Partial<LookaheadCoreOptions> = {}): Harness {
  return createHarness({ decoderFactory: fakeDecoderFactory(mix), backend: zeroBackend, ...opts });
}

/** Replays the posts into a BlockStore bounded like the worklet's (oldest blocks evicted first). */
function workletBlocks(posts: LaFromWorker[]): BlockStore {
  const store = new BlockStore(WORKLET_SECONDS * SR);
  for (const msg of posts) {
    if (msg.type === 'flush') store.flush(msg.timelineId);
    if (msg.type !== 'block') continue;
    store.insert(msg.timelineId, msg.start, msg.speechL, msg.speechR, msg.residualL, msg.residualR);
    store.enforceBudget(null, 0, 0);
  }
  return store;
}

/** Plays from `from` to `to` seconds in 5 s steps of paused playheads, letting processing follow. */
async function play(h: Harness, from: number, to: number): Promise<void> {
  for (let t = from; t <= to; t += 5) {
    h.core.setPlayhead(playheadAt(h, t));
    await settle(h, 60);
  }
}

function blocksAfter(h: Harness, index: number): BlockMsg[] {
  return h.posts.slice(index).filter((m): m is BlockMsg => m.type === 'block');
}

/**
 * Media indices [start, end) where the frames of clusters[from, to) of mix.webm land (20 ms Opus
 * frames placed back to back; WebM timestamps after the first are 1 ms late).
 */
function clusterSpan(init: Uint8Array, clusters: Uint8Array[], from: number, to: number): { start: number; end: number } {
  const frames = createDemuxer('audio/webm')!
    .push(new Uint8Array([...init, ...clusters.slice(from, to).flatMap((c) => [...c])]))
    .flatMap((e) => (e.type === 'frames' ? e.frames : []));
  const start = Math.round(frames[0]!.pts / 0.02) * 960;
  return { start, end: start + frames.length * 960 };
}

/** A decoder factory whose decoders (created from now on) decode `source.current`. */
function switchableDecoder(source: { current: Wav }): DecoderFactory {
  return (config, onOutput, onError) => fakeDecoderFactory(source.current)(config, onOutput, onError);
}

describe('LookaheadCore seeks', () => {
  it('re-processes after a seek back before the blocks the worklet still holds, decoding evicted PCM again', async () => {
    const h = harness();
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 4); // 120 s
    await play(h, 0, 70);
    expect(h.blockEnd(1)).toBeGreaterThanOrEqual(100 * SR);
    // The worklet kept the last 60 s only: nothing at 20 s any more.
    expect(workletBlocks(h.posts).contiguousAhead(1, 20 * SR)).toBe(0);

    h.clock.now += 10_000;
    const before = h.posts.length;
    h.core.setPlayhead(playheadAt(h, 20));
    await waitFor(() => blockSpan(blocksAfter(h, before))?.end! >= 50 * SR, 20_000, 'blocks after seeking back');
    expect(h.posts[before]).toEqual({ type: 'flush', timelineId: 1 });
    const after = blocksAfter(h, before);
    const span = blockSpan(after)!;
    expect(span.start).toBe(20 * SR);
    expect(span.contiguous).toBe(true);
    // The PCM behind 40 s had been evicted: it was decoded again from the retained frames, exactly.
    expect(remixError(after, (c, m) => copiesAt(mix, c, m, 4))).toBe(0);
    expect(workletBlocks(h.posts).contiguousAhead(1, 20 * SR)).toBeGreaterThanOrEqual(30 * SR);
    h.core.dispose();
  });

  it('re-processes a replay from the start after processing reached the end of the media', async () => {
    const h = harness();
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 3); // 90 s
    await play(h, 0, 85);
    // The last seconds are processed once the playhead is close (less than 3 s ahead).
    h.core.setPlayhead(playheadAt(h, 88));
    await settle(h, 60);
    const end = h.blockEnd(1);
    expect(end).toBe(60 * SR + 1501 * 960);
    const posted = h.posts.length;
    // Nothing more to do at the end.
    await settle(h, 100);
    expect(h.posts.length).toBe(posted);

    h.clock.now += 10_000;
    h.core.setPlayhead(playheadAt(h, 0));
    await waitFor(() => blockSpan(blocksAfter(h, posted))?.end! >= 30 * SR, 20_000, 'blocks of the replay');
    expect(h.posts[posted]).toEqual({ type: 'flush', timelineId: 1 });
    const replay = blocksAfter(h, posted);
    expect(blockSpan(replay)!.start).toBe(0);
    expect(remixError(replay, (c, m) => copiesAt(mix, c, m, 3))).toBe(0);
    h.core.dispose();
  });

  it('after a seek back past the retained frames, waits for the page to append the audio again', async () => {
    const h = harness({ maxEncodedBytes: 50_000 });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 3);
    await play(h, 0, 70);
    h.clock.now += 10_000;
    const before = h.posts.length;
    h.core.setPlayhead(playheadAt(h, 5));
    await settle(h, 150);
    expect(h.posts.slice(before)).toEqual([{ type: 'flush', timelineId: 1 }]);
    for (const msg of webmAppends(1, 1, webm, { appendWindowEnd: 30 })) h.core.onHook(msg);
    // Up to the end of the PCM: [30 s, 40 s) was evicted and not retained either.
    await waitFor(() => blockSpan(blocksAfter(h, before))?.end! >= 25 * SR, 20_000, 'blocks after the re-append');
    expect(blockSpan(blocksAfter(h, before))!.start).toBe(5 * SR);
    h.core.dispose();
  });

  it('keeps working when the page clock is hours away from the worker clock', async () => {
    for (const skew of [7.2e6, -7.2e6]) {
      const h = harness({ aheadSeconds: 8 });
      h.clock.now = 5e9;
      h.core.setActiveTimeline(1);
      appendCopies(h, webm, 1, 1);
      // Positive skew: the playhead looks 2 h old; negative: it comes from the future.
      h.core.setPlayhead(playheadAt(h, 10, { paused: false, at: h.clock.now - skew }));
      await waitFor(() => h.blocks(1).length > 0, 20_000, 'blocks');
      const start = h.blocks(1)[0]!.start;
      // Extrapolated by at most 1 s.
      expect(start).toBeGreaterThanOrEqual(10 * SR);
      expect(start).toBeLessThanOrEqual(11 * SR);
      // Probes are searched around the playhead too.
      const m = 10.5 * SR;
      const data = new Float32Array(PROBE_LENGTH);
      for (let i = 0; i < PROBE_LENGTH; i++) data[i] = 0.5 * (copiesAt(mix, 0, m - PROBE_LENGTH + i, 1) + copiesAt(mix, 1, m - PROBE_LENGTH + i, 1));
      h.core.onProbe({ type: 'probe', id: 1, frameEnd: 0, data });
      expect(h.posts[h.posts.length - 1]).toMatchObject({ type: 'probe-result', found: true, mediaEnd: m } satisfies Partial<ProbeResultMsg>);
      h.core.dispose();
    }
  });
});

describe('LookaheadCore with audio arriving late', () => {
  /** RMS in dB of the left speech of the blocks over [from, to) seconds, per 100 ms window. */
  function speechLevels(blocks: BlockMsg[], from: number, to: number): number[] {
    const levels: number[] = [];
    for (let t = from; t < to - 1e-9; t += 0.1) {
      let sum = 0;
      let n = 0;
      for (const b of blocks) {
        const a = Math.max(Math.round(t * SR), b.start);
        const z = Math.min(Math.round((t + 0.1) * SR), b.start + b.speechL.length);
        for (let m = a; m < z; m++) {
          sum += b.speechL[m - b.start]! ** 2;
          n++;
        }
      }
      levels.push(10 * Math.log10(sum / n));
    }
    return levels;
  }

  it('does not attenuate speech after a chunk cut inside its overlap with the next one', async () => {
    // Reference: everything appended at once.
    const ref = harness({ backend: identityBackend, aheadSeconds: 12 });
    ref.core.setActiveTimeline(1);
    appendCopies(ref, webm, 1, 1);
    ref.core.setPlayhead(playheadAt(ref, 0));
    await waitFor(() => ref.blockEnd(1) >= 12 * SR, 20_000, 'reference blocks');

    // The decoded audio first ends at 5 s, inside the first chunk's overlap (it finalizes 4.35 s).
    const h = harness({ backend: identityBackend, aheadSeconds: 12 });
    h.core.setActiveTimeline(1);
    h.core.onHook(sbAdd(1, 1));
    for (const msg of webmAppends(1, 1, webm, { appendWindowEnd: 5 })) h.core.onHook(msg);
    h.core.setPlayhead(playheadAt(h, 0));
    await settle(h, 150);
    const first = blockSpan(h.blocks(1))!;
    expect(first.start).toBe(0);
    expect(first.end).toBeLessThan(5 * SR);
    // The rest arrives: processing continues where the blocks stopped, with real context.
    for (const msg of webmAppends(1, 1, webm, { appendWindowStart: 5 })) h.core.onHook(msg);
    await waitFor(() => h.blockEnd(1) >= 12 * SR, 20_000, 'blocks after the late audio');
    const span = blockSpan(h.blocks(1))!;
    expect(span.contiguous).toBe(true);
    expect(h.posts.filter((m) => m.type === 'flush')).toEqual([{ type: 'flush' }]);

    const from = Math.ceil((first.end / SR) * 10) / 10;
    const expected = speechLevels(ref.blocks(1), from, 7);
    const actual = speechLevels(h.blocks(1), from, 7);
    const worst = Math.max(...actual.map((v, i) => Math.abs(v - expected[i]!)));
    console.log(`speech level after a cut in the overlap: worst deviation ${worst.toFixed(2)} dB over [${from}, 7) s`);
    expect(worst).toBeLessThan(0.5);
    ref.core.dispose();
    h.core.dispose();
  });
});

describe('LookaheadCore with PCM replaced under processed audio', () => {
  it('discards a chunk whose input changed during the model run; blocks always remix to the new audio', async () => {
    const source = { current: mix };
    let release: (() => void) | null = null;
    const gated: MdxBackend = {
      run: (input) =>
        new Promise((resolve) => {
          release = () => resolve(new Float32Array(input.length));
        }),
    };
    const h = createHarness({ decoderFactory: switchableDecoder(source), backend: gated, aheadSeconds: 8 });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 1);
    h.core.setPlayhead(playheadAt(h, 0));
    await waitFor(() => release !== null, 5000, 'first model run');
    // Another audio track replaces about [0, 15 s) while the model runs.
    source.current = speech;
    const { init, clusters } = splitWebm(webm);
    const replaced = clusterSpan(init, clusters, 0, 3);
    h.core.onHook(sbAppend(1, 1, init));
    for (const c of clusters.slice(0, 3)) h.core.onHook(sbAppend(1, 1, c));
    await new Promise((r) => setTimeout(r, 10));
    while (h.blockEnd(1) < 8 * SR) {
      const run = release as (() => void) | null;
      release = null;
      run?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    const blocks = h.blocks(1);
    expect(blockSpan(blocks)!.start).toBe(0);
    // Zero model: residual = the mix the model saw, which must be the new audio everywhere.
    expect(remixError(blocks, (c, m) => (m < replaced.end ? copiesAt(speech, c, m, 1) : copiesAt(mix, c, m, 1)))).toBe(0);
    h.core.dispose();
  });

  it('flushes and re-processes when audio at or after the playhead changes; a change behind it restarts a later seek back there', async () => {
    const source = { current: mix };
    const h = createHarness({ decoderFactory: switchableDecoder(source), backend: zeroBackend, aheadSeconds: 20 });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 2); // 60 s
    h.core.setPlayhead(playheadAt(h, 0));
    await waitFor(() => h.blockEnd(1) >= 20 * SR, 20_000, 'blocks');
    await settle(h, 100);
    const { init, clusters } = splitWebm(webm);

    // About [10 s, 20 s) gets other audio, ahead of the playhead: flush, then blocks from the playhead.
    source.current = speech;
    const replaced = clusterSpan(init, clusters, 2, 4);
    let before = h.posts.length;
    h.core.onHook(sbAppend(1, 1, init));
    for (const c of clusters.slice(2, 4)) h.core.onHook(sbAppend(1, 1, c));
    await waitFor(() => blockSpan(blocksAfter(h, before))?.end! >= 20 * SR, 20_000, 'blocks after the change');
    expect(h.posts.slice(before).find((m) => m.type === 'flush')).toEqual({ type: 'flush', timelineId: 1 });
    const changed = blocksAfter(h, before);
    expect(blockSpan(changed)!.start).toBe(0);
    const newAudio = (c: 0 | 1, m: number) => (m >= replaced.start && m < replaced.end ? copiesAt(speech, c, m, 2) : copiesAt(mix, c, m, 2));
    expect(remixError(changed, newAudio)).toBe(0);

    // Play on to 40 s, then [20 s, 25 s) changes behind the playhead: no flush…
    await play(h, 5, 40);
    before = h.posts.length;
    h.core.onHook(sbAppend(1, 1, init));
    h.core.onHook(sbAppend(1, 1, clusters[4]!));
    await settle(h, 100);
    expect(h.posts.slice(before).some((m) => m.type === 'flush')).toBe(false);
    // …but seeking back into it does, and the region is processed again from the new audio.
    h.core.setPlayhead(playheadAt(h, 21));
    await waitFor(() => blockSpan(blocksAfter(h, before))?.end! >= 30 * SR, 20_000, 'blocks after seeking back');
    expect(h.posts.slice(before).find((m) => m.type === 'flush')).toEqual({ type: 'flush', timelineId: 1 });
    expect(blockSpan(blocksAfter(h, before))!.start).toBe(21 * SR);
    h.core.dispose();
  });
});
