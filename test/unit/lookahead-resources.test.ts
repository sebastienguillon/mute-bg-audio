// LookaheadCore resource use and failure handling: backend release when idle, the speed guard,
// retries after failures, unusable backends, disabled and muted pages, unsupported audio.
import { readFileSync } from 'node:fs';
import { PROBE_LENGTH } from '../../src/lib/constants';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DecoderFactory, LookaheadCoreOptions } from '../../src/lib/lookahead/lookahead-core';
import { BackendTooSlowError, BackendUnavailableError, type MdxBackend } from '../../src/lib/mdx/mdx';
import type { LookaheadStatus, PlayheadInfo } from '../../src/lib/protocol';
import {
  SR,
  appendCopies,
  copiesAt,
  createHarness,
  fakeDecoderFactory,
  fixturePath,
  newDecoderLog,
  playheadAt,
  readFixtureWav,
  settle,
  waitFor,
  webmAppends,
  type Harness,
  type ProbeResultMsg,
  type Wav,
} from './helpers/lookahead-media';

/** Audio finalized by each MDX chunk after the first, in ms (step = 195840 samples at 44.1 kHz). */
const CHUNK_AUDIO_MS = (195840 / 44100) * 1000;
const TOO_SLOW = 'This computer is too slow for look-ahead processing. Using real-time mode.';

let mix: Wav;
let webm: Uint8Array;

beforeAll(() => {
  mix = readFixtureWav('mix.wav');
  webm = new Uint8Array(readFileSync(fixturePath('mix.webm')));
});

/** A zero-vocals backend counting runs and releases; `onRun` may stall or fail a run. */
function countingBackend(onRun: (run: number) => Promise<void> | void = () => {}): MdxBackend & { runs: number; releases: number } {
  const backend = {
    runs: 0,
    releases: 0,
    async run(input: Float32Array) {
      await onRun(++backend.runs);
      return new Float32Array(input.length);
    },
    release() {
      backend.releases++;
    },
  };
  return backend;
}

function harness(opts: Partial<LookaheadCoreOptions> = {}): Harness {
  return createHarness({ decoderFactory: fakeDecoderFactory(mix), ...opts });
}

function lastStatus(h: Harness): LookaheadStatus {
  return h.statuses[h.statuses.length - 1]!;
}

/** Moves the playhead to `m` and tells whether a probe of the mix ending there is found (the PCM is there). */
function probeFinds(h: Harness, m: number, copies: number, extra: Partial<PlayheadInfo> = {}): boolean {
  h.core.setPlayhead(playheadAt(h, m / SR, extra));
  const data = new Float32Array(PROBE_LENGTH);
  for (let i = 0; i < PROBE_LENGTH; i++) data[i] = 0.5 * (copiesAt(mix, 0, m - PROBE_LENGTH + i, copies) + copiesAt(mix, 1, m - PROBE_LENGTH + i, copies));
  h.core.onProbe({ type: 'probe', id: 1, frameEnd: 0, data });
  return (h.posts[h.posts.length - 1] as ProbeResultMsg).found;
}

describe('LookaheadCore backend resources', () => {
  it('releases the backend after a while without model runs and loads it again when needed', async () => {
    const backend = countingBackend();
    const h = harness({ backend, aheadSeconds: 6, idleReleaseMs: 100 });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 1);
    h.core.setPlayhead(playheadAt(h, 0));
    await waitFor(() => h.blockEnd(1) >= 6 * SR, 20_000, 'blocks');
    // At the target (paused): no run for 100 ms, so the session goes.
    expect(backend.releases).toBe(0);
    await waitFor(() => backend.releases === 1, 2000, 'idle release');
    // Playback moves on: the next run loads it again; it is released again once idle.
    const runs = backend.runs;
    h.core.setPlayhead(playheadAt(h, 10));
    await waitFor(() => h.blockEnd(1) >= 16 * SR, 20_000, 'more blocks');
    expect(backend.runs).toBeGreaterThan(runs);
    expect(backend.releases).toBe(1);
    await waitFor(() => backend.releases === 2, 2000, 'second idle release');
    // Nothing more while nothing runs.
    await new Promise((r) => setTimeout(r, 250));
    expect(backend.releases).toBe(2);
    h.core.dispose();
    expect(backend.releases).toBe(3);
  });

  it('does not run the model while the element is not audible, and keeps ingesting', async () => {
    const backend = countingBackend();
    const h = harness({ backend, aheadSeconds: 6 });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 1);
    h.core.setPlayhead(playheadAt(h, 0, { audible: false }));
    await settle(h, 200);
    expect(backend.runs).toBe(0);
    expect(h.blocks().length).toBe(0);
    // The decoded audio is there (probes are answered).
    expect(probeFinds(h, 3 * SR, 1, { audible: false })).toBe(true);
    expect(backend.runs).toBe(0);
    h.core.setPlayhead(playheadAt(h, 0));
    await waitFor(() => h.blockEnd(1) >= 6 * SR, 20_000, 'blocks once audible');
    h.core.dispose();
  });

  it('drops the decoded audio and stops decoding after a while disabled, and ingests again once enabled', async () => {
    const log = newDecoderLog();
    const h = harness({ decoderFactory: fakeDecoderFactory(mix, log), backend: countingBackend(), aheadSeconds: 6, suspendAfterMs: 100 });
    h.core.setActiveTimeline(1);
    const appends = webmAppends(1, 1, webm);
    h.core.onHook({ type: 'sb-add', msId: 1, sbId: 1, mime: 'audio/webm; codecs="opus"' });
    for (const msg of appends.slice(0, 4)) h.core.onHook(msg);
    h.core.setPlayhead(playheadAt(h, 2));
    await waitFor(() => h.blockEnd(1) >= 8 * SR, 20_000, 'blocks');
    h.core.setEnabled(false);
    // Within the first moments the PCM stays (re-enabling is instant)…
    expect(probeFinds(h, 4 * SR, 1)).toBe(true);
    // …after suspendAfterMs it is dropped and appends are no longer decoded.
    await new Promise((r) => setTimeout(r, 200));
    expect(probeFinds(h, 4 * SR, 1)).toBe(false);
    const decoded = log.decoded;
    h.core.onHook(appends[4]!);
    await settle(h, 50);
    expect(log.decoded).toBe(decoded);
    await waitFor(() => lastStatus(h).state === 'off', 2000, 'off');
    // Enabled again: nothing to process until the audio comes again ('loading', not 'ready')…
    h.core.setEnabled(true);
    h.core.setPlayhead(playheadAt(h, 3));
    await settle(h, 300);
    expect(lastStatus(h).state).toBe('loading');
    // …from the hook's replay (sb-add, init segment, recent appends), which is decoded and processed.
    const before = h.posts.length;
    h.core.onHook({ type: 'sb-add', msId: 1, sbId: 1, mime: 'audio/webm; codecs="opus"' });
    for (const msg of appends.slice(0, 6)) h.core.onHook(msg);
    await waitFor(() => h.posts.slice(before).some((m) => m.type === 'block'), 20_000, 'blocks after re-enabling');
    expect(log.decoded).toBeGreaterThan(decoded);
    await settle(h, 300);
    expect(lastStatus(h).state).toBe('ready');
    expect(h.posts.slice(before).find((m) => m.type === 'block')).toMatchObject({ start: 3 * SR });
    h.core.dispose();
  });

  it("takes the hook's replay in stride when it still has the audio: no flush, no restart", async () => {
    const log = newDecoderLog();
    const h = harness({ decoderFactory: fakeDecoderFactory(mix, log, { chromeOpus: true }), backend: countingBackend(), aheadSeconds: 6 });
    h.core.setActiveTimeline(1);
    const appends = webmAppends(1, 1, webm);
    h.core.onHook({ type: 'sb-add', msId: 1, sbId: 1, mime: 'audio/webm; codecs="opus"' });
    for (const msg of appends) h.core.onHook(msg);
    h.core.setPlayhead(playheadAt(h, 2));
    await waitFor(() => h.blockEnd(1) >= 8 * SR, 20_000, 'blocks');
    await settle(h, 100);
    // Switched off and on again within the minute: the controller reconnects the hook, which replays.
    h.core.setEnabled(false);
    h.core.setEnabled(true);
    const before = h.posts.length;
    h.core.onHook({ type: 'sb-add', msId: 1, sbId: 1, mime: 'audio/webm; codecs="opus"' });
    for (const msg of appends) h.core.onHook(msg);
    h.core.setPlayhead(playheadAt(h, 5));
    await waitFor(() => h.blockEnd(1) >= 11 * SR, 20_000, 'more blocks');
    await settle(h, 100);
    expect(h.posts.slice(before).some((m) => m.type === 'flush')).toBe(false);
    // Processing continued where it was.
    expect(h.posts.slice(before).find((m) => m.type === 'block')!.start).toBeGreaterThanOrEqual(8 * SR);
    expect(lastStatus(h).state).toBe('ready');
    h.core.dispose();
  });
});

describe('LookaheadCore speed guard', () => {
  /** A backend whose runs take `rtf` × the chunk's audio on the harness clock. */
  function slowBackend(h: { clock: { now: number } }, rtf: number) {
    return countingBackend(() => {
      h.clock.now += rtf * CHUNK_AUDIO_MS;
    });
  }

  it('stops look-ahead when the backend is slower than 0.7 × real time (after the warm-up and 3 chunks)', async () => {
    const clock = { now: 0 };
    const backend = slowBackend({ clock }, 0.9);
    const h = harness({ backend, aheadSeconds: 40, now: () => clock.now });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 2);
    h.core.setPlayhead({ ...playheadAt(h, 0), at: clock.now });
    await waitFor(() => lastStatus(h).state === 'unavailable', 20_000, 'unavailable');
    expect(lastStatus(h)).toEqual({ state: 'unavailable', reason: TOO_SLOW });
    expect(backend.runs).toBe(4);
    expect(backend.releases).toBe(1);
    // It stays stopped: no more runs.
    h.core.setPlayhead({ ...playheadAt(h, 1), at: clock.now });
    await settle(h, 100);
    expect(backend.runs).toBe(4);
    h.core.dispose();
  });

  it('measures the speed of blocks posted like the worker does (their buffers transferred)', async () => {
    const clock = { now: 0 };
    const backend = slowBackend({ clock }, 0.9);
    const h = createHarness({ decoderFactory: fakeDecoderFactory(mix), backend, aheadSeconds: 40, now: () => clock.now }, { transfer: true });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 2);
    h.core.setPlayhead({ ...playheadAt(h, 0), at: clock.now });
    await waitFor(() => lastStatus(h).state === 'unavailable', 20_000, 'unavailable');
    expect(lastStatus(h)).toEqual({ state: 'unavailable', reason: TOO_SLOW });
    expect(backend.runs).toBe(4);
    // The worklet got the blocks.
    expect(h.blocks(1).every((b) => b.speechL.length > 0 && b.residualR.length === b.speechL.length)).toBe(true);
    h.core.dispose();
  });

  it('keeps running a backend at 0.3 × real time', async () => {
    const clock = { now: 0 };
    const backend = slowBackend({ clock }, 0.3);
    const h = harness({ backend, aheadSeconds: 30, now: () => clock.now });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 2);
    h.core.setPlayhead({ ...playheadAt(h, 0), at: clock.now });
    await waitFor(() => h.blockEnd(1) >= 30 * SR, 20_000, 'blocks');
    await settle(h, 300);
    const status = lastStatus(h);
    expect(status.state).toBe('ready');
    expect(status.rtf).toBeCloseTo(0.3, 2);
    h.core.dispose();
  });

  it('stops after 3 restarts because processing fell behind playback, not after user seeks', async () => {
    // 1.2 × real time per chunk (the real-time factor check is off): processing falls behind.
    const clock = { now: 0 };
    let time = 0;
    let h: Harness;
    const playing = (t: number): PlayheadInfo => ({ ...playheadAt(h, t, { paused: false }), at: clock.now });
    const backend = countingBackend(async () => {
      // The controller keeps sending playheads (every 250 ms) while the model runs.
      for (let ms = 0; ms < 1.2 * CHUNK_AUDIO_MS; ms += 250) {
        clock.now += 250;
        time += 0.25;
        h.core.setPlayhead(playing(time));
        await Promise.resolve();
      }
    });
    h = harness({ backend, aheadSeconds: 5, maxRtf: Infinity, now: () => clock.now });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 4);
    h.core.setPlayhead(playing(0));
    await waitFor(() => lastStatus(h).state === 'unavailable', 20_000, 'unavailable');
    expect(lastStatus(h)).toEqual({ state: 'unavailable', reason: TOO_SLOW });
    expect(h.posts.filter((m) => m.type === 'flush' && m.timelineId === 1).length).toBe(2);
    expect(backend.releases).toBe(1);
    h.core.dispose();

    // The same number of forward seeks by the user is fine.
    const g = harness({ backend: countingBackend(), aheadSeconds: 5 });
    g.core.setActiveTimeline(1);
    appendCopies(g, webm, 1, 4);
    for (const t of [0, 20, 40, 60, 80]) {
      g.core.setPlayhead(playheadAt(g, t, { seeking: true }));
      g.core.setPlayhead(playheadAt(g, t));
      await waitFor(() => g.blockEnd(1) >= (t + 5) * SR, 20_000, `blocks at ${t} s`);
    }
    expect(lastStatus(g).state).toBe('ready');
    g.core.dispose();
  });
});

describe('LookaheadCore speed guard: transient slowness and other playback speeds', () => {
  const SPEED = 'Look-ahead needs normal playback speed (1×). Using real-time mode.';

  /** A backend whose runs take `rtf(run)` × the chunk's audio on `clock`. */
  function timedBackend(clock: { now: number }, rtf: (run: number) => number) {
    return countingBackend((run) => {
      clock.now += rtf(run) * CHUNK_AUDIO_MS;
    });
  }

  it('does not run the model at other speeds, and is not too slow when processing resumes at 1×', async () => {
    const clock = { now: 0 };
    let h: Harness;
    const playing = (t: number, rate = 1): PlayheadInfo => ({ ...playheadAt(h, t, { paused: false, rate }), at: clock.now });
    // Fast enough at 1×, too slow for 2×.
    const backend = timedBackend(clock, () => 0.6);
    h = harness({ backend, aheadSeconds: 5, now: () => clock.now });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 4);
    h.core.setPlayhead(playing(0));
    await waitFor(() => h.blockEnd(1) >= 5 * SR, 20_000, 'blocks at 1×');
    await settle(h, 100);
    const runs = backend.runs;
    // 2× for a minute of media: no model runs, no restarts.
    let t = 0;
    for (let i = 0; i < 120; i++) {
      clock.now += 250;
      t += 0.5;
      h.core.setPlayhead(playing(t, 2));
      if (i % 10 === 0) await settle(h, 20);
    }
    await settle(h, 300);
    expect(backend.runs).toBe(runs);
    expect(lastStatus(h)).toEqual({ state: 'unavailable', reason: SPEED });
    // Back at 1×: processing restarts at the playhead (not counted as falling behind).
    const before = h.posts.length;
    h.core.setPlayhead(playing(t));
    await waitFor(() => h.posts.slice(before).some((m) => m.type === 'block'), 20_000, 'blocks back at 1×');
    await settle(h, 300);
    expect(h.posts.slice(before).find((m) => m.type === 'block')).toMatchObject({ start: t * SR });
    expect(lastStatus(h).state).toBe('ready');
    expect(h.statuses.some((st) => st.reason === TOO_SLOW)).toBe(false);
    h.core.dispose();
  });

  it('is not stopped by one slow chunk; the real-time factor is the median of the last chunks', async () => {
    const clock = { now: 0 };
    // Steady 0.3 × real time, one chunk at 2.0 (another tab used the GPU).
    const backend = timedBackend(clock, (run) => (run === 4 ? 2 : 0.3));
    const h = harness({ backend, aheadSeconds: 40, now: () => clock.now });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 2);
    h.core.setPlayhead({ ...playheadAt(h, 0), at: clock.now });
    await waitFor(() => h.blockEnd(1) >= 40 * SR, 20_000, 'blocks');
    await settle(h, 300);
    expect(backend.runs).toBeGreaterThan(6);
    expect(h.statuses.some((st) => st.state === 'unavailable')).toBe(false);
    expect(lastStatus(h).rtf).toBeCloseTo(0.3, 2);
    h.core.dispose();
  });

  it('does not count the warm-up of the first model run when the media starts with digital silence', async () => {
    const clock = { now: 0 };
    // The first model run loads the model and compiles shaders (6 s); then 0.3 × real time.
    const backend = timedBackend(clock, (run) => (run === 1 ? 6000 / CHUNK_AUDIO_MS : 0.3));
    // The first 7 s of the media are digital silence (the model is skipped there).
    const inner = fakeDecoderFactory(mix);
    const silentIntro: DecoderFactory = (config, onOutput, onError) =>
      inner(
        config,
        (audio) => onOutput(audio.timestamp < 7 ? { ...audio, channels: audio.channels.map((c) => new Float32Array(c.length)) } : audio),
        onError,
      );
    const h = harness({ decoderFactory: silentIntro, backend, aheadSeconds: 40, now: () => clock.now });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 2);
    h.core.setPlayhead({ ...playheadAt(h, 0), at: clock.now });
    await waitFor(() => h.blockEnd(1) >= 40 * SR, 20_000, 'blocks');
    await settle(h, 300);
    expect(h.statuses.some((st) => st.state === 'unavailable')).toBe(false);
    expect(lastStatus(h)).toMatchObject({ state: 'ready' });
    expect(lastStatus(h).rtf).toBeCloseTo(0.3, 2);
    h.core.dispose();
  });

  it('tries again after a cool-down when it was too slow, or when switched off and on', async () => {
    const clock = { now: 0 };
    let slow = true;
    const backend = timedBackend(clock, () => (slow ? 0.9 : 0.3));
    const h = harness({ backend, aheadSeconds: 40, tooSlowRetryMs: 400, now: () => clock.now });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 2);
    h.core.setPlayhead({ ...playheadAt(h, 0), at: clock.now });
    await waitFor(() => lastStatus(h).state === 'unavailable', 20_000, 'unavailable');
    expect(lastStatus(h)).toEqual({ state: 'unavailable', reason: TOO_SLOW });
    const runs = backend.runs;
    // The other load is gone: after the cool-down, look-ahead runs again and stays.
    slow = false;
    await new Promise((r) => setTimeout(r, 100));
    expect(backend.runs).toBe(runs);
    await waitFor(() => h.blockEnd(1) >= 40 * SR, 20_000, 'blocks after the cool-down');
    await settle(h, 300);
    expect(lastStatus(h).state).toBe('ready');
    expect(lastStatus(h).rtf).toBeCloseTo(0.3, 2);
    h.core.dispose();

    // A run that takes far too long (BackendTooSlowError from the session backend): no retries until the cool-down…
    const failing = countingBackend((run) => {
      if (run === 1) throw new BackendTooSlowError();
    });
    const g = harness({ backend: failing, aheadSeconds: 6, retryDelaysMs: [20], tooSlowRetryMs: 60_000 });
    g.core.setActiveTimeline(1);
    appendCopies(g, webm, 1, 1);
    g.core.setPlayhead(playheadAt(g, 0));
    await waitFor(() => lastStatus(g).state === 'unavailable', 5000, 'unavailable');
    expect(lastStatus(g)).toEqual({ state: 'unavailable', reason: TOO_SLOW });
    await new Promise((r) => setTimeout(r, 150));
    expect(failing.runs).toBe(1);
    // …or until switched off and on.
    g.core.setEnabled(false);
    g.core.setEnabled(true);
    await waitFor(() => g.blockEnd(1) >= 6 * SR, 20_000, 'blocks after re-enabling');
    g.core.dispose();
  });
});

describe('LookaheadCore failures', () => {
  it('retries a failed run after a delay with a fresh session, and recovers', async () => {
    const backend = countingBackend((run) => {
      if (run === 1) throw new Error('GPU device lost');
    });
    // (Longer than the 250 ms status throttle, so the error is reported.)
    const h = harness({ backend, aheadSeconds: 6, retryDelaysMs: [400, 800, 1200] });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 1);
    h.core.setPlayhead(playheadAt(h, 0));
    await waitFor(() => h.statuses.some((s) => s.state === 'error'), 5000, 'error');
    expect(h.statuses.find((s) => s.state === 'error')).toEqual({ state: 'error', reason: 'Look-ahead processing failed: GPU device lost' });
    expect(backend.releases).toBe(1);
    await waitFor(() => h.blockEnd(1) >= 6 * SR, 20_000, 'blocks after the retry');
    await settle(h, 300);
    expect(lastStatus(h).state).toBe('ready');
    expect(h.blocks(1)[0]!.start).toBe(0);
    h.core.dispose();
  });

  it('gives up after the last retry delay; re-enabling retries', async () => {
    const backend = countingBackend(() => {
      throw new Error('out of memory');
    });
    const h = harness({ backend, aheadSeconds: 6, retryDelaysMs: [20, 40, 60] });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 1);
    h.core.setPlayhead(playheadAt(h, 0));
    await waitFor(() => backend.runs === 4, 5000, '1 run + 3 retries');
    await new Promise((r) => setTimeout(r, 300));
    expect(backend.runs).toBe(4);
    expect(lastStatus(h)).toEqual({ state: 'error', reason: 'Look-ahead processing failed: out of memory' });
    h.core.setEnabled(false);
    h.core.setEnabled(true);
    await waitFor(() => backend.runs === 5, 5000, 'retry after re-enabling');
    h.core.dispose();
  });

  it('reports a backend that can never run as unavailable, without retrying', async () => {
    const reason = 'No usable GPU for look-ahead processing. Using real-time mode.';
    const backend = countingBackend(() => {
      throw new BackendUnavailableError(reason);
    });
    const h = harness({ backend, aheadSeconds: 6, retryDelaysMs: [20] });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 1);
    h.core.setPlayhead(playheadAt(h, 0));
    await waitFor(() => lastStatus(h)?.state === 'unavailable', 5000, 'unavailable');
    expect(lastStatus(h)).toEqual({ state: 'unavailable', reason });
    await new Promise((r) => setTimeout(r, 150));
    expect(backend.runs).toBe(1);
    h.core.dispose();
  });

  it('reports a timeline whose channel layout has no stereo downmix as unavailable', async () => {
    const inner = fakeDecoderFactory(mix);
    const threeChannels: DecoderFactory = (config, onOutput, onError) =>
      inner(config, (audio) => onOutput({ ...audio, channels: [...audio.channels, audio.channels[0]!] }), onError);
    const backend = countingBackend();
    const h = harness({ decoderFactory: threeChannels, backend, aheadSeconds: 6 });
    h.core.setActiveTimeline(1);
    appendCopies(h, webm, 1, 1);
    h.core.setPlayhead(playheadAt(h, 0));
    await waitFor(() => lastStatus(h)?.state === 'unavailable', 5000, 'unavailable');
    expect(lastStatus(h)).toEqual({ state: 'unavailable', reason: 'Look-ahead does not support 3-channel audio. Using real-time mode.' });
    expect(backend.runs).toBe(0);
    h.core.dispose();
  });
});
