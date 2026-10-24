// Test helpers for the demuxers: fixtures, ffprobe ground truth, DASH segment generation,
// deterministic chunking and event collection.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AudioCodecConfig, Demuxer, DemuxEvent, EncodedAudioFrame } from '../../../src/lib/demux/types';
import { cached } from './fixtures';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIXTURES = join(ROOT, 'test/fixtures/generated');
/** Extra media made by the demux tests (gitignored with the rest of generated/). */
export const DEMUX_FIXTURES = join(FIXTURES, 'demux');

/** Path of a generated fixture (made by the global setup). */
export function fixture(name: string): string {
  return join(FIXTURES, name);
}

export function ffmpeg(...args: string[]): void {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
}

export interface ProbePacket {
  /** In stream time_base units. */
  pts: number;
  duration: number | null;
  size: number;
  pos: number;
  md5: string;
}

export interface ProbeResult {
  packets: ProbePacket[];
  timeBase: number;
  sampleRate: number;
  channels: number;
  codec: string;
  extradataMd5: string | null;
}

/** ffprobe ground truth for the audio stream (edit lists ignored: container timestamps). */
export function probe(path: string): ProbeResult {
  const out = execFileSync(
    'ffprobe',
    [
      '-v', 'error', '-ignore_editlist', '1', '-select_streams', 'a',
      '-show_entries', 'packet=pts,duration,size,pos,data_hash:stream=time_base,extradata_hash,codec_name,sample_rate,channels',
      '-show_data_hash', 'MD5', '-of', 'json', path,
    ],
    { maxBuffer: 256 * 1024 * 1024 },
  ).toString();
  const json = JSON.parse(out) as {
    packets: { pts: number; duration?: number; size: string; pos: string; data_hash: string }[];
    streams: { time_base: string; extradata_hash?: string; codec_name: string; sample_rate: string; channels: number }[];
  };
  const stream = json.streams[0]!;
  const [num, den] = stream.time_base.split('/').map(Number) as [number, number];
  return {
    packets: json.packets.map((p) => ({
      pts: p.pts,
      duration: p.duration ?? null,
      size: Number(p.size),
      pos: Number(p.pos),
      md5: p.data_hash.replace(/^MD5:/, ''),
    })),
    timeBase: num / den,
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    codec: stream.codec_name,
    extradataMd5: stream.extradata_hash?.replace(/^MD5:/, '') ?? null,
  };
}

export function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

export interface DashSet {
  init: Uint8Array;
  segments: Uint8Array[];
  /** init + all segments, for ffprobe ground truth. */
  concatenated: string;
}

/**
 * DASH segments of mix.wav made by ffmpeg, cached under DEMUX_FIXTURES/<name>.
 * `type` is the DASH segment container, `codecArgs` the ffmpeg audio encoder arguments.
 */
export function makeDash(name: string, type: 'webm' | 'mp4', codecArgs: string[]): DashSet {
  const ext = type === 'webm' ? 'webm' : 'm4s';
  const initName = `init.${type === 'webm' ? 'webm' : 'mp4'}`;
  const allName = `all.${type === 'webm' ? 'webm' : 'mp4'}`;
  const read = (dir: string) => ({
    init: new Uint8Array(readFileSync(join(dir, initName))),
    segments: readdirSync(dir)
      .filter((f) => f.startsWith('seg-'))
      .sort()
      .map((f) => new Uint8Array(readFileSync(join(dir, f)))),
  });
  const dir = cached(join(DEMUX_FIXTURES, name), (tmp) => {
    mkdirSync(tmp);
    ffmpeg(
      '-i', fixture('mix.wav'), ...codecArgs, '-f', 'dash', '-seg_duration', '2', '-dash_segment_type', type,
      '-init_seg_name', initName, '-media_seg_name', `seg-$Number%03d$.${ext}`, join(tmp, 'out.mpd'),
    );
    const { init, segments } = read(tmp);
    writeFileSync(join(tmp, allName), concat(init, ...segments));
  });
  return { ...read(dir), concatenated: join(dir, allName) };
}

/** Deterministic PRNG (mulberry32) returning floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits `bytes` into chunks of random sizes in [min, max]; each chunk is a fresh copy. */
export function randomChunks(bytes: Uint8Array, seed: number, min: number, max: number): Uint8Array[] {
  const next = rng(seed);
  const chunks: Uint8Array[] = [];
  for (let p = 0; p < bytes.length; ) {
    const n = min + Math.floor(next() * (max - min + 1));
    chunks.push(bytes.slice(p, p + n));
    p += n;
  }
  return chunks;
}

export interface Collected {
  configs: AudioCodecConfig[];
  frames: EncodedAudioFrame[];
  errors: string[];
  /** Event types in order ('frames' events are merged when consecutive). */
  order: DemuxEvent['type'][];
}

export function newCollected(): Collected {
  return { configs: [], frames: [], errors: [], order: [] };
}

/** Pushes every chunk (overwriting each chunk after the push, to catch retained references). */
export function feed(demuxer: Demuxer, chunks: Uint8Array[], into: Collected = newCollected()): Collected {
  for (const chunk of chunks) {
    for (const event of demuxer.push(chunk)) {
      if (into.order[into.order.length - 1] !== event.type || event.type !== 'frames') into.order.push(event.type);
      if (event.type === 'config') into.configs.push(event.config);
      else if (event.type === 'frames') into.frames.push(...event.frames);
      else into.errors.push(event.message);
    }
    chunk.fill(0xa5);
  }
  return into;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
