// Simulated playback: the page appends clusters a few seconds ahead of an advancing playhead (at
// about 8× real time), the core must keep blocks ahead of the playhead without flushing, through
// to the end of the media. The clock advances by a fixed step per 20 ms timer tick, so a loaded
// machine slows playback down instead of letting it outrun processing.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
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
