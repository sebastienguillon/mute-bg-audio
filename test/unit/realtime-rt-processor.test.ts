import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LATENCY, DFN_DELAY, RT_HOP, SAMPLE_RATE } from '../../src/lib/constants';
import type { RtFromWorker } from '../../src/lib/protocol';
import type { Dfn } from '../../src/lib/realtime/dfn';
import { RtProcessor, type RtSpeech } from '../../src/lib/realtime/rt-processor';
import { MixerHarness } from './helpers/mixer-harness';
import { maxError, maxStep } from './helpers/mixer-signals';
import { loadFixtures, siSdr } from './helpers/realtime-audio';
import { Recorder, reassemble, without, type SpeechMsg } from './helpers/realtime-harness';

const SECOND = SAMPLE_RATE;

/** A Dfn stand-in that copies input to output and throws for the hop numbers in `failing`. */
function fakeDfn(failing: ReadonlySet<number>): Dfn {
  let call = 0;
  return {
    hop: RT_HOP,
    delay: DFN_DELAY,
    process(input: Float32Array, out: Float32Array = new Float32Array(RT_HOP)): Float32Array {
      if (failing.has(call++)) throw new WebAssembly.RuntimeError('unreachable');
      out.set(input);
      return out;
    },
  } as unknown as Dfn;
}

function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

describe('RtProcessor', () => {
  let fx: ReturnType<typeof loadFixtures>;
  let length: number;
  beforeAll(() => {
    fx = loadFixtures();
    length = fx.mix.length;
  });

  it('answers a hop in its own buffer, transferred', () => {
    const rec = Recorder.create();
    expect(rec.messages).toEqual([]);
    const data = rec.sendHop(fx.mix, 2 * SECOND);
    expect(rec.messages).toHaveLength(1);
    const msg = rec.messages[0] as SpeechMsg;
    expect(msg.type).toBe('speech');
    expect(msg.index).toBe(2 * SECOND - DFN_DELAY);
    expect(msg.data).toBe(data);
    expect(rec.transfers[0]).toEqual([data.buffer]);
  });

  it('compensates the model delay: speech at the returned indices matches the clean speech', () => {
    const rec = Recorder.create();
    const hopMs: number[] = [];
    for (let i = 0; i + RT_HOP <= length; i += RT_HOP) {
      const t = performance.now();
      rec.sendHop(fx.mix, i);
      hopMs.push(performance.now() - t);
    }
    const speech = rec.speech;
    expect(speech.map((m) => m.index)).toEqual(Array.from({ length: length / RT_HOP }, (_, k) => k * RT_HOP - DFN_DELAY));

    const { estimate, covered } = reassemble(speech, length);
    const baseline = siSdr(fx.mix, fx.speech, covered);
    const aligned = siSdr(estimate, fx.speech, covered);
    const early = siSdr(estimate, fx.speech, covered, -RT_HOP);
    const late = siSdr(estimate, fx.speech, covered, RT_HOP);
    const offByOne = Math.max(siSdr(estimate, fx.speech, covered, -1), siSdr(estimate, fx.speech, covered, 1));
    console.info(
      `SI-SDR mixture ${baseline.toFixed(2)} dB, aligned ${aligned.toFixed(2)} dB, ` +
        `±1 sample ≤ ${offByOne.toFixed(2)} dB, −480 ${early.toFixed(2)} dB, +480 ${late.toFixed(2)} dB`,
    );
    expect(baseline).toBeLessThan(3);
    expect(aligned).toBeGreaterThanOrEqual(11);
    expect(offByOne).toBeLessThan(aligned);
    expect(early).toBeLessThan(aligned - 20);
    expect(late).toBeLessThan(aligned - 20);

    const stats = rec.messages.filter((m): m is Extract<RtFromWorker, { type: 'stats' }> => m.type === 'stats');
    expect(stats.length).toBe(Math.floor(length / SECOND));
    for (const s of stats) expect(s.frames).toBe(SECOND);
    const rtf = stats.map((s) => s.rtf);
    hopMs.sort((a, b) => a - b);
    console.info(
      `RTF mean ${(rtf.reduce((a, b) => a + b, 0) / rtf.length).toFixed(3)}, max ${Math.max(...rtf).toFixed(3)}; ` +
        `per hop p50 ${percentile(hopMs, 0.5).toFixed(2)} ms, p99 ${percentile(hopMs, 0.99).toFixed(2)} ms, ` +
        `max ${hopMs[hopMs.length - 1]!.toFixed(2)} ms`,
    );
    // Worst 1-s window stays below real time even with the other test files competing for the CPU.
    expect(Math.max(...rtf)).toBeLessThan(1);
  });

  it('zero-fills small gaps so the timeline stays aligned', () => {
    const dropped: Array<[number, number]> = [
      [5 * SECOND, 5 * SECOND + RT_HOP], // one hop
      [10 * SECOND, 10 * SECOND + 3 * RT_HOP], // exactly the model delay
      [15 * SECOND, 15 * SECOND + 50 * RT_HOP], // 0.5 s
      [20 * SECOND, 20 * SECOND + 99 * RT_HOP], // just under 1 s
    ];
    const isDropped = (i: number) => dropped.some(([a, b]) => i >= a && i < b);
    const rec = Recorder.create();
    const sent: number[] = [];
    for (let i = 0; i + RT_HOP <= length; i += RT_HOP) {
      if (isDropped(i)) continue;
      expect(() => rec.sendHop(fx.mix, i)).not.toThrow();
      sent.push(i);
    }

    // Every hop is answered at index − delay; the fillers add only the outputs that estimate the
    // last real frames before each gap (at most delay / hop of them), in increasing index order.
    const speech = rec.speech;
    const indices = speech.map((m) => m.index);
    for (let k = 1; k < indices.length; k++) {
      expect(indices[k]! - indices[k - 1]!).toBeGreaterThan(0);
      expect(Math.abs(indices[k]! % RT_HOP)).toBe(0);
    }
    const fillers = dropped.reduce((n, [a, b]) => n + Math.min((b - a) / RT_HOP, DFN_DELAY / RT_HOP), 0);
    expect(speech).toHaveLength(sent.length + fillers);
    const answered = new Set(indices);
    for (const i of sent) expect(answered.has(i - DFN_DELAY)).toBe(true);

    // Outside the dropped frames, the quality matches an uninterrupted run.
    const { estimate, covered } = reassemble(speech, length);
    const mask = without(covered, dropped);
    const withGaps = siSdr(estimate, fx.speech, mask);
    const full = Recorder.create();
    full.sendRange(fx.mix, 0, length);
    const uninterrupted = siSdr(reassemble(full.speech, length).estimate, fx.speech, mask);
    console.info(`small gaps: SI-SDR ${withGaps.toFixed(2)} dB (uninterrupted ${uninterrupted.toFixed(2)} dB)`);
    expect(withGaps).toBeGreaterThan(uninterrupted - 0.5);
  });

  it('continues without filling after a large gap, a backward jump or a reset', () => {
    const rec = Recorder.create();
    const answers = () => rec.speech.length;

    // Large forward gap (2 s): no fillers.
    rec.sendRange(fx.mix, 0, 6 * SECOND);
    const beforeGap = answers();
    rec.sendRange(fx.mix, 8 * SECOND, 14 * SECOND);
    expect(answers() - beforeGap).toBe((6 * SECOND) / RT_HOP);

    // Backward jump (seek back by 10 s): no fillers, indices follow the hops.
    const beforeJump = answers();
    rec.sendRange(fx.mix, 4 * SECOND, 30 * SECOND);
    const afterJump = rec.speech.slice(beforeJump);
    expect(afterJump).toHaveLength((26 * SECOND) / RT_HOP);
    afterJump.forEach((m, k) => expect(m.index).toBe(4 * SECOND + k * RT_HOP - DFN_DELAY));

    // After 100 ms the model has adapted to the new position.
    const { estimate, covered } = reassemble(afterJump, length);
    const settled = without(covered, [[0, 4 * SECOND + SECOND / 10]]);
    const score = siSdr(estimate, fx.speech, settled);
    console.info(`after backward jump: SI-SDR ${score.toFixed(2)} dB`);
    expect(score).toBeGreaterThanOrEqual(11);

    // A reset forgets the expected index: a following small gap is not filled.
    rec.processor.onMessage({ type: 'reset' });
    const beforeReset = answers();
    rec.sendHop(fx.mix, 0, 30 * SECOND + 2 * RT_HOP);
    expect(answers() - beforeReset).toBe(1);
    expect(rec.speech.at(-1)!.index).toBe(30 * SECOND + 2 * RT_HOP - DFN_DELAY);
    // ...but the gap after the next hop is.
    rec.sendHop(fx.mix, 0, 30 * SECOND + 4 * RT_HOP);
    expect(answers() - beforeReset).toBe(3);
  });

  it('reports the real-time factor every statsEveryFrames processed frames', () => {
    let clock = 0;
    const rec = new Recorder(fakeDfn(new Set()), {
      statsEveryFrames: 10 * RT_HOP,
      now: () => (clock += 0.25), // every hop takes 0.25 ms between its two clock reads
    });
    const hop = new Float32Array(RT_HOP);
    for (let k = 0; k < 25; k++) rec.processor.onMessage({ type: 'hop', index: k * RT_HOP, data: hop.slice() });
    const hopMs = (RT_HOP * 1000) / SAMPLE_RATE;
    const stats = () => rec.messages.filter((m) => m.type === 'stats');
    expect(stats()).toEqual([
      { type: 'stats', rtf: 0.25 / hopMs, frames: 10 * RT_HOP },
      { type: 'stats', rtf: 0.25 / hopMs, frames: 10 * RT_HOP },
    ]);
    // Filler hops count as processed frames.
    rec.processor.onMessage({ type: 'hop', index: 30 * RT_HOP, data: hop.slice() });
    expect(stats().at(-1)).toEqual({ type: 'stats', rtf: (6 * 0.25) / (11 * hopMs), frames: 11 * RT_HOP });
  });

  it('answers a model failure with the delayed input and reports failures at most every 10 s', () => {
    let clock = 0;
    const failing = [3, 4, 10, 30];
    const rec = new Recorder(fakeDfn(new Set(failing)), { now: () => clock });
    const answers: Float32Array[] = [];
    for (let k = 0; k < 40; k++) {
      clock = k * 500; // 0.5 s between hops
      const data = new Float32Array(RT_HOP).fill(k + 1);
      rec.processor.onMessage({ type: 'hop', index: k * RT_HOP, data });
      answers.push(data);
    }
    // At 1.5 s and (suppressed until 11.5 s) at 15 s.
    const errors = rec.messages.filter((m) => m.type === 'error');
    expect(errors).toEqual([
      { type: 'error', message: 'DeepFilterNet failed: unreachable' },
      { type: 'error', message: 'DeepFilterNet failed: unreachable' },
    ]);
    expect(rec.speech.map((m) => m.data)).toEqual(answers);
    expect(rec.speech.map((m) => m.index)).toEqual(answers.map((_, k) => k * RT_HOP - DFN_DELAY));
    // A failed hop answers the input of the frames its speech stands for (hop k − 3): mixed back,
    // that is the unchanged input, not the speech removed with the music.
    answers.forEach((data, k) => expect(data.every((v) => v === (failing.includes(k) ? k - 2 : k + 1))).toBe(true));
    // …marked as such: the worklet then crossfades to its own pass-through.
    const marked = rec.speech.map((m) => (m as RtSpeech).passthrough === true);
    expect(marked).toEqual(answers.map((_, k) => failing.includes(k)));
  });

  it('treats a hop of the wrong length as a failure without throwing', () => {
    const rec = Recorder.create();
    const bad = new Float32Array(7).fill(1);
    expect(() => rec.processor.onMessage({ type: 'hop', index: 0, data: bad })).not.toThrow();
    expect(rec.messages.filter((m) => m.type === 'error')).toEqual([
      { type: 'error', message: 'DeepFilterNet failed: Dfn.process expects 480 samples (input 7, output 7)' },
    ]);
    expect(rec.speech[0]).toEqual({ type: 'speech', index: -DFN_DELAY, data: new Float32Array(7), passthrough: true });
    rec.sendRange(fx.mix, RT_HOP, 2 * SECOND);
    expect(rec.messages.filter((m) => m.type === 'error')).toHaveLength(1);
    expect(rec.speech).toHaveLength((2 * SECOND) / RT_HOP);
    expect(rec.speech.at(-1)!.index).toBe(2 * SECOND - RT_HOP - DFN_DELAY);
    expect(rec.speech.some((m) => m.data.some((v) => v !== 0))).toBe(true);
  });
});

/** A Dfn stand-in whose output is −input and whose every call advances `clock` by `ms`. */
function timedDfn(clock: { now: number }, ms: number): Dfn & { calls: number } {
  const dfn = {
    hop: RT_HOP,
    delay: DFN_DELAY,
    calls: 0,
    process(input: Float32Array, out: Float32Array = new Float32Array(RT_HOP)): Float32Array {
      dfn.calls++;
      clock.now += ms;
      for (let i = 0; i < input.length; i++) out[i] = -input[i]!;
      return out;
    },
  };
  return dfn as unknown as Dfn & { calls: number };
}

/**
 * Feeds `count` hops (hop k holds the value k + 1) to a single-threaded worker in the order
 * they arrive (`arrival(k)`, ms), and returns the answers and the longest queueing delay.
 */
function simulateQueue(rec: Recorder, clock: { now: number }, count: number, arrival: (k: number) => number) {
  let free = 0;
  let maxWait = 0;
  for (let k = 0; k < count; k++) {
    const start = Math.max(arrival(k), free);
    maxWait = Math.max(maxWait, start - arrival(k));
    clock.now = start;
    rec.processor.onMessage({ type: 'hop', index: k * RT_HOP, data: new Float32Array(RT_HOP).fill(k + 1) });
    free = clock.now;
  }
  return { maxWait, speech: rec.speech };
}

describe('RtProcessor under load', () => {
  it('skips the model for stale hops so that a model slower than real time keeps a bounded backlog', () => {
    const clock = { now: 0 };
    const dfn = timedDfn(clock, 12); // 12 ms per 10 ms hop
    const rec = new Recorder(dfn, { now: () => clock.now });
    const count = 1000;
    const { maxWait, speech } = simulateQueue(rec, clock, count, (k) => k * 10);
    // Processing everything would leave the last hop 2 s behind.
    expect(maxWait).toBeLessThan(60 + 12 + 1);
    expect(dfn.calls).toBeLessThan(count * (10 / 12) + 10);
    // Every hop is still answered, in order, in its own buffer…
    expect(speech.map((m) => m.index)).toEqual(Array.from({ length: count }, (_, k) => k * RT_HOP - DFN_DELAY));
    // …with the model's speech (−input) or, when the model was skipped or its output still
    // reflects skipped input, the delayed input (that of hop k − 3).
    let delayed = 0;
    speech.forEach((m, k) => {
      const v = m.data[0]!;
      expect(m.data.every((x) => x === v)).toBe(true);
      expect(v === -(k + 1) || v === Math.max(0, k - 2)).toBe(true);
      expect((m as RtSpeech).passthrough === true).toBe(v !== -(k + 1));
      if (v !== -(k + 1)) delayed++;
    });
    expect(delayed).toBeGreaterThan(count / 10);
    // After each skipped run the next 3 model outputs are replaced: a model output is never
    // directly preceded by fewer than 3 replaced hops.
    const usedModel = speech.map((m, k) => m.data[0] === -(k + 1));
    for (let k = 1; k < count; k++) {
      if (!usedModel[k] || usedModel[k - 1]) continue;
      expect(usedModel.slice(Math.max(0, k - 3), k).some((u) => u)).toBe(false);
    }
  });

  it('does not take bursts of hops for a backlog', () => {
    const clock = { now: 0 };
    const dfn = timedDfn(clock, 1);
    const rec = new Recorder(dfn, { now: () => clock.now });
    // Hops arrive in bursts of 8 (an 80 ms audio callback), and once 100 ms late.
    const arrival = (k: number) => Math.floor(k / 8) * 80 + 80 + (k >= 400 && k < 408 ? 100 : 0);
    const { speech } = simulateQueue(rec, clock, 800, arrival);
    expect(dfn.calls).toBe(800);
    speech.forEach((m, k) => expect(m.data[0]).toBe(-(k + 1)));
  });
});

describe('RtProcessor wired to MixerCore', () => {
  it('a model stall gives pass-through answers that are crossfaded, not clicks', () => {
    const n = 6 * SECOND;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 130 * i) / SECOND);
    // A large jitter allowance (60 ms), so that the pass-through answers after the stall
    // (stale hops, then the misaligned ones) arrive in time and are mixed.
    const h = new MixerHarness(x, x, { jitter: 2880 });
    const clock = { now: 0 };
    // 2 ms per hop, except one 150 ms stall at 2 s; the model's speech estimate is 0.
    const dfn = {
      hop: RT_HOP,
      delay: DFN_DELAY,
      process(_input: Float32Array, out: Float32Array = new Float32Array(RT_HOP)): Float32Array {
        clock.now += clock.now >= 2000 && clock.now < 2002 ? 150 : 2;
        return out.fill(0);
      },
    } as unknown as Dfn;
    let passthrough = 0;
    const processor = new RtProcessor(
      dfn,
      (msg) => {
        if (msg.type !== 'speech') return;
        if ((msg as RtSpeech).passthrough) passthrough++;
        // Delivered when the worker finished it (in frames).
        const at = Math.ceil((clock.now * SECOND) / 1000);
        h.schedule(Math.max(0, at - h.frame), () => h.core.onRt(msg));
      },
      { now: () => clock.now },
    );
    let busyUntil = 0;
    h.connectRt({
      receive: (msg) => {
        if (msg.type === 'hop') clock.now = Math.max((h.frame * 1000) / SECOND, busyUntil);
        processor.onMessage(msg);
        busyUntil = clock.now;
      },
    });
    h.config({ enabled: true, residualGain: 0 });
    h.runUntil(n);
    expect(passthrough).toBeGreaterThan(3);
    // Model output (0) and the input (pass-through) only meet in crossfades.
    const natural = maxStep(x, 0, n);
    expect(maxStep(h.outL, SECOND, n)).toBeLessThan(natural + 0.002);
    expect(h.stats().at(-1)).toMatchObject({ mode: 'realtime', rtHealthy: true });
  });

  it('a model that always fails leaves the input unchanged instead of removing the speech', () => {
    const n = 2 * SECOND;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin(i / 9) + 0.1 * Math.sin(i / 3.7);
    const h = new MixerHarness(x, x);
    const broken = fakeDfn(new Set(Array.from({ length: n / RT_HOP + 10 }, (_, k) => k)));
    const processor = new RtProcessor(broken, (msg) => {
      if (msg.type === 'speech') h.schedule(0, () => h.core.onRt(msg));
    });
    h.connectRt({ receive: (msg) => processor.onMessage(msg) });
    h.config({ enabled: true, residualGain: 0 }); // "Remove"
    h.runUntil(n);
    // Pass-through answers: the delayed input itself, with the worker counted as alive.
    expect(h.stats().at(-1)).toMatchObject({ mode: 'passthrough', rtHealthy: true, latency: DEFAULT_LATENCY });
    expect(maxError(h.outL, DEFAULT_LATENCY + 480, n, (f) => x[f - DEFAULT_LATENCY]!)).toBe(0);
  });
});
