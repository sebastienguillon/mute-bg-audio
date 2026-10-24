#!/usr/bin/env node
// Generates copyright-free test media with known stems:
// synthetic speech (macOS `say`) over synthetic stereo music.
//
// Output (test/fixtures/generated/):
//   speech.wav, music.wav, mix.wav   48 kHz stereo float32 stems and their sum
//   mix.webm                         Opus in WebM (what YouTube serves to Chrome)
//   mix-aac.mp4                      AAC in fragmented MP4
//   video.webm                       VP9 + Opus test video for the MSE test page
//   video-only.webm, audio-only.webm its two streams, like YouTube's adaptive formats
//   timeline.json                    where the speech lines are
//
// Everything is written to a staging directory and moved into place at the end, so nobody reads a
// partial file. The media the tests derive from these clips and cache (DERIVED) is deleted then:
// it is made again from the new clips when needed. Needs macOS (`say`) and ffmpeg.
//
// Usage: node scripts/make-test-media.mjs [--duration 30] [--if-missing]
//   --if-missing   do nothing when all outputs exist (the unit tests' global setup uses this)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test/fixtures/generated');
const OUTPUTS = ['speech.wav', 'music.wav', 'mix.wav', 'mix.webm', 'mix-aac.mp4', 'video.webm', 'video-only.webm',
  'audio-only.webm', 'timeline.json'];
/** Subdirectories of outDir with media the tests make from the outputs (demux segments, decodes, long clips). */
const DERIVED = ['demux', 'dsp', 'e2e'];
const SR = 48000;
const argDur = process.argv.indexOf('--duration');
const DURATION = argDur > 0 ? Number(process.argv[argDur + 1]) : 30;

if (process.argv.includes('--if-missing') && OUTPUTS.every((f) => existsSync(join(outDir, f)))) process.exit(0);
requireTool('say', ['-v', '?'], 'the macOS speech synthesizer');
requireTool('ffmpeg', ['-version'], 'ffmpeg');

mkdirSync(outDir, { recursive: true });
const stage = mkdtempSync(join(outDir, '.staging-'));
process.on('exit', () => rmSync(stage, { recursive: true, force: true }));

/** Exits with a readable message when a command-line tool the script needs is not installed. */
function requireTool(command, args, what) {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.error(`Generating the test media needs ${what} (\`${command}\`), which is not installed. ` +
      'It runs on macOS only; elsewhere, copy test/fixtures/generated/ from a Mac.');
    process.exit(1);
  }
}

// ---------- WAV I/O ----------
function writeWavFloat(path, channels) {
  const n = channels[0].length;
  const nc = channels.length;
  const buf = Buffer.alloc(44 + n * nc * 4);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * nc * 4, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20); // IEEE float
  buf.writeUInt16LE(nc, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * nc * 4, 28);
  buf.writeUInt16LE(nc * 4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * nc * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { buf.writeFloatLE(channels[c][i], o); o += 4; }
  writeFileSync(path, buf);
}

function readWavMono16(path) {
  const b = readFileSync(path);
  let p = 12, data = null, fmt = null;
  while (p < b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || fmt.bits !== 16 || fmt.ch !== 1 || fmt.sr !== SR) throw new Error('unexpected wav format ' + JSON.stringify(fmt));
  const out = new Float32Array(data.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

// ---------- deterministic PRNG ----------
let seed = 0x9e3779b9;
const rand = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };

// ---------- speech ----------
const lines = [
  ['Daniel', 'Welcome back to the channel. Today we are going to look at how background music affects the way people understand speech in online videos.'],
  ['Samantha', 'Most creators add a music bed under their narration. It sets the mood, but for many viewers it makes the words much harder to follow.'],
  ['Daniel', 'The goal of this extension is simple. Keep the voice, and turn the music down, or remove it completely, while the video is playing.'],
  ['Thomas', 'Bonjour à tous. La musique de fond rend parfois la voix difficile à comprendre, surtout avec des écouteurs.'],
  ['Samantha', 'Let us check whether short pauses, quick words, and a change of speaker survive the processing without sounding underwater.'],
];

function synthSpeech() {
  const tmp = join(tmpdir(), `bgmr-say-${process.pid}`);
  mkdirSync(tmp, { recursive: true });
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const [voice, text] = lines[i];
    const aiff = join(tmp, `${i}.aiff`), wav = join(tmp, `${i}.wav`);
    let v = voice;
    try { execFileSync('say', ['-v', v, '-o', aiff, text]); }
    catch { v = 'Samantha'; execFileSync('say', ['-v', v, '-o', aiff, text]); }
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', aiff, '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    parts.push(readWavMono16(wav));
  }
  rmSync(tmp, { recursive: true, force: true });
  return parts;
}

// ---------- music ----------
const BPM = 96, beat = 60 / BPM;
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);
// I - V - vi - IV in C major
const chords = [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]];
const bassNotes = [36, 31, 33, 29];

function synthMusic(n) {
  const L = new Float32Array(n), R = new Float32Array(n);
  const add = (i, v, pan) => { // pan -1..1, constant power
    const a = (pan + 1) * Math.PI / 4;
    L[i] += v * Math.cos(a); R[i] += v * Math.sin(a);
  };
  const barLen = 4 * beat;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const bar = Math.floor(t / barLen) % 4;
    const tb = t % barLen;
    const ch = chords[bar];
    // pads: detuned saws, wide stereo, slow swell
    const env = Math.min(1, tb / 0.4) * (0.75 + 0.25 * Math.sin(2 * Math.PI * t / 6));
    for (let k = 0; k < ch.length; k++) {
      const f = midi(ch[k]);
      for (const [det, pan] of [[0.997, -0.85], [1.003, 0.85]]) {
        let s = 0;
        for (let h = 1; h <= 6; h++) s += Math.sin(2 * Math.PI * f * det * h * t) / h;
        add(i, 0.035 * env * s, pan);
      }
    }
    // plucked arpeggio, alternating sides
    const step = Math.floor(tb / (beat / 2));
    const tp = tb - step * (beat / 2);
    const note = ch[step % 3] + 12;
    const pl = Math.exp(-tp * 9) * Math.sin(2 * Math.PI * midi(note) * t) * (1 + 0.3 * Math.sin(4 * Math.PI * midi(note) * t));
    add(i, 0.06 * pl, step % 2 ? 0.6 : -0.6);
    // centered lead melody in the speech band (hard case for mid/side tricks)
    const leadStep = Math.floor(t / beat) % 8;
    const leadNote = [72, 74, 76, 79, 76, 74, 72, 67][leadStep] - 12 + (bar === 2 ? 2 : 0);
    const tl = t % beat;
    const leadEnv = Math.min(1, tl / 0.02) * Math.exp(-tl * 2.5);
    let lead = 0;
    for (let h = 1; h <= 7; h += 2) lead += Math.sin(2 * Math.PI * midi(leadNote) * h * t) / h;
    add(i, 0.05 * leadEnv * lead, 0);
    // bass, centered
    const bf = midi(bassNotes[bar]);
    const tbb = tb % beat;
    add(i, 0.12 * Math.exp(-tbb * 3) * (Math.sin(2 * Math.PI * bf * t) + 0.4 * Math.sin(4 * Math.PI * bf * t)), 0);
    // kick on beats 1 and 3, centered
    const tk = tb % (2 * beat);
    const kf = 50 + 120 * Math.exp(-tk * 30);
    add(i, 0.35 * Math.exp(-tk * 12) * Math.sin(2 * Math.PI * kf * tk), 0);
    // snare on 2 and 4, hats on eighths (noise)
    const ts = (tb + beat) % (2 * beat);
    const nz = rand() * 2 - 1;
    add(i, 0.12 * Math.exp(-ts * 18) * nz, 0.1);
    const th = tb % (beat / 2);
    add(i, 0.03 * Math.exp(-th * 60) * (rand() * 2 - 1), 0.5);
  }
  // simple one-pole high-pass on noise-heavy hats would be nicer; keep it raw.
  return [L, R];
}

// ---------- assemble ----------
const N = Math.round(DURATION * SR);
const parts = synthSpeech();
const speech = new Float32Array(N);
// timeline: 1.5 s music intro, then lines separated by gaps; one long music-only gap in the middle
let pos = Math.round(1.5 * SR);
const placements = [];
for (let i = 0; i < parts.length && pos < N; i++) {
  const p = parts[i];
  const len = Math.min(p.length, N - pos);
  for (let k = 0; k < len; k++) speech[pos + k] += p[k];
  placements.push({ line: i, start: pos / SR, end: (pos + len) / SR });
  pos += len + Math.round((i === 2 ? 3.0 : 0.6) * SR);
}
// normalize speech peak to -6 dBFS
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(speech[i]));
const sg = 0.5 / (peak || 1);
for (let i = 0; i < N; i++) speech[i] *= sg;

const [mL, mR] = synthMusic(N);
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
// music level: speech-to-music ratio of about +3 dB (loud bed, typical complaint)
const speechRms = rms(speech.filter((v, i) => i % 8 === 0 && Math.abs(v) > 1e-4));
const musicRms = (rms(mL) + rms(mR)) / 2;
const mg = (speechRms / Math.pow(10, 3 / 20)) / musicRms;
for (let i = 0; i < N; i++) { mL[i] *= mg; mR[i] *= mg; }

const mixL = new Float32Array(N), mixR = new Float32Array(N);
let mixPeak = 0;
for (let i = 0; i < N; i++) {
  mixL[i] = speech[i] + mL[i];
  mixR[i] = speech[i] + mR[i];
  mixPeak = Math.max(mixPeak, Math.abs(mixL[i]), Math.abs(mixR[i]));
}
if (mixPeak > 0.98) {
  const k = 0.98 / mixPeak;
  for (let i = 0; i < N; i++) { speech[i] *= k; mL[i] *= k; mR[i] *= k; mixL[i] *= k; mixR[i] *= k; }
}

writeWavFloat(join(stage, 'speech.wav'), [speech, speech]);
writeWavFloat(join(stage, 'music.wav'), [mL, mR]);
writeWavFloat(join(stage, 'mix.wav'), [mixL, mixR]);
writeFileSync(join(stage, 'timeline.json'), JSON.stringify({ sampleRate: SR, duration: DURATION, placements }, null, 2));

const ff = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args]);
const mixWav = join(stage, 'mix.wav');
ff('-i', mixWav, '-c:a', 'libopus', '-b:a', '128k', '-f', 'webm', join(stage, 'mix.webm'));
ff('-i', mixWav, '-c:a', 'aac', '-b:a', '128k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
  '-frag_duration', '2000000', join(stage, 'mix-aac.mp4'));
// A simple test video (moving gradient + timecode) with the same audio, VP9 + Opus.
ff('-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${DURATION}`, '-i', mixWav,
  '-c:v', 'libvpx-vp9', '-b:v', '400k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '60',
  '-c:a', 'libopus', '-b:a', '128k', '-shortest', '-f', 'webm', join(stage, 'video.webm'));
// Separate audio-only and video-only WebM streams, like YouTube's adaptive formats.
ff('-i', join(stage, 'video.webm'), '-map', '0:v', '-c', 'copy', '-f', 'webm', join(stage, 'video-only.webm'));
ff('-i', join(stage, 'video.webm'), '-map', '0:a', '-c', 'copy', '-f', 'webm', join(stage, 'audio-only.webm'));

for (const f of OUTPUTS) {
  if (!existsSync(join(stage, f))) throw new Error('missing ' + f);
}
for (const d of DERIVED) rmSync(join(outDir, d), { recursive: true, force: true });
for (const f of OUTPUTS) renameSync(join(stage, f), join(outDir, f));

console.log(`Wrote test media to ${outDir}`);
console.log(JSON.stringify({ duration: DURATION, lines: placements.length, musicGain: mg.toFixed(3) }));
