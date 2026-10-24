import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createDemuxer } from '../../src/lib/demux';
import { DEMUX_FIXTURES, ffmpeg, fixture, randomChunks } from './helpers/demux-media';
import { cached } from './helpers/fixtures';

/** 10 minutes of media: the 30 s fixture looped 20 times (stream copy, no re-encoding). */
function tenMinutes(source: string, name: string, extra: string[]): Uint8Array {
  const path = cached(join(DEMUX_FIXTURES, name), (tmp) => {
    ffmpeg('-stream_loop', '19', '-i', fixture(source), '-c', 'copy', ...extra, tmp);
  });
  return new Uint8Array(readFileSync(path));
}

/** Median wall time (ms) of `run` over `runs` repetitions after one warm-up. */
function median(runs: number, run: () => void): number {
  run();
  const times: number[] = [];
  for (let k = 0; k < runs; k++) {
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[times.length >> 1]!;
}

function demuxAll(mime: string, chunks: Uint8Array[]): number {
  const demuxer = createDemuxer(mime)!;
  let frames = 0;
  for (const chunk of chunks) {
    for (const event of demuxer.push(chunk)) if (event.type === 'frames') frames += event.frames.length;
  }
  return frames;
}

describe('demuxer performance (10 minutes of audio)', () => {
  let opus: Uint8Array;
  let aac: Uint8Array;
  beforeAll(() => {
    opus = tenMinutes('mix.webm', 'ten-minutes.webm', ['-f', 'webm']);
    aac = tenMinutes('mix-aac.mp4', 'ten-minutes.mp4', ['-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '2000000']);
  });

  it('demuxes 10 minutes of Opus/WebM in under 50 ms', () => {
    const mime = 'audio/webm; codecs="opus"';
    expect(demuxAll(mime, [opus])).toBe(20 * 1501); // 20 loops of 1501 20-ms packets
    const oneShot = median(9, () => demuxAll(mime, [opus]));
    const chunks = randomChunks(opus, 1, 16 * 1024, 128 * 1024);
    const chunked = median(9, () => demuxAll(mime, chunks));
    console.info(`Opus/WebM 10 min (${(opus.length / 1e6).toFixed(1)} MB): one push ${oneShot.toFixed(1)} ms, 16-128 KiB pushes ${chunked.toFixed(1)} ms`);
    expect(oneShot).toBeLessThan(50);
    expect(chunked).toBeLessThan(50);
  });

  it('demuxes 10 minutes of AAC/fMP4 quickly', () => {
    const mime = 'audio/mp4; codecs="mp4a.40.2"';
    expect(demuxAll(mime, [aac])).toBeGreaterThan(28_000);
    const oneShot = median(9, () => demuxAll(mime, [aac]));
    const chunks = randomChunks(aac, 1, 16 * 1024, 128 * 1024);
    const chunked = median(9, () => demuxAll(mime, chunks));
    console.info(`AAC/fMP4 10 min (${(aac.length / 1e6).toFixed(1)} MB): one push ${oneShot.toFixed(1)} ms, 16-128 KiB pushes ${chunked.toFixed(1)} ms`);
    expect(oneShot).toBeLessThan(50);
  });
});
