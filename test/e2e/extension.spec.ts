// Audio processing on the YouTube-like test pages: quality, latency and sync, live settings, seeks,
// pauses. www.youtube.com is mapped to the local test server (see fixtures.ts).
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  debugStatus,
  expect,
  ExtensionWorld,
  mediaTime,
  playbackAdvances,
  record,
  startPlayback,
  test,
  waitForMediaTime,
  waitForMode,
  waitForStatus,
  YT,
  type DebugSnapshot,
  type Recording,
} from './fixtures';
import {
  firstSound,
  loadStems,
  locate,
  longestDropoutMs,
  longestZeroRun,
  mid,
  musicGainDb,
  outputLead,
  rms,
  siSdr,
  speechCoverage,
  speechQuality,
  testStems,
  trailingSilence,
} from './audio';
import { DEFAULT_LATENCY, SAMPLE_RATE } from '../../src/lib/constants';

const ms = (frames: number) => ((frames / SAMPLE_RATE) * 1000).toFixed(1);
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test.describe('YouTube-like MSE player', () => {
  test('look-ahead mode removes the music, in sync with the picture', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto', gapReduction: false });
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    await page.goto(`${YT}/mse.html`);
    await startPlayback(page);
    const st = await waitForMode(page, ['lookahead'], 90_000);
    const sink = await world.waitForSinkLatency();
    const rec = await record(page, 6);
    const q = speechQuality(rec);
    console.log('look-ahead', JSON.stringify(q), JSON.stringify(st.mixer), 'sink latency', sink, `(${ms(sink)} ms)`);
    expect(q.outRms).toBeGreaterThan(0.01);
    expect(q.improvement).toBeGreaterThan(12);
    // The output leads the element's audio by the sink latency (it is heard with the picture).
    expect(Math.abs(q.leadFrames - sink)).toBeLessThanOrEqual(96);
  });

  test('real-time mode removes the music with latency L', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'realtime', gapReduction: false });
    const page = await context.newPage();
    await page.goto(`${YT}/mse.html`);
    await startPlayback(page);
    await waitForMode(page, ['realtime'], 60_000);
    await page.waitForTimeout(1000);
    const rec = await record(page, 6);
    const st = (await debugStatus(page))!;
    const q = speechQuality(rec);
    console.log('real-time', JSON.stringify(q), JSON.stringify(st.mixer));
    expect(q.outRms).toBeGreaterThan(0.01);
    expect(q.improvement).toBeGreaterThan(5);
    expect(st.mixer!.mode).toBe('realtime');
    expect(Math.abs(q.leadFrames + st.mixer!.latency)).toBeLessThanOrEqual(96);
  });

  test('A/V sync: look-ahead output leads the element audio by the sink latency, real-time lags by L', async ({ context, setSettings }) => {
    // 12 dB: the output keeps a quarter of the music, so it correlates with the input everywhere.
    await setSettings({ reductionDb: 12, quality: 'auto', gapReduction: false });
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    await page.goto(`${YT}/mse.html`);
    await startPlayback(page);
    await waitForStatus(page, (s) => s.mixer?.mode === 'lookahead' && s.mixer.locked, 'look-ahead lock', 90_000);
    await world.waitForSinkLatency();
    const la = outputLead(await record(page, 4));
    const sink = await world.outputLatency();
    await setSettings({ quality: 'realtime' });
    await waitForStatus(page, (s) => s.mixer?.mode === 'realtime', 'real-time mode', 10_000);
    await page.waitForTimeout(1000);
    const rt = outputLead(await record(page, 4));
    const L = (await debugStatus(page))!.mixer!.latency;
    console.log(
      `A/V sync: sink latency D = ${sink.frames} frames (${ms(sink.frames)} ms; baseLatency ${sink.baseLatency}, outputLatency ${sink.outputLatency});`,
      `look-ahead output lag ${-la.lead} frames (${ms(-la.lead)} ms, score ${la.score.toFixed(3)});`,
      `real-time L = ${L}, output lag ${-rt.lead} frames (${ms(-rt.lead)} ms, score ${rt.score.toFixed(3)})`,
    );
    expect(sink.frames).toBeGreaterThan(0);
    expect(Math.abs(-la.lead + sink.frames)).toBeLessThanOrEqual(96); // lag ≈ −D ± 2 ms
    expect(Math.abs(-rt.lead - L)).toBeLessThanOrEqual(96); // lag ≈ L ± 2 ms
  });

  for (const quality of ['realtime', 'auto'] as const) {
    test(`music reduction follows the slider live (${quality})`, async ({ context, setSettings }) => {
      await setSettings({ reductionDb: 12, quality, gapReduction: false });
      const page = await context.newPage();
      await page.goto(`${YT}/mse.html`);
      await startPlayback(page);
      await waitForMode(page, [quality === 'auto' ? 'lookahead' : 'realtime'], 90_000);
      await page.waitForTimeout(500);
      const partial = musicGainDb(await record(page, 4));
      await setSettings({ reductionDb: 60 });
      await page.waitForTimeout(300);
      const full = musicGainDb(await record(page, 4));
      console.log(quality, 'music gain at 12 dB:', partial.toFixed(1), 'dB; at remove:', full.toFixed(1), 'dB');
      expect(partial).toBeGreaterThan(-15);
      expect(partial).toBeLessThan(-9);
      expect(full).toBeLessThan(-20);
    });
  }

  test('seeking keeps audio flowing and returns to look-ahead', async ({ context, setSettings }) => {
    // 12 dB: the output is never legitimately silent while the input plays (with full removal,
    // pauses between words are silent).
    await setSettings({ reductionDb: 12, quality: 'auto', gapReduction: false });
    const page = await context.newPage();
    await page.goto(`${YT}/mse.html?ahead=40`);
    await startPlayback(page);
    await waitForMode(page, ['lookahead'], 90_000);
    await page.evaluate(() => { document.querySelector('video')!.currentTime = 3; });
    const rec = await record(page, 3);
    // Right after the element resumes, real-time output starts after its latency L (60 ms) plus
    // the 10 ms crossfade; the mixer holds silence rather than repeat content it already played.
    const d = longestDropoutMs(rec);
    console.log('dropout ms', d.dropoutMs, 'element silence ms', d.elementSilenceMs);
    expect(d.dropoutMs).toBeLessThan(100);
    await waitForMode(page, ['lookahead'], 30_000);
  });

  test('turning the tab off gives the element its direct path back; turning it on processes again', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'realtime' });
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    await page.goto(`${YT}/mse.html`);
    await world.traceAudioGraph();
    await startPlayback(page);
    await waitForMode(page, ['realtime', 'lookahead'], 60_000);
    expect(await world.audioRoutes()).toEqual({ sources: [['mixer']], mixer: ['speakers'] });
    await setSettings({ enabled: false });
    const off = await waitForStatus(page, (s) => s.status.mode === 'off' && s.graph.path === 'direct' && !s.graph.settling, 'direct path', 10_000);
    // Element → speakers, nothing in between: zero latency, unchanged audio (the mixer cannot record it).
    expect(await world.audioRoutes()).toEqual({ sources: [['speakers']], mixer: [] });
    expect(await world.sourceLevel()).toBeGreaterThan(0.01);
    await expect(record(page, 1)).rejects.toThrow(/not in the audio path/);
    expect(off.graph.sources).toBe(1);
    await setSettings({ enabled: true });
    await waitForMode(page, ['realtime'], 15_000);
    expect(await world.audioRoutes()).toEqual({ sources: [['mixer']], mixer: ['speakers'] });
    expect(rms((await record(page, 1)).output[0]!)).toBeGreaterThan(0.005);
    expect(world.exceptions).toEqual([]);
  });

  test('the element volume still applies', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'realtime' });
    const page = await context.newPage();
    await page.goto(`${YT}/mse.html`);
    await startPlayback(page);
    await waitForMode(page, ['realtime', 'lookahead'], 60_000);
    await page.waitForTimeout(500);
    const loud = await record(page, 2);
    await page.evaluate(() => { document.querySelector('video')!.volume = 0.25; });
    await page.waitForTimeout(300);
    const quiet = await record(page, 2);
    const ratio = rms(quiet.input[0]!) / rms(loud.input[0]!);
    const outRatio = rms(quiet.output[0]!) / rms(loud.output[0]!);
    console.log('volume ratios in/out', ratio.toFixed(3), outRatio.toFixed(3));
    expect(outRatio).toBeLessThan(0.5);
  });

  for (const quality of ['realtime', 'auto'] as const) {
    test(`a paused video idles the mixer and resumes processing (${quality})`, async ({ context, setSettings }) => {
      await setSettings({ reductionDb: 60, quality });
      const page = await context.newPage();
      await page.goto(`${YT}/mse.html`);
      await startPlayback(page);
      const mode = quality === 'auto' ? 'lookahead' : 'realtime';
      await waitForMode(page, [mode], 90_000);
      await page.evaluate(() => document.querySelector('video')!.pause());
      const t0 = Date.now();
      const idle = await waitForStatus(page, (s) => s.mixer?.mode === 'idle', 'mixer idle', 5_000, 100);
      const idleMs = Date.now() - t0;
      const paused = await waitForStatus(page, (s) => s.status.mode === 'waiting', 'waiting status', 2_000, 100);
      console.log(quality, 'mixer idle', idleMs, 'ms after pause;', JSON.stringify(idle.mixer), JSON.stringify(paused.status));
      expect(idleMs).toBeLessThan(2_000);
      expect(paused.status.detail).toBe('Paused.');
      // Stays idle (no hops, no probes) while paused.
      await page.waitForTimeout(3_000);
      expect((await debugStatus(page))!.mixer!.mode).toBe('idle');
      await page.evaluate(() => document.querySelector('video')!.play());
      const t1 = Date.now();
      await waitForMode(page, [mode], 15_000);
      console.log(quality, mode, 'again', Date.now() - t1, 'ms after play');
    });
  }

  /**
   * Plays the 90 s clip until the look-ahead session has processed more than the 60 s of blocks
   * the mixer keeps (appended up to 45 s ahead), then seeks back to 2 s: content near the start is
   * no longer stored (blocks, and PCM older than 30 s behind the playhead). Before that the video
   * is paused at 40.00 s, so the PCM kept from before the seek starts exactly at 10.00 s, a
   * 20 ms Opus frame boundary. Returns the time of the seek back (Date.now()).
   */
  async function seekFarBack(page: Page): Promise<number> {
    await page.goto(`${YT}/mse.html?media=long&ahead=45`);
    await startPlayback(page);
    await waitForMode(page, ['lookahead'], 90_000);
    let processedEnd = 0;
    let time = 0;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      time = await page.evaluate(() => document.querySelector('video')!.currentTime);
      processedEnd = time + ((await debugStatus(page))!.status.lookahead?.aheadSeconds ?? 0);
      if (processedEnd > 68) break;
      await page.waitForTimeout(1000);
    }
    console.log('processed to', processedEnd.toFixed(1), 's at playhead', time.toFixed(1), 's');
    expect(processedEnd).toBeGreaterThan(68);
    expect(time).toBeLessThan(40);
    await page.evaluate(async () => {
      const v = document.querySelector('video')!;
      v.pause();
      v.currentTime = 40;
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }));
    });
    // The controller reports the paused playhead (and the look-ahead core evicts around it).
    await page.waitForTimeout(1000);
    await page.evaluate(() => {
      const v = document.querySelector('video')!;
      v.currentTime = 2;
      void v.play();
    });
    const seekAt = Date.now();
    // Mixer stats cover 0.5 s: wait until they only describe audio after the seek.
    await page.waitForTimeout(1000);
    return seekAt;
  }

  test('a backward seek far behind the playhead regains look-ahead', async ({ context, setSettings }) => {
    test.setTimeout(240_000);
    await setSettings({ reductionDb: 60, quality: 'auto', gapReduction: false });
    const page = await context.newPage();
    const t0 = await seekFarBack(page);
    const back = await waitForStatus(page, (s) => s.mixer?.mode === 'lookahead' && s.mixer.locked, 'look-ahead after the seek', 9_000);
    console.log('look-ahead within', Date.now() - t0, 'ms of seeking back to 2 s', JSON.stringify(back.status.lookahead));
    expect(await page.evaluate(() => document.querySelector('video')!.currentTime)).toBeLessThan(15);
  });

  // The PCM from before the seek was evicted: the look-ahead worker re-decodes the frames it kept.
  // A re-decode must run past the end of the gap (the Opus decoder holds back its codec delay until
  // the next frame), or a hole remains at the junction and look-ahead runs dry there.
  test('look-ahead keeps running after a backward seek into evicted audio', async ({ context, setSettings }) => {
    test.setTimeout(240_000);
    await setSettings({ reductionDb: 60, quality: 'auto', gapReduction: false });
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    await seekFarBack(page);
    await waitForStatus(page, (s) => s.mixer?.mode === 'lookahead' && s.mixer.locked, 'look-ahead after the seek', 9_000);
    // Through the junction at 10 s.
    for (const t0 = Date.now(); Date.now() - t0 < 11_000; ) {
      const time = await page.evaluate(() => document.querySelector('video')!.currentTime);
      expect((await debugStatus(page))!.mixer?.mode, `mixer mode at media time ${time.toFixed(2)} s`).toBe('lookahead');
      await page.waitForTimeout(250);
    }
    const q = speechQuality(await record(page, 3));
    expect(q.improvement).toBeGreaterThan(12);
    expect(Math.abs(q.leadFrames - (await world.outputLatency()).frames)).toBeLessThanOrEqual(96);
  });

  test('replay after the end regains look-ahead', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto' });
    const page = await context.newPage();
    await page.goto(`${YT}/mse.html?ahead=40`);
    await startPlayback(page);
    await waitForMode(page, ['lookahead'], 90_000);
    // One session processes the whole clip, then the end is played within it (no restart): the
    // replay starts inside content the session already processed.
    const deadline = Date.now() + 30_000;
    let processedEnd = 0;
    while (Date.now() < deadline && processedEnd < 29.5) {
      const time = await page.evaluate(() => document.querySelector('video')!.currentTime);
      processedEnd = time + ((await debugStatus(page))!.status.lookahead?.aheadSeconds ?? 0);
      await page.waitForTimeout(250);
    }
    expect(processedEnd).toBeGreaterThanOrEqual(29.5);
    await page.evaluate(() => { document.querySelector('video')!.currentTime = 25; });
    await waitForMode(page, ['lookahead'], 15_000);
    await page.waitForFunction(() => document.querySelector('video')!.ended, null, { timeout: 15_000 });
    await waitForStatus(page, (s) => s.mixer?.mode === 'idle', 'mixer idle after the end', 5_000);
    await page.evaluate(async () => {
      const v = document.querySelector('video')!;
      v.currentTime = 0;
      await v.play();
    });
    const t0 = Date.now();
    await waitForMode(page, ['lookahead'], 10_000);
    console.log('look-ahead again', Date.now() - t0, 'ms after replay');
    expect(await playbackAdvances(page)).toBe(true);
  });
});

/** Records `seconds` while polling the debug status every 100 ms (with the media time of each poll). */
async function recordPolling(page: Page, seconds: number): Promise<{ rec: Recording; polls: { time: number; s: DebugSnapshot }[] }> {
  let done = false;
  const recording = record(page, seconds).finally(() => (done = true));
  const polls: { time: number; s: DebugSnapshot }[] = [];
  while (!done) {
    const [time, s] = await Promise.all([mediaTime(page), debugStatus(page)]);
    if (s) polls.push({ time, s });
    await page.waitForTimeout(100);
  }
  return { rec: await recording, polls };
}

test.describe('look-ahead through silence, pauses and speed changes', () => {
  // The gapped clip (test/e2e/media.mjs, AAC): digital silence of 0.9 s and 1.4 s at the mixer's
  // input (longer than its 0.5 s idle threshold), each right before a word. While the element
  // plays, silence in the content must keep the lock: look-ahead output goes on through the gap
  // and its end, in sync, with no skip and no silence inserted.
  test('digital silence inside speech keeps the look-ahead lock; nothing after the gap is skipped', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto', gapReduction: false });
    const stems = loadStems('test/fixtures/generated/e2e/gap-mix.wav', 'test/fixtures/generated/e2e/gap-speech.wav');
    const { gaps } = json('test/fixtures/generated/e2e/gap.json') as { gaps: { start: number; end: number }[] };
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    await page.goto(`${YT}/mse.html?media=gap&audio=mp4`);
    await startPlayback(page);
    await waitForStatus(page, (s) => s.mixer?.mode === 'lookahead' && s.mixer.locked, 'look-ahead lock', 90_000);
    const sink = await world.waitForSinkLatency();
    // Look-ahead output may start up to 1.5 s after the lock (at a pause in the speech).
    const startAt = (await mediaTime(page)) + 1.6;
    let count = 0;
    for (const gap of gaps) {
      if (gap.start - 1.5 < startAt) continue;
      count++;
      await waitForMediaTime(page, gap.start - 1.5);
      const { rec, polls } = await recordPolling(page, gap.end - gap.start + 3.6);
      const inM = mid(rec.input), outM = mid(rec.output);
      const zeros = longestZeroRun(inM);
      // Located before the gap only: after it, the output must go on with the same alignment.
      const out = locate(outM.subarray(0, zeros.start - sink - 4800), stems.speech, 0.8);
      const input = locate(inM, stems.mix, 0.8);
      expect(out, 'output located before the gap').not.toBeNull();
      expect(input, 'input located').not.toBeNull();
      const end = Math.round(gap.end * SAMPLE_RATE), start = Math.round(gap.start * SAMPLE_RATE);
      const span = Math.round(1.5 * SAMPLE_RATE), lead = SAMPLE_RATE;
      const outAt = (c: number) => c - out!.offset;
      const quality = (c: number, n: number) => siSdr(outM.subarray(outAt(c), outAt(c) + n), stems.speech.subarray(c, c + n));
      const before = quality(start - lead, lead), after = quality(end, span);
      // Speech level right after the onset (200 ms), relative to the output's gain before the gap.
      const ref = stems.speech.subarray(start - lead, start), pre = outM.subarray(outAt(start - lead), outAt(start));
      let dot = 0, rr = 0;
      for (let i = 0; i < ref.length; i++) { dot += pre[i]! * ref[i]!; rr += ref[i]! ** 2; }
      const onset = Math.round(0.2 * SAMPLE_RATE);
      const onsetLevel = rms(outM, outAt(end), outAt(end) + onset) / ((dot / rr) * rms(stems.speech, end, end + onset));
      const L = polls.find((p) => p.s.mixer?.mode === 'realtime')?.s.mixer?.latency ?? DEFAULT_LATENCY;
      const coverage = speechCoverage(rec, stems.speech, input!.offset, end, end + span, sink, L);
      const around = polls.filter((p) => p.time > gap.start - 0.5 && p.time < gap.end + 1.5);
      console.log(
        `gap ${gap.start.toFixed(2)}–${gap.end.toFixed(2)} s: input digital silence ${(zeros.length / SAMPLE_RATE).toFixed(3)} s;`,
        `SI-SDR 1 s before ${before.toFixed(1)} dB, 1.5 s after ${after.toFixed(1)} dB; onset level ${onsetLevel.toFixed(2)};`,
        `output lead ${out!.offset - input!.offset} (sink ${sink}); coverage ${JSON.stringify({ ...coverage, missing: coverage.missing.map((t) => t.toFixed(2)) })};`,
        'modes', [...new Set(around.map((p) => `${p.s.mixer?.mode}${p.s.mixer?.locked ? '+lock' : ''}`))].join(' '),
      );
      expect(zeros.length).toBeGreaterThan(0.8 * SAMPLE_RATE);
      expect(Math.abs(out!.offset - input!.offset - sink)).toBeLessThanOrEqual(96);
      expect(around.every((p) => p.s.mixer?.locked === true), 'locked throughout the gap').toBe(true);
      expect(around.every((p) => p.s.graph.playing === true)).toBe(true);
      // A skip, a hold or real-time output (L + D later) after the gap would give about 0 dB here.
      expect(after).toBeGreaterThan(10);
      expect(onsetLevel).toBeGreaterThan(0.5);
      expect(coverage.windows).toBeGreaterThan(20);
      expect(coverage.missing).toEqual([]);
    }
    expect(count, 'gaps played after the lock').toBeGreaterThan(0);
  });

  // Pauses 1.2 s before the end of a sentence: on resume, real-time output plays first, the lock
  // comes back within the sentence, and the switch to look-ahead (which skips L + D of content)
  // must wait for the pause at the end of it.
  test('pausing in look-ahead mode plays nothing beyond the pause point; resuming skips no words', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto', gapReduction: false });
    const stems = testStems();
    const lines = (json('test/fixtures/generated/timeline.json') as { placements: { end: number }[] }).placements.slice(0, -1);
    const page = await context.newPage();
    const world = await ExtensionWorld.attach(page);
    await page.goto(`${YT}/mse.html`);
    await startPlayback(page);
    await waitForStatus(page, (s) => s.mixer?.mode === 'lookahead' && s.mixer.locked, 'look-ahead lock', 90_000);
    const sink = await world.waitForSinkLatency();
    const now = await mediaTime(page);
    const sentenceEnd = lines.map((l) => l.end).find((end) => end - 2.7 > now);
    expect(sentenceEnd, `a sentence end after ${now.toFixed(1)} s`).toBeDefined();
    const pauseAt = sentenceEnd! - 1.2;
    await waitForMediaTime(page, pauseAt - 1);
    const recording = record(page, 2.2);
    await waitForMediaTime(page, pauseAt);
    await page.evaluate(() => document.querySelector('video')!.pause());
    const paused = await recording;
    const st = await waitForStatus(page, (s) => s.graph.playing === false && s.mixer?.locked === false, 'unlocked by the pause', 2_000, 100);
    {
      const inM = mid(paused.input), outM = mid(paused.output);
      const p = trailingSilence(inM);
      const input = locate(inM.subarray(0, p), stems.mix, 0.8);
      expect(input, 'input located').not.toBeNull();
      expect(outM.length - p, 'the recording holds 0.5 s of the pause').toBeGreaterThan(SAMPLE_RATE / 2);
      // Gain of the speech stem in the output at the look-ahead position (content f + offset + D),
      // over [a, b): about the element gain while look-ahead plays, 0 when nothing of it is there.
      const laGain = (a: number, b: number) => {
        let dot = 0, ss = 0;
        for (let i = a; i < b; i++) {
          const v = stems.speech[i + input!.offset + sink] ?? 0;
          dot += outM[i]! * v;
          ss += v * v;
        }
        return dot / (ss || 1);
      };
      const W = SAMPLE_RATE / 100;
      const before = laGain(p - SAMPLE_RATE / 2, p - 2 * W);
      const after = laGain(p + W, outM.length);
      // What still plays after the input stopped (the sink latency D already in the device buffer
      // is not in the recording): 10 ms windows above −40 dB of the speech before the pause.
      const level = rms(outM, p - SAMPLE_RATE / 2, p - 2 * W);
      let audible = 0, last = 0;
      for (let i = p; i + W <= outM.length; i += W) if (rms(outM, i, i + W) > 0.01 * level) { audible += W; last = i + W - p; }
      console.log(`paused at media time ${(await mediaTime(page)).toFixed(2)} s: speech after the pause point at the look-ahead`,
        `position ${(after / before).toFixed(4)} of before; ${ms(audible)} ms audible, the last ${ms(last)} ms after the input stopped;`,
        JSON.stringify(st.mixer));
      expect(level).toBeGreaterThan(0.005);
      expect(Math.abs(after / before)).toBeLessThan(0.05);
      // Nothing plays on while paused.
      expect(rms(outM, p + Math.round(0.15 * SAMPLE_RATE))).toBeLessThan(1e-5);
    }
    await page.waitForTimeout(1000);
    const resume = page.waitForTimeout(200).then(() => page.evaluate(() => document.querySelector('video')!.play()));
    const { rec: resumed, polls } = await recordPolling(page, 4.5);
    await resume;
    const back = (await debugStatus(page))!;
    {
      const inM = mid(resumed.input), outM = mid(resumed.output);
      const r = firstSound(inM);
      const input = locate(inM, stems.mix, 0.8);
      expect(input, 'input located').not.toBeNull();
      const L = polls.find((p) => p.s.mixer?.mode === 'realtime')?.s.mixer?.latency;
      expect(L, 'real-time output after the resume').toBeDefined();
      // From 40 ms on: DeepFilterNet starts from a reset state, so the first hop is quieter.
      const from = r + input!.offset + 1920;
      const coverage = speechCoverage(resumed, stems.speech, input!.offset, from, from + Math.round(3.5 * SAMPLE_RATE), sink, L!);
      console.log(`resumed at content ${(from / SAMPLE_RATE).toFixed(2)} s (sentence end ${sentenceEnd!.toFixed(2)} s):`,
        `output before the resume ${rms(outM, 0, r).toExponential(2)}; L ${L};`,
        'modes', [...new Set(polls.map((p) => `${p.s.mixer?.mode}${p.s.mixer?.locked ? '+lock' : ''}`))].join(' '),
        `coverage ${JSON.stringify({ ...coverage, missing: coverage.missing.map((t) => t.toFixed(2)) })};`, JSON.stringify(back.mixer));
      expect(rms(outM, 0, r)).toBeLessThan(1e-4);
      expect(back.mixer?.mode).toBe('lookahead');
      // Real-time output first, then look-ahead, with every word in between.
      expect(coverage.realtime).toBeGreaterThan(5);
      expect(coverage.lookahead).toBeGreaterThan(5);
      expect(coverage.missing).toEqual([]);
    }
  });

  test('2× playback falls back to real-time mode; back at 1× look-ahead returns', async ({ context, setSettings }) => {
    await setSettings({ reductionDb: 60, quality: 'auto', gapReduction: false });
    const page = await context.newPage();
    await page.goto(`${YT}/mse.html?media=long&ahead=40`);
    await startPlayback(page);
    await waitForStatus(page, (s) => s.mixer?.mode === 'lookahead' && s.mixer.locked, 'look-ahead lock', 90_000);
    await page.evaluate(() => { document.querySelector('video')!.playbackRate = 2; });
    const t0 = Date.now();
    const fast = await waitForStatus(
      page,
      (s) => s.mixer?.mode === 'realtime' && s.graph.playing === false && s.status.lookahead?.state === 'unavailable',
      'real-time at 2×',
      10_000,
      100,
    );
    console.log('2×: real-time after', Date.now() - t0, 'ms', JSON.stringify(fast.status));
    expect(fast.status.mode).toBe('realtime');
    expect(fast.status.lookahead?.reason).toMatch(/normal playback speed/);
    // 12 s at 2× (24 s of media).
    for (const end = Date.now() + 12_000; Date.now() < end; ) {
      const s = (await debugStatus(page))!;
      expect(s.mixer?.mode).toBe('realtime');
      expect(s.status.lookahead?.state).toBe('unavailable');
      await page.waitForTimeout(1000);
    }
    await page.evaluate(() => { document.querySelector('video')!.playbackRate = 1; });
    const t1 = Date.now();
    const back = await waitForStatus(page, (s) => s.mixer?.mode === 'lookahead' && s.mixer.locked, 'look-ahead at 1×', 20_000);
    console.log('1×: look-ahead again after', Date.now() - t1, 'ms at media time', (await mediaTime(page)).toFixed(1), 's', JSON.stringify(back.status.lookahead));
    expect(back.status.lookahead?.state).toBe('ready');
    await page.waitForTimeout(1600);
    expect(rms((await record(page, 2)).output[0]!)).toBeGreaterThan(0.005);
  });

  // The look-ahead worker drops its decoded audio after a minute switched off; switched on again,
  // it gets the audio the page had already appended once more (the hook replays it).
  test('look-ahead returns after more than a minute on the real-time setting', async ({ context, setSettings }) => {
    test.setTimeout(200_000);
    await setSettings({ reductionDb: 60, quality: 'auto', gapReduction: false });
    const page = await context.newPage();
    // Everything is appended long before the switch back.
    await page.goto(`${YT}/mse.html?media=long&ahead=45`);
    await startPlayback(page);
    await waitForStatus(page, (s) => s.mixer?.mode === 'lookahead' && s.mixer.locked, 'look-ahead lock', 90_000);
    await setSettings({ quality: 'realtime' });
    await waitForStatus(page, (s) => s.mixer?.mode === 'realtime' && s.status.lookahead?.state === 'off', 'real-time setting', 10_000);
    for (const end = Date.now() + 65_000; Date.now() < end; ) {
      expect((await debugStatus(page))!.mixer?.mode).toBe('realtime');
      await page.waitForTimeout(5000);
    }
    const buffered = await page.evaluate(() => { const b = document.querySelector('video')!.buffered; return b.end(b.length - 1); });
    const switchedAt = await mediaTime(page);
    await setSettings({ quality: 'auto' });
    const t0 = Date.now();
    const back = await waitForStatus(page, (s) => s.mixer?.mode === 'lookahead' && s.mixer.locked, 'look-ahead after the switch back', 20_000);
    console.log(`switched back at media time ${switchedAt.toFixed(1)} s (buffered to ${buffered.toFixed(1)} s):`,
      'look-ahead after', Date.now() - t0, 'ms', JSON.stringify(back.status.lookahead));
    expect(buffered).toBeGreaterThan(89);
    expect(back.status.lookahead?.state).toBe('ready');
    await page.waitForTimeout(1600);
    const q = speechQuality(await record(page, 3));
    console.log('look-ahead quality after the switch back', JSON.stringify(q));
    expect(q.improvement).toBeGreaterThan(12);
  });
});
