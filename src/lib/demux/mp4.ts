// Incremental fragmented-MP4 (ISO BMFF) audio demuxer for MSE byte streams, modelled on Chrome's
// MP4StreamParser. Sample data is located by absolute stream position (from the trun data
// offsets), so samples are emitted as soon as their bytes arrive; skipped boxes are never buffered.
import { OPUS_SAMPLE_RATE, buildOpusHead, type OpusHeadFields } from './opus';
import { ByteQueue, type AudioCodecConfig, type Demuxer, type DemuxEvent, type EncodedAudioFrame } from './types';

// Box types as big-endian 32-bit integers.
const BOX_FTYP = 0x66747970;
const BOX_MOOV = 0x6d6f6f76;
const BOX_MOOF = 0x6d6f6f66;
const BOX_MDAT = 0x6d646174;
const BOX_TRAK = 0x7472616b;
const BOX_TKHD = 0x746b6864;
const BOX_MDIA = 0x6d646961;
const BOX_MDHD = 0x6d646864;
const BOX_HDLR = 0x68646c72;
const BOX_MINF = 0x6d696e66;
const BOX_STBL = 0x7374626c;
const BOX_STSD = 0x73747364;
const BOX_MP4A = 0x6d703461;
const BOX_OPUS = 0x4f707573;
const BOX_ENCA = 0x656e6361;
const BOX_ESDS = 0x65736473;
const BOX_WAVE = 0x77617665;
const BOX_DOPS = 0x644f7073;
const BOX_MVEX = 0x6d766578;
const BOX_TREX = 0x74726578;
const BOX_TRAF = 0x74726166;
const BOX_TFHD = 0x74666864;
const BOX_TFDT = 0x74666474;
const BOX_TRUN = 0x7472756e;
const HANDLER_SOUN = 0x736f756e;

// tfhd flags
const TFHD_BASE_DATA_OFFSET = 0x1;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2;
const TFHD_DEFAULT_DURATION = 0x8;
const TFHD_DEFAULT_SIZE = 0x10;
const TFHD_DEFAULT_FLAGS = 0x20;
const TFHD_DURATION_IS_EMPTY = 0x10000;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x20000;
/** Optional 32-bit tfhd fields, in stream order. */
const TFHD_UINT32_FIELDS = [TFHD_SAMPLE_DESCRIPTION_INDEX, TFHD_DEFAULT_DURATION, TFHD_DEFAULT_SIZE, TFHD_DEFAULT_FLAGS];
// trun flags
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
const TRUN_DURATION = 0x100;
const TRUN_SIZE = 0x200;
const TRUN_FLAGS = 0x400;
const TRUN_COMPOSITION_OFFSET = 0x800;

/** Largest moov/moof that is buffered whole; larger ones are treated as corrupt. */
const MAX_BUFFERED_BOX = 16 * 1024 * 1024;
/** Upper bound on the samples described by one moof (guards against corrupt sample counts). */
const MAX_SAMPLES_PER_MOOF = 1 << 20;

const u16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const u24 = (b: Uint8Array, i: number): number => (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
const u32 = (b: Uint8Array, i: number): number => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const i32 = (b: Uint8Array, i: number): number => (b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!;
const u64 = (b: Uint8Array, i: number): number => u32(b, i) * 2 ** 32 + u32(b, i + 4);

interface BoxRange {
  /** Payload start (after the box header). */
  start: number;
  end: number;
}

/** Calls `visit` for each box in `b[s, e)`; false when malformed or when `visit` returns false. */
function forEachBox(b: Uint8Array, s: number, e: number, visit: (type: number, start: number, end: number) => boolean | void): boolean {
  for (let p = s; p < e; ) {
    if (p + 8 > e) return false;
    let size = u32(b, p);
    let header = 8;
    if (size === 1) {
      if (p + 16 > e) return false;
      size = u64(b, p + 8);
      header = 16;
    } else if (size === 0) {
      size = e - p;
    }
    if (size < header || p + size > e) return false;
    if (visit(u32(b, p + 4), p + header, p + size) === false) return false;
    p += size;
  }
  return true;
}

/** Boxes of `b[s, e)` in order (stops at the first malformed one). */
function listBoxes(b: Uint8Array, s: number, e: number): (BoxRange & { type: number })[] {
  const boxes: (BoxRange & { type: number })[] = [];
  forEachBox(b, s, e, (type, start, end) => {
    boxes.push({ type, start, end });
  });
  return boxes;
}

/** First box of `type` in `b[s, e)`, or null. */
function findBox(b: Uint8Array, s: number, e: number, type: number): BoxRange | null {
  return listBoxes(b, s, e).find((box) => box.type === type) ?? null;
}

function findPath(b: Uint8Array, range: BoxRange | null, ...path: number[]): BoxRange | null {
  let r = range;
  for (const type of path) r = r && findBox(b, r.start, r.end, type);
  return r;
}

function isPrintableFourcc(type: number): boolean {
  for (let shift = 0; shift < 32; shift += 8) {
    const c = (type >>> shift) & 0xff;
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

function fourccString(type: number): string {
  return String.fromCharCode(type >>> 24, (type >>> 16) & 0xff, (type >>> 8) & 0xff, type & 0xff);
}

// ───────────── AudioSpecificConfig (ISO/IEC 14496-3 §1.6.2.1) ─────────────

const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** Channels for channelConfiguration 0..14 (0: defined by a program_config_element). */
const AAC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8, 0, 0, 0, 7, 8, 24, 8];
/** Object types that use GASpecificConfig. */
const GA_OBJECT_TYPES = new Set([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23]);

class BitReader {
  private bit = 0;
  /** Set when a read went past the end (missing bits read as 0). */
  overrun = false;

  constructor(private readonly b: Uint8Array) {}

  get remaining(): number {
    return this.b.length * 8 - this.bit;
  }

  /** Reads `n` (at most 32) bits, most significant first. */
  read(n: number): number {
    let v = 0;
    for (let k = 0; k < n; k++, this.bit++) {
      const byte = this.b[this.bit >> 3];
      if (byte === undefined) this.overrun = true;
      v = v * 2 + (((byte ?? 0) >> (7 - (this.bit & 7))) & 1);
    }
    return v;
  }

  skip(n: number): void {
    this.bit += n;
    if (this.bit > this.b.length * 8) this.overrun = true;
  }

  byteAlign(): void {
    this.skip((8 - (this.bit & 7)) & 7);
  }
}

/** Decoder parameters derived from an AudioSpecificConfig. */
export interface AacInfo {
  /** 'mp4a.40.<aot>': 5 when SBR is signalled, 29 with parametric stereo, else the core object type. */
  codec: string;
  /** Output sample rate (the SBR rate when SBR is signalled). */
  sampleRate: number;
  /** Output channels (0 when not determinable from the config). */
  channels: number;
}

/**
 * Parses an AudioSpecificConfig: object type (with escape), sampling frequency (with explicit
 * index 15), channel configuration (with program_config_element), and both explicit hierarchical
 * and backward-compatible (sync extension 0x2b7 / 0x548) SBR and PS signalling. Implicit SBR cannot
 * be detected from the config; the decoder handles it. Returns null when the config is invalid.
 */
export function parseAudioSpecificConfig(asc: Uint8Array): AacInfo | null {
  const r = new BitReader(asc);
  const readObjectType = (): number => {
    const aot = r.read(5);
    return aot === 31 ? 32 + r.read(6) : aot;
  };
  const readSampleRate = (): number => {
    const index = r.read(4);
    return index === 15 ? r.read(24) : (AAC_SAMPLE_RATES[index] ?? 0);
  };

  let objectType = readObjectType();
  const coreRate = readSampleRate();
  const channelConfig = r.read(4);
  if (r.overrun || objectType === 0 || coreRate === 0) return null;

  let codecObjectType = objectType;
  let sbr = false;
  let ps = false;
  let sbrRate = 0;
  // Explicit hierarchical signalling: the SBR/PS object type comes first, then the core type.
  const explicitHierarchical = objectType === 5 || objectType === 29;
  if (explicitHierarchical) {
    sbr = true;
    ps = objectType === 29;
    sbrRate = readSampleRate();
    objectType = readObjectType();
    if (objectType === 22) r.read(4); // extensionChannelConfiguration
    if (r.overrun) return null;
  }

  let channels = AAC_CHANNELS[channelConfig] ?? 0;
  if (GA_OBJECT_TYPES.has(objectType)) {
    const pceChannels = skipGaSpecificConfig(r, objectType, channelConfig);
    if (channelConfig === 0) channels = r.overrun ? 0 : pceChannels;
    // Backward-compatible signalling: a sync extension after the core config.
    if (!explicitHierarchical && !r.overrun && r.remaining >= 16 && r.read(11) === 0x2b7) {
      if (readObjectType() === 5 && r.read(1) === 1) {
        const rate = readSampleRate();
        let psPresent = false;
        if (r.remaining >= 12 && r.read(11) === 0x548) psPresent = r.read(1) === 1;
        if (!r.overrun) {
          sbr = true;
          ps = psPresent;
          sbrRate = rate;
          codecObjectType = ps ? 29 : 5;
        }
      }
    }
  }
  if (ps && channels === 1) channels = 2;
  return {
    codec: `mp4a.40.${codecObjectType}`,
    sampleRate: sbr ? sbrRate || 2 * coreRate : coreRate,
    channels,
  };
}

/** Skips GASpecificConfig; returns the channel count of its program_config_element (0 if none). */
function skipGaSpecificConfig(r: BitReader, objectType: number, channelConfig: number): number {
  r.read(1); // frameLengthFlag
  if (r.read(1)) r.read(14); // dependsOnCoreCoder → coreCoderDelay
  const extensionFlag = r.read(1);
  const channels = channelConfig === 0 ? readProgramConfigElementChannels(r) : 0;
  if (objectType === 6 || objectType === 20) r.read(3); // layerNr
  if (extensionFlag) {
    if (objectType === 22) r.skip(16); // numOfSubFrame, layer_length
    if (objectType === 17 || objectType === 19 || objectType === 20 || objectType === 23) r.read(3);
    r.read(1); // extensionFlag3
  }
  return channels;
}

/** Reads a program_config_element (ISO/IEC 14496-3 §4.4.1.1) and returns its channel count. */
function readProgramConfigElementChannels(r: BitReader): number {
  r.read(10); // element_instance_tag, object_type, sampling_frequency_index
  const front = r.read(4);
  const side = r.read(4);
  const back = r.read(4);
  const lfe = r.read(2);
  const assoc = r.read(3);
  const cc = r.read(4);
  if (r.read(1)) r.read(4); // mono_mixdown
  if (r.read(1)) r.read(4); // stereo_mixdown
  if (r.read(1)) r.read(3); // matrix_mixdown_idx, pseudo_surround_enable
  let channels = lfe;
  for (let k = 0; k < front + side + back; k++) channels += r.read(5) & 0x10 ? 2 : 1; // is_cpe + tag
  r.skip(4 * lfe + 4 * assoc + 5 * cc);
  r.byteAlign();
  r.skip(8 * r.read(8)); // comment field
  return channels;
}

// ───────────── Sample entries ─────────────

/** Reads an MPEG-4 descriptor header at `p`; returns [tag, payloadStart, payloadEnd] or null. */
function readDescriptor(b: Uint8Array, p: number, e: number): [number, number, number] | null {
  if (p >= e) return null;
  const tag = b[p++]!;
  let size = 0;
  for (let k = 0; k < 4; k++) {
    if (p >= e) return null;
    const v = b[p++]!;
    size = size * 128 + (v & 0x7f);
    if (!(v & 0x80)) break;
  }
  return p + size <= e ? [tag, p, p + size] : null;
}

/** Parses an esds payload into objectTypeIndication and DecoderSpecificInfo. */
function parseEsds(b: Uint8Array, s: number, e: number): { objectType: number; specificInfo?: Uint8Array } | null {
  let d = readDescriptor(b, s + 4, e); // after version/flags
  if (d && d[0] === 3) {
    let p = d[1];
    const end = d[2];
    if (p + 3 > end) return null;
    const flags = b[p + 2]!;
    p += 3;
    if (flags & 0x80) p += 2; // dependsOn_ES_ID
    if (flags & 0x40) p += 1 + (b[p] ?? 0); // URL
    if (flags & 0x20) p += 2; // OCR_ES_Id
    d = readDescriptor(b, p, end);
  }
  if (!d || d[0] !== 4 || d[2] - d[1] < 13) return null;
  const objectType = b[d[1]]!;
  const info = readDescriptor(b, d[1] + 13, d[2]);
  return info && info[0] === 5 ? { objectType, specificInfo: b.slice(info[1], info[2]) } : { objectType };
}

/** Builds the codec config for the first sample entry of an stsd payload, or returns an error message. */
function parseSampleDescription(b: Uint8Array, stsd: BoxRange): AudioCodecConfig | string {
  const e = listBoxes(b, stsd.start + 8, stsd.end)[0];
  if (!e) return 'empty sample description';
  if (e.type === BOX_ENCA) return 'encrypted audio is not supported';
  if (e.type !== BOX_MP4A && e.type !== BOX_OPUS) return `unsupported sample entry '${fourccString(e.type)}'`;
  if (e.end - e.start < 28) return 'truncated audio sample entry';
  const version = u16(b, e.start + 8);
  const entryChannels = u16(b, e.start + 16);
  const entryRate = u32(b, e.start + 24) >>> 16;
  const children: BoxRange = { start: e.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0), end: e.end };
  if (children.start > children.end) return 'truncated audio sample entry';

  if (e.type === BOX_OPUS) {
    const dops = findBox(b, children.start, children.end, BOX_DOPS);
    if (!dops || dops.end - dops.start < 11 || b[dops.start] !== 0) return 'missing or invalid dOps box';
    const p = dops.start;
    const channels = b[p + 1]!;
    const mappingFamily = b[p + 10]!;
    if (channels === 0 || (mappingFamily !== 0 && dops.end - p < 13 + channels)) return 'invalid dOps box';
    // dOps holds the OpusHead fields big-endian, without the magic and with version 0.
    const fields: OpusHeadFields = {
      channels,
      preSkip: u16(b, p + 2),
      inputSampleRate: u32(b, p + 4),
      outputGain: (u16(b, p + 8) << 16) >> 16,
      mappingFamily,
    };
    if (mappingFamily !== 0) {
      fields.streamCount = b[p + 11]!;
      fields.coupledCount = b[p + 12]!;
      fields.channelMapping = b.subarray(p + 13, p + 13 + channels);
    }
    return { codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, channels, description: buildOpusHead(fields), codecDelaySamples: fields.preSkip };
  }

  const esdsBox = findBox(b, children.start, children.end, BOX_ESDS) ?? findPath(b, children, BOX_WAVE, BOX_ESDS);
  const esds = esdsBox && parseEsds(b, esdsBox.start, esdsBox.end);
  if (!esds) return 'missing or invalid esds box';
  if (esds.objectType === 0x69 || esds.objectType === 0x6b) {
    return { codec: 'mp3', sampleRate: entryRate, channels: entryChannels };
  }
  // 0x40: MPEG-4 audio; 0x66..0x68: MPEG-2 AAC Main/LC/SSR (same AudioSpecificConfig).
  if (esds.objectType !== 0x40 && (esds.objectType < 0x66 || esds.objectType > 0x68)) {
    return `unsupported objectTypeIndication 0x${esds.objectType.toString(16)}`;
  }
  const info = esds.specificInfo && parseAudioSpecificConfig(esds.specificInfo);
  if (!esds.specificInfo || !info) return 'missing or invalid AudioSpecificConfig';
  return {
    codec: info.codec,
    sampleRate: info.sampleRate,
    channels: info.channels || entryChannels,
    description: esds.specificInfo,
  };
}

// ───────────── Demuxer ─────────────

interface AudioTrack {
  id: number;
  timescale: number;
}

interface TrackDefaults {
  duration: number;
  size: number;
}

/** Parses a trak; returns the audio track and its config, null for non-audio tracks, or an error. */
function parseTrak(b: Uint8Array, s: number, e: number): { track: AudioTrack; config: AudioCodecConfig } | string | null {
  const trak: BoxRange = { start: s, end: e };
  const mdia = findBox(b, s, e, BOX_MDIA);
  const hdlr = findPath(b, mdia, BOX_HDLR);
  if (!hdlr || hdlr.end - hdlr.start < 12 || u32(b, hdlr.start + 8) !== HANDLER_SOUN) return null;
  const tkhd = findPath(b, trak, BOX_TKHD);
  const mdhd = findPath(b, mdia, BOX_MDHD);
  const stsd = findPath(b, mdia, BOX_MINF, BOX_STBL, BOX_STSD);
  if (!tkhd || !mdhd || !stsd) return 'incomplete audio trak';
  const tkhdV1 = b[tkhd.start] === 1;
  const mdhdV1 = b[mdhd.start] === 1;
  if (tkhd.end - tkhd.start < (tkhdV1 ? 24 : 16) || mdhd.end - mdhd.start < (mdhdV1 ? 24 : 16)) return 'truncated tkhd/mdhd';
  const id = u32(b, tkhd.start + (tkhdV1 ? 20 : 12));
  const timescale = u32(b, mdhd.start + (mdhdV1 ? 20 : 12));
  if (timescale === 0) return 'invalid mdhd timescale';
  const config = parseSampleDescription(b, stsd);
  return typeof config === 'string' ? config : { track: { id, timescale }, config };
}

class Mp4Demuxer implements Demuxer {
  private readonly queue = new ByteQueue();
  private events: DemuxEvent[] = [];
  private frames: EncodedAudioFrame[] = [];
  /** Absolute stream position of the next box header. */
  private pos = 0;
  /** Box parsing can only progress once the queue end reaches this position. */
  private need = 0;
  private resyncing = false;
  private track: AudioTrack | null = null;
  private trex = new Map<number, TrackDefaults>();
  /** Decode time (track timescale) following the last parsed sample; used when tfdt is absent. */
  private nextDecodeTime = 0;
  // Samples of the current moof, in decode order: absolute byte offset, size, pts and duration (s).
  private sampleOffset: number[] = [];
  private sampleSize: number[] = [];
  private samplePts: number[] = [];
  private sampleDuration: number[] = [];
  /** retainFrom[i] = min(sampleOffset[i..]): bytes before it are no longer needed. */
  private retainFrom: number[] = [];
  private nextSample = 0;
  /** Payload of the last mdat after the current moof: samples are only read from there. */
  private mdatStart = 0;
  private mdatEnd = 0;
  /** At most one sample-level error is reported per moof. */
  private moofErrorReported = false;

  push(bytes: Uint8Array): DemuxEvent[] {
    this.queue.push(bytes);
    try {
      this.drainSamples();
      if (this.queue.end >= this.need) this.parse();
    } catch (e) {
      this.fail(`internal parser error: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.queue.discard(Math.min(this.pos, this.retainFrom[this.nextSample] ?? Infinity));
    this.queue.release();
    this.flushFrames();
    const events = this.events;
    this.events = [];
    return events;
  }

  reset(): void {
    this.pos = this.queue.end;
    this.queue.clear();
    this.need = 0;
    this.resyncing = false;
    this.clearSamples();
  }

  private parse(): void {
    const q = this.queue;
    for (;;) {
      this.drainSamples();
      if (this.resyncing && !this.scanForSync()) return;
      const avail = q.end - this.pos;
      if (avail < 8) {
        this.need = this.pos + 8;
        return;
      }
      const b = q.bytes;
      const i = q.index(this.pos);
      const type = u32(b, i + 4);
      let size = u32(b, i);
      let header = 8;
      if (size === 1) {
        if (avail < 16) {
          this.need = this.pos + 16;
          return;
        }
        size = u64(b, i + 8);
        header = 16;
      } else if (size === 0) {
        size = type === BOX_MDAT ? Infinity : 0; // an mdat "to the end of the file"
      }
      if (size < header) {
        this.fail('invalid box size');
        continue;
      }
      if (type === BOX_MOOV || type === BOX_MOOF) {
        if (size > MAX_BUFFERED_BOX) {
          this.fail('moov/moof too large');
          continue;
        }
        if (type === BOX_MOOF && !this.track) {
          this.emit({ type: 'error', message: 'MP4: moof before a usable moov' });
          this.pos += size;
          continue;
        }
        if (avail < size) {
          this.need = this.pos + size;
          return;
        }
        if (this.nextSample < this.sampleOffset.length) this.emit({ type: 'error', message: 'MP4: missing sample data' });
        this.clearSamples();
        if (type === BOX_MOOV) this.parseMoov(b, i + header, i + size);
        else this.parseMoof(b, i + header, i + size, this.pos, this.pos + size);
      } else if (type === BOX_MDAT) {
        // The payload is not buffered here: drainSamples() reads the samples it contains.
        this.mdatStart = this.pos + header;
        this.mdatEnd = this.pos + size;
      } else if (!isPrintableFourcc(type)) {
        this.fail('invalid box type');
        continue;
      }
      this.pos += size;
    }
  }

  private parseMoov(b: Uint8Array, s: number, e: number): void {
    const trex = new Map<number, TrackDefaults>();
    const found: { track: AudioTrack; config: AudioCodecConfig }[] = [];
    let reason = 'no audio track';
    const ok = forEachBox(b, s, e, (type, cs, ce) => {
      if (type === BOX_TRAK && found.length === 0) {
        const result = parseTrak(b, cs, ce);
        if (typeof result === 'string') reason = result;
        else if (result) found.push(result);
      } else if (type === BOX_MVEX) {
        return forEachBox(b, cs, ce, (t, xs, xe) => {
          if (t !== BOX_TREX) return true;
          if (xe - xs < 24) return false;
          trex.set(u32(b, xs + 4), { duration: u32(b, xs + 12), size: u32(b, xs + 16) });
          return true;
        });
      }
      return true;
    });
    const result = found[0];
    this.trex = trex;
    this.track = ok && result ? result.track : null;
    if (ok && result) this.emit({ type: 'config', config: result.config });
    else this.emit({ type: 'error', message: `MP4: ${ok ? reason : 'invalid moov'}` });
  }

  /** Collects the samples of our track from a moof payload `b[s, e)`; `moofPos`/`moofEnd` are absolute. */
  private parseMoof(b: Uint8Array, s: number, e: number, moofPos: number, moofEnd: number): void {
    this.moofErrorReported = false;
    this.mdatStart = this.mdatEnd = moofEnd;
    let dataEnd = moofPos;
    const ok = forEachBox(b, s, e, (type, cs, ce) => {
      if (type !== BOX_TRAF) return true;
      dataEnd = this.parseTraf(b, cs, ce, moofPos, dataEnd);
      return dataEnd >= 0;
    });
    if (!ok) {
      this.clearSamples();
      this.emit({ type: 'error', message: 'MP4: invalid moof' });
      return;
    }
    const offsets = this.sampleOffset;
    const retain = this.retainFrom;
    let min = Infinity;
    for (let k = offsets.length - 1; k >= 0; k--) {
      min = Math.min(min, offsets[k]!);
      retain[k] = min;
    }
    retain.length = offsets.length;
  }

  /** Parses one traf; returns the end of its sample data (absolute) or -1 when malformed. */
  private parseTraf(b: Uint8Array, s: number, e: number, moofPos: number, previousDataEnd: number): number {
    const tfhd = findBox(b, s, e, BOX_TFHD);
    if (!tfhd || tfhd.end - tfhd.start < 8) return -1;
    const flags = u24(b, tfhd.start + 1);
    const trackId = u32(b, tfhd.start + 4);
    const defaults = this.trex.get(trackId);
    let p = tfhd.start + 8;
    let base = flags & TFHD_DEFAULT_BASE_IS_MOOF ? moofPos : previousDataEnd;
    let fieldsEnd = p + (flags & TFHD_BASE_DATA_OFFSET ? 8 : 0);
    for (const field of TFHD_UINT32_FIELDS) if (flags & field) fieldsEnd += 4;
    if (fieldsEnd > tfhd.end) return -1;
    if (flags & TFHD_BASE_DATA_OFFSET) {
      base = u64(b, p); // interpreted as an absolute position in this byte stream
      p += 8;
    }
    if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) p += 4;
    let defaultDuration = defaults?.duration ?? 0;
    let defaultSize = defaults?.size ?? 0;
    if (flags & TFHD_DEFAULT_DURATION) {
      defaultDuration = u32(b, p);
      p += 4;
    }
    if (flags & TFHD_DEFAULT_SIZE) defaultSize = u32(b, p);
    if (flags & TFHD_DURATION_IS_EMPTY) return base;

    const track = this.track;
    const ours = track !== null && trackId === track.id;
    const tfdt = ours ? findBox(b, s, e, BOX_TFDT) : null;
    if (tfdt && tfdt.end - tfdt.start < (b[tfdt.start] === 1 ? 12 : 8)) return -1;
    let dts = tfdt ? (b[tfdt.start] === 1 ? u64(b, tfdt.start + 4) : u32(b, tfdt.start + 4)) : this.nextDecodeTime;
    const timescale = track?.timescale ?? 1;
    let dataPos = base;
    const ok = forEachBox(b, s, e, (type, cs, ce) => {
      if (type !== BOX_TRUN) return true;
      if (ce - cs < 8) return false;
      const runFlags = u24(b, cs + 1);
      const count = u32(b, cs + 4);
      let q = cs + 8;
      if (runFlags & TRUN_DATA_OFFSET) {
        if (q + 4 > ce) return false;
        dataPos = base + i32(b, q);
        q += 4;
      }
      if (runFlags & TRUN_FIRST_SAMPLE_FLAGS) q += 4;
      const hasDuration = (runFlags & TRUN_DURATION) !== 0;
      const hasSize = (runFlags & TRUN_SIZE) !== 0;
      const hasFlags = (runFlags & TRUN_FLAGS) !== 0;
      const hasOffset = (runFlags & TRUN_COMPOSITION_OFFSET) !== 0;
      const stride = 4 * (+hasDuration + +hasSize + +hasFlags + +hasOffset);
      if (q + count * stride > ce || this.sampleOffset.length + count > MAX_SAMPLES_PER_MOOF) return false;
      for (let k = 0; k < count; k++) {
        let duration = defaultDuration;
        let size = defaultSize;
        let compositionOffset = 0;
        if (hasDuration) {
          duration = u32(b, q);
          q += 4;
        }
        if (hasSize) {
          size = u32(b, q);
          q += 4;
        }
        if (hasFlags) q += 4;
        if (hasOffset) {
          // Signed in both versions: version 0 offsets above 2^31 only occur in buggy files.
          compositionOffset = i32(b, q);
          q += 4;
        }
        if (ours) {
          this.sampleOffset.push(dataPos);
          this.sampleSize.push(size);
          this.samplePts.push((dts + compositionOffset) / timescale);
          this.sampleDuration.push(duration / timescale);
        }
        dataPos += size;
        dts += duration;
      }
      return true;
    });
    if (!ok) return -1;
    if (ours) this.nextDecodeTime = dts;
    return dataPos;
  }

  /** Emits, in decode order, every pending sample whose bytes are buffered in the current mdat. */
  private drainSamples(): void {
    const q = this.queue;
    const count = this.sampleOffset.length;
    while (this.nextSample < count) {
      const k = this.nextSample;
      const offset = this.sampleOffset[k]!;
      const end = offset + this.sampleSize[k]!;
      if (offset >= this.mdatEnd) return; // in an mdat that has not been reached yet
      if (offset < this.mdatStart || end > this.mdatEnd) {
        this.sampleError('sample data outside the mdat');
      } else if (end <= q.end) {
        const i = q.index(offset);
        this.frames.push({ pts: this.samplePts[k]!, duration: this.sampleDuration[k]!, data: q.bytes.slice(i, i + (end - offset)) });
      } else {
        return;
      }
      this.nextSample++;
    }
  }

  private clearSamples(): void {
    this.sampleOffset.length = 0;
    this.sampleSize.length = 0;
    this.samplePts.length = 0;
    this.sampleDuration.length = 0;
    this.retainFrom.length = 0;
    this.nextSample = 0;
  }

  /** Reports a framing error and starts scanning for the next moof (or moov/ftyp). */
  private fail(message: string): void {
    this.emit({ type: 'error', message: `MP4: ${message}` });
    this.resyncing = true;
    this.pos = Math.min(this.pos + 1, this.queue.end);
  }

  /** Moves `pos` to the next plausible moof/moov/ftyp box; false when none is buffered yet. */
  private scanForSync(): boolean {
    const q = this.queue;
    const b = q.bytes;
    const base = q.index(this.pos);
    const end = q.index(q.end);
    for (let i = base + 4; i + 4 <= end; i++) {
      const type = u32(b, i);
      if (type !== BOX_MOOF && type !== BOX_MOOV && type !== BOX_FTYP) continue;
      const size = u32(b, i - 4);
      if (size >= 8 && size <= MAX_BUFFERED_BOX) {
        this.pos += i - 4 - base;
        this.resyncing = false;
        return true;
      }
    }
    this.pos = Math.max(this.pos, q.end - 7);
    this.need = q.end + 1;
    return false;
  }

  private sampleError(message: string): void {
    if (this.moofErrorReported) return;
    this.moofErrorReported = true;
    this.emit({ type: 'error', message: `MP4: ${message}` });
  }

  private emit(event: DemuxEvent): void {
    this.flushFrames();
    this.events.push(event);
  }

  private flushFrames(): void {
    if (this.frames.length === 0) return;
    this.events.push({ type: 'frames', frames: this.frames });
    this.frames = [];
  }
}

/** Creates an incremental demuxer for an `audio/mp4` (AAC, MP3 or Opus) SourceBuffer byte stream. */
export function createMp4Demuxer(): Demuxer {
  return new Mp4Demuxer();
}
