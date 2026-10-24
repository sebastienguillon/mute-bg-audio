// Media the end-to-end tests derive from the generated 30 s test clip (scripts/make-test-media.mjs),
// made once with ffmpeg into test/fixtures/generated/e2e/ (served under /media/e2e/). The
// generator deletes that directory when it replaces the clip, so everything here is made again on
// demand. Every file is written under a temporary name and renamed, so nobody reads a partial file.
//
//   long-audio.webm, long-video.webm  the mix looped to LONG_SECONDS (a session can process > 60 s)
//   gap-audio.mp4, gap-video.webm     the mix with digital-silence gaps inserted before words (GAPS),
//                                     in AAC (fragmented MP4): Chrome decodes AAC silence to exact
//                                     zeros, Opus silence to tiny non-zero values
//   gap-mix.wav, gap-speech.wav       the gapped mix (stereo) and speech stem (mono), float32
//   gap.json                          where the gaps are in the gapped clip
//   noaudio.webm                      the test video without its audio track
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const generated = fileURLToPath(new URL('../fixtures/generated/', import.meta.url));
const dir = join(generated, 'e2e');
const SR = 48000;

/** Seconds of the long clip: three times the 30 s test mix, so a session can process more than 60 s. */
export const LONG_SECONDS = 90;

/**
 * Digital-silence gaps inserted into the mix: each starts at the first word onset after `after`
 * seconds of the original clip and lasts `seconds`. Both are longer than the mixer's idle
 * threshold (0.5 s): it goes idle 0.4 s and 0.9 s before the next word.
 */
const GAPS = [
  { after: 12.5, seconds: 0.9 },
  { after: 22.3, seconds: 1.4 },
];

function ffmpeg(out, ...args) {
  const tmp = `${out}.tmp${out.slice(out.lastIndexOf('.'))}`;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, tmp]);
  renameSync(tmp, out);
}

function writeAtomically(out, data) {
  const tmp = `${out}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, out);
}

/** Channels of a float32 WAV file. */
function readWav(path) {
  const b = readFileSync(path);
  let p = 12, fmt = null, data = null;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data || fmt.tag !== 3 || fmt.bits !== 32) throw new Error(`${path}: expected a float32 WAV file`);
  const n = data.length / 4 / fmt.ch;
  const out = Array.from({ length: fmt.ch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.ch; c++) out[c][i] = data.readFloatLE((i * fmt.ch + c) * 4);
  return out;
}

function wavBytes(channels) {
  const n = channels[0].length, nc = channels.length;
  const buf = Buffer.alloc(44 + n * nc * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * nc * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);
  buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * nc * 4, 28);
  buf.writeUInt16LE(nc * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * nc * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++, o += 4) buf.writeFloatLE(channels[c][i], o);
  return buf;
}

const mono = (channels) => channels[0].map((v, i) => channels.reduce((s, ch) => s + ch[i], 0) / channels.length);

/**
 * Start (in samples) of the first word after `after` seconds in a speech signal: the first 10 ms
 * frame that follows a frame below −45 dBFS and starts five frames above −30 dBFS. The gap is put
 * one frame before it, so no speech is cut.
 */
function wordOnset(speech, after) {
  const W = SR / 100;
  const db = (k) => {
    let s = 0;
    for (let i = k * W; i < (k + 1) * W; i++) s += speech[i] ** 2;
    return 10 * Math.log10(s / W + 1e-20);
  };
  for (let k = Math.ceil(after * 100); (k + 6) * W <= speech.length; k++) {
    if (db(k - 1) >= -45) continue;
    let loud = true;
    for (let j = 1; j <= 5 && loud; j++) loud = db(k + j) > -30;
    if (loud) return (k - 1) * W;
  }
  throw new Error(`no word onset after ${after} s`);
}

/** Inserts `gaps` ({ at, frames }, at in input samples, ascending) of digital silence into a signal. */
function insertGaps(x, gaps) {
  const out = new Float32Array(x.length + gaps.reduce((s, g) => s + g.frames, 0));
  let from = 0, to = 0;
  for (const g of gaps) {
    out.set(x.subarray(from, g.at), to);
    to += g.at - from + g.frames;
    from = g.at;
  }
  out.set(x.subarray(from), to);
  return out;
}

function ensureLong() {
  const audio = join(dir, 'long-audio.webm'), video = join(dir, 'long-video.webm');
  if (!existsSync(audio)) {
    ffmpeg(audio, '-stream_loop', '2', '-i', join(generated, 'mix.wav'), '-t', String(LONG_SECONDS), '-c:a', 'libopus', '-b:a', '128k', '-f', 'webm');
  }
  if (!existsSync(video)) {
    ffmpeg(video, '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${LONG_SECONDS}`,
      '-c:v', 'libvpx-vp9', '-b:v', '150k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '60', '-f', 'webm');
  }
}

function ensureGap() {
  const audio = join(dir, 'gap-audio.mp4'), video = join(dir, 'gap-video.webm');
  const wav = join(dir, 'gap-mix.wav'), speechOut = join(dir, 'gap-speech.wav'), info = join(dir, 'gap.json');
  if ([audio, video, wav, speechOut, info].every((f) => existsSync(f))) return;
  const speech = mono(readWav(join(generated, 'speech.wav')));
  const mix = readWav(join(generated, 'mix.wav'));
  const gaps = GAPS.map((g) => ({ at: wordOnset(speech, g.after), frames: Math.round(g.seconds * SR) }));
  writeAtomically(wav, wavBytes(mix.map((ch) => insertGaps(ch, gaps))));
  ffmpeg(audio, '-i', wav, '-c:a', 'aac', '-b:a', '128k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '2000000', '-f', 'mp4');
  const gapped = insertGaps(speech, gaps);
  const seconds = gapped.length / SR;
  ffmpeg(video, '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${Math.ceil(seconds)}`,
    '-c:v', 'libvpx-vp9', '-b:v', '150k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '60', '-f', 'webm');
  writeAtomically(speechOut, wavBytes([gapped]));
  // Gap positions in the gapped clip: each is shifted by the gaps before it.
  let shift = 0;
  const placed = gaps.map((g) => {
    const start = g.at + shift;
    shift += g.frames;
    return { start: start / SR, end: (start + g.frames) / SR };
  });
  writeAtomically(info, JSON.stringify({ sampleRate: SR, duration: seconds, gaps: placed }, null, 2));
}

function ensureNoAudio() {
  const out = join(dir, 'noaudio.webm');
  if (!existsSync(out)) ffmpeg(out, '-i', join(generated, 'video.webm'), '-an', '-c:v', 'copy', '-f', 'webm');
}

/** Makes whatever e2e media is missing. */
export function ensureE2eMedia() {
  mkdirSync(dir, { recursive: true });
  ensureLong();
  ensureGap();
  ensureNoAudio();
}
