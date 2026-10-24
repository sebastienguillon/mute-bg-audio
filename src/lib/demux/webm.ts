// Incremental WebM (Matroska) audio demuxer for MSE byte streams, modelled on Chrome's
// WebMStreamParser: everything after a Segment header is parsed as a flat sequence of level-1
// elements, so media segments may start directly with a Cluster and Segment sizes are ignored.
import { OPUS_SAMPLE_RATE, opusPacketSamples, parseOpusHead } from './opus';
import { ByteQueue, type AudioCodecConfig, type Demuxer, type DemuxEvent, type EncodedAudioFrame } from './types';

// Element IDs, including their length marker bits as written in the stream.
const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CODEC_DELAY = 0x56aa;
const ID_DEFAULT_DURATION = 0x23e383;
const ID_CONTENT_ENCODINGS = 0x6d80;
const ID_AUDIO = 0xe1;
const ID_CHANNELS = 0x9f;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;
const ID_CUES = 0x1c53bb6b;
const ID_TAGS = 0x1254c367;
const ID_CHAPTERS = 0x1043a770;
const ID_ATTACHMENTS = 0x1941a469;
const ID_VOID = 0xec;
const ID_CRC32 = 0xbf;

const TRACK_TYPE_AUDIO = 2;
const DEFAULT_TIMECODE_SCALE = 1_000_000;
/** Largest element that is buffered whole (Info, Tracks, blocks); larger ones are treated as corrupt. */
const MAX_BUFFERED_ELEMENT = 8 * 1024 * 1024;

const NEED_MORE = 0;
const OK = 1;
const INVALID = -1;

interface ElementHeader {
  id: number;
  /** Data size in bytes, or -1 for "unknown size". */
  size: number;
  /** Bytes taken by the ID and size fields. */
  length: number;
}

/** Reads an element header from `b[i, end)` into `out`; returns OK, NEED_MORE or INVALID. */
function readHeader(b: Uint8Array, i: number, end: number, out: ElementHeader): number {
  if (i >= end) return NEED_MORE;
  const first = b[i]!;
  const idLength = first >= 0x80 ? 1 : first >= 0x40 ? 2 : first >= 0x20 ? 3 : first >= 0x10 ? 4 : 0;
  if (idLength === 0) return INVALID;
  if (i + idLength >= end) return NEED_MORE;
  let id = first;
  for (let k = 1; k < idLength; k++) id = id * 256 + b[i + k]!;
  const s = i + idLength;
  const sizeFirst = b[s]!;
  if (sizeFirst === 0) return INVALID;
  const sizeLength = Math.clz32(sizeFirst) - 23;
  if (s + sizeLength > end) return NEED_MORE;
  const mask = 0xff >> sizeLength;
  let size = sizeFirst & mask;
  let allOnes = size === mask;
  for (let k = 1; k < sizeLength; k++) {
    const v = b[s + k]!;
    size = size * 256 + v;
    if (v !== 0xff) allOnes = false;
  }
  if (!allOnes && size > Number.MAX_SAFE_INTEGER) return INVALID;
  out.id = id;
  out.size = allOnes ? -1 : size;
  out.length = idLength + sizeLength;
  return OK;
}

/** Calls `visit` for each child of the master element data `b[s, e)`; false when malformed. */
function forEachChild(b: Uint8Array, s: number, e: number, visit: (id: number, start: number, end: number) => void): boolean {
  const h: ElementHeader = { id: 0, size: 0, length: 0 };
  for (let p = s; p < e; ) {
    if (readHeader(b, p, e, h) !== OK || h.size < 0) return false;
    const start = p + h.length;
    const end = start + h.size;
    if (end > e) return false;
    visit(h.id, start, end);
    p = end;
  }
  return true;
}

/** Big-endian unsigned integer of up to 8 bytes (NaN when longer). */
function readUint(b: Uint8Array, s: number, e: number): number {
  if (e - s > 8) return NaN;
  let v = 0;
  for (let i = s; i < e; i++) v = v * 256 + b[i]!;
  return v;
}

function readString(b: Uint8Array, s: number, e: number): string {
  let out = '';
  for (let i = s; i < e && b[i] !== 0; i++) out += String.fromCharCode(b[i]!);
  return out;
}

interface TrackEntry {
  number: number;
  type: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  codecDelayNs?: number;
  defaultDurationNs?: number;
  channels: number;
  encoded: boolean;
}

function parseTrackEntry(b: Uint8Array, s: number, e: number): TrackEntry | null {
  const t: TrackEntry = { number: 0, type: 0, codecId: '', channels: 1, encoded: false };
  const ok = forEachChild(b, s, e, (id, cs, ce) => {
    switch (id) {
      case ID_TRACK_NUMBER:
        t.number = readUint(b, cs, ce);
        break;
      case ID_TRACK_TYPE:
        t.type = readUint(b, cs, ce);
        break;
      case ID_CODEC_ID:
        t.codecId = readString(b, cs, ce);
        break;
      case ID_CODEC_PRIVATE:
        t.codecPrivate = b.slice(cs, ce);
        break;
      case ID_CODEC_DELAY:
        t.codecDelayNs = readUint(b, cs, ce);
        break;
      case ID_DEFAULT_DURATION:
        t.defaultDurationNs = readUint(b, cs, ce);
        break;
      case ID_CONTENT_ENCODINGS:
        t.encoded = true;
        break;
      case ID_AUDIO:
        forEachChild(b, cs, ce, (aid, as, ae) => {
          if (aid === ID_CHANNELS) t.channels = readUint(b, as, ae);
        });
        break;
    }
  });
  return ok && t.number > 0 ? t : null;
}

/** The audio track being demuxed. */
interface AudioTrack {
  number: number;
  defaultDurationNs?: number;
}

class WebmDemuxer implements Demuxer {
  private readonly queue = new ByteQueue();
  private readonly header: ElementHeader = { id: 0, size: 0, length: 0 };
  private readonly laceSizes = new Int32Array(256);
  private events: DemuxEvent[] = [];
  private frames: EncodedAudioFrame[] = [];
  /** Absolute stream position of the next element header. */
  private pos = 0;
  /** Parsing can only progress once the queue end reaches this position. */
  private need = 0;
  private resyncing = false;
  private inCluster = false;
  /** Absolute end of the current Cluster (Infinity for unknown size). */
  private clusterEnd = Infinity;
  /** Cluster Timecode in TimecodeScale ticks; NaN until read. */
  private clusterTimecode = NaN;
  /** At most one block-level error is reported per Cluster. */
  private clusterErrorReported = false;
  private timecodeScale = DEFAULT_TIMECODE_SCALE;
  private track: AudioTrack | null = null;
  private tracksSeen = false;

  push(bytes: Uint8Array): DemuxEvent[] {
    this.queue.push(bytes);
    if (this.queue.end >= this.need) {
      try {
        this.parse();
      } catch (e) {
        this.fail(`internal parser error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.queue.discard(this.pos);
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
    this.inCluster = false;
    this.clusterTimecode = NaN;
  }

  private parse(): void {
    const q = this.queue;
    const h = this.header;
    for (;;) {
      if (this.resyncing && !this.scanForSync()) return;
      if (this.inCluster && this.pos >= this.clusterEnd) this.inCluster = false;
      if (this.pos >= q.end) {
        this.need = this.pos + 1;
        return;
      }
      const status = readHeader(q.bytes, q.index(this.pos), q.index(q.end), h);
      if (status === NEED_MORE) {
        this.need = q.end + 1;
        return;
      }
      if (status === INVALID) {
        this.fail('invalid EBML element header');
        continue;
      }
      if (!(this.inCluster ? this.parseClusterChild(h) : this.parseTopLevel(h))) return;
    }
  }

  /** Handles a level-1 element; returns false when more data is needed. */
  private parseTopLevel(h: ElementHeader): boolean {
    const dataStart = this.pos + h.length;
    switch (h.id) {
      case ID_SEGMENT:
        this.pos = dataStart;
        return true;
      case ID_CLUSTER:
        this.pos = dataStart;
        this.inCluster = true;
        this.clusterEnd = h.size < 0 ? Infinity : dataStart + h.size;
        this.clusterTimecode = NaN;
        this.clusterErrorReported = false;
        return true;
      case ID_INFO:
      case ID_TRACKS: {
        if (h.size < 0 || h.size > MAX_BUFFERED_ELEMENT) return this.fail('invalid Info/Tracks size');
        const dataEnd = dataStart + h.size;
        if (this.queue.end < dataEnd) {
          this.need = dataEnd;
          return false;
        }
        const s = this.queue.index(dataStart);
        if (h.id === ID_INFO) this.parseInfo(this.queue.bytes, s, s + h.size);
        else this.parseTracks(this.queue.bytes, s, s + h.size);
        this.pos = dataEnd;
        return true;
      }
      case ID_EBML:
        // A new initialization segment: its Info and Tracks follow.
        this.timecodeScale = DEFAULT_TIMECODE_SCALE;
        return this.skip(h, dataStart);
      case ID_SEEK_HEAD:
      case ID_CUES:
      case ID_TAGS:
      case ID_CHAPTERS:
      case ID_ATTACHMENTS:
      case ID_VOID:
      case ID_CRC32:
        return this.skip(h, dataStart);
      default:
        return this.fail(`unexpected top-level element 0x${h.id.toString(16)}`);
    }
  }

  /** Handles an element inside a Cluster; returns false when more data is needed. */
  private parseClusterChild(h: ElementHeader): boolean {
    switch (h.id) {
      case ID_CLUSTER:
      case ID_EBML:
      case ID_SEGMENT:
      case ID_INFO:
      case ID_TRACKS:
      case ID_CUES:
      case ID_TAGS:
      case ID_SEEK_HEAD:
      case ID_CHAPTERS:
      case ID_ATTACHMENTS:
        // A level-1 element ends the (unknown-size) Cluster; handle it at the top level.
        this.inCluster = false;
        return true;
    }
    const dataStart = this.pos + h.length;
    if (h.size < 0) return this.fail('unknown-size element inside a Cluster');
    const dataEnd = dataStart + h.size;
    if (dataEnd > this.clusterEnd) return this.fail('element overflows its Cluster');
    if (h.id !== ID_TIMECODE && h.id !== ID_SIMPLE_BLOCK && h.id !== ID_BLOCK_GROUP) return this.skip(h, dataStart);
    if (h.size > MAX_BUFFERED_ELEMENT) return this.fail('block too large');
    if (this.queue.end < dataEnd) {
      this.need = dataEnd;
      return false;
    }
    const b = this.queue.bytes;
    const s = this.queue.index(dataStart);
    const e = s + h.size;
    if (h.id === ID_TIMECODE) {
      this.clusterTimecode = readUint(b, s, e);
      if (Number.isNaN(this.clusterTimecode)) this.blockError('invalid Cluster Timecode');
    } else if (h.id === ID_SIMPLE_BLOCK) {
      this.parseBlock(b, s, e, -1);
    } else {
      this.parseBlockGroup(b, s, e);
    }
    this.pos = dataEnd;
    return true;
  }

  private skip(h: ElementHeader, dataStart: number): boolean {
    if (h.size < 0) return this.fail(`unknown-size element 0x${h.id.toString(16)}`);
    this.pos = dataStart + h.size;
    return true;
  }

  /** Reports a framing error and starts scanning for the next Cluster or EBML header. */
  private fail(message: string): boolean {
    this.emit({ type: 'error', message: `WebM: ${message}` });
    this.resyncing = true;
    this.inCluster = false;
    this.pos = Math.min(this.pos + 1, this.queue.end);
    return true;
  }

  /** Moves `pos` to the next Cluster or EBML header ID; false when none is buffered yet. */
  private scanForSync(): boolean {
    const q = this.queue;
    const b = q.bytes;
    const base = q.index(this.pos);
    const end = q.index(q.end);
    for (let i = base; i + 4 <= end; i++) {
      const c = b[i];
      if (
        (c === 0x1f && b[i + 1] === 0x43 && b[i + 2] === 0xb6 && b[i + 3] === 0x75) ||
        (c === 0x1a && b[i + 1] === 0x45 && b[i + 2] === 0xdf && b[i + 3] === 0xa3)
      ) {
        this.pos += i - base;
        this.resyncing = false;
        return true;
      }
    }
    this.pos = Math.max(this.pos, q.end - 3);
    this.need = q.end + 1;
    return false;
  }

  private parseInfo(b: Uint8Array, s: number, e: number): void {
    let scale = DEFAULT_TIMECODE_SCALE;
    const ok = forEachChild(b, s, e, (id, cs, ce) => {
      if (id === ID_TIMECODE_SCALE) scale = readUint(b, cs, ce);
    });
    if (!ok || !(scale > 0)) {
      this.emit({ type: 'error', message: 'WebM: invalid Info element' });
      return;
    }
    this.timecodeScale = scale;
  }

  private parseTracks(b: Uint8Array, s: number, e: number): void {
    this.tracksSeen = true;
    this.track = null;
    const entries: TrackEntry[] = [];
    const ok = forEachChild(b, s, e, (id, cs, ce) => {
      const entry = id === ID_TRACK_ENTRY ? parseTrackEntry(b, cs, ce) : null;
      if (entry) entries.push(entry);
    });
    const entry = entries.find((t) => t.type === TRACK_TYPE_AUDIO);
    if (!ok || !entry) {
      this.emit({ type: 'error', message: ok ? 'WebM: no audio track' : 'WebM: invalid Tracks element' });
      return;
    }
    if (entry.encoded) {
      this.emit({ type: 'error', message: 'WebM: encrypted or compressed audio tracks are not supported' });
      return;
    }
    if (entry.codecId !== 'A_OPUS') {
      const name = entry.codecId === 'A_VORBIS' ? 'Vorbis' : `codec ${entry.codecId || '(none)'}`;
      this.emit({ type: 'error', message: `WebM: ${name} is not supported` });
      return;
    }
    const config: AudioCodecConfig = { codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, channels: entry.channels };
    let preSkip: number | undefined;
    if (entry.codecPrivate) {
      const head = parseOpusHead(entry.codecPrivate);
      if (!head) {
        this.emit({ type: 'error', message: 'WebM: invalid OpusHead in CodecPrivate' });
        return;
      }
      config.channels = head.channels;
      config.description = entry.codecPrivate;
      preSkip = head.preSkip;
    } else if (!(entry.channels >= 1 && entry.channels <= 2)) {
      this.emit({ type: 'error', message: 'WebM: Opus track without CodecPrivate must be mono or stereo' });
      return;
    }
    if (entry.codecDelayNs !== undefined && Number.isFinite(entry.codecDelayNs)) {
      config.codecDelaySamples = Math.round((entry.codecDelayNs * OPUS_SAMPLE_RATE) / 1e9);
    } else if (preSkip !== undefined) {
      config.codecDelaySamples = preSkip;
    }
    this.track = { number: entry.number };
    if (entry.defaultDurationNs !== undefined) this.track.defaultDurationNs = entry.defaultDurationNs;
    this.emit({ type: 'config', config });
  }

  private parseBlockGroup(b: Uint8Array, s: number, e: number): void {
    let blockStart = -1;
    let blockEnd = -1;
    let durationTicks = -1;
    const ok = forEachChild(b, s, e, (id, cs, ce) => {
      if (id === ID_BLOCK) {
        blockStart = cs;
        blockEnd = ce;
      } else if (id === ID_BLOCK_DURATION) {
        durationTicks = readUint(b, cs, ce);
      }
    });
    if (!ok) this.blockError('invalid BlockGroup');
    else if (blockStart >= 0) this.parseBlock(b, blockStart, blockEnd, Number.isNaN(durationTicks) ? -1 : durationTicks);
  }

  /** Parses a (Simple)Block in `b[s, e)`; `durationTicks` is its BlockDuration or -1. */
  private parseBlock(b: Uint8Array, s: number, e: number, durationTicks: number): void {
    const track = this.track;
    if (!track) {
      if (!this.tracksSeen) this.blockError('media data before an initialization segment');
      return;
    }
    const first = s < e ? b[s]! : 0;
    const numberLength = Math.clz32(first) - 23;
    if (first === 0 || s + numberLength > e) return this.blockError('invalid block track number');
    let trackNumber = first & (0xff >> numberLength);
    for (let k = 1; k < numberLength; k++) trackNumber = trackNumber * 256 + b[s + k]!;
    if (trackNumber !== track.number) return;
    let p = s + numberLength;
    if (p + 3 > e) return this.blockError('truncated block header');
    if (Number.isNaN(this.clusterTimecode)) return this.blockError('block before the Cluster Timecode');
    const relative = (((b[p]! << 8) | b[p + 1]!) << 16) >> 16;
    const lacing = (b[p + 2]! >> 1) & 3;
    p += 3;

    const sizes = this.laceSizes;
    let count = 1;
    if (lacing === 0) {
      sizes[0] = e - p;
    } else {
      if (p >= e) return this.blockError('truncated lacing header');
      count = b[p++]! + 1;
      p = lacing === 1 ? this.readXiphLacing(b, p, e, count) : lacing === 3 ? this.readFixedLacing(p, e, count) : this.readEbmlLacing(b, p, e, count);
      if (p < 0) return this.blockError('invalid lacing');
    }

    const scale = this.timecodeScale;
    const blockPts = ((this.clusterTimecode + relative) * scale) / 1e9;
    let fallbackDuration = 0;
    if (durationTicks >= 0) fallbackDuration = (durationTicks * scale) / 1e9 / count;
    else if (track.defaultDurationNs !== undefined) fallbackDuration = track.defaultDurationNs / 1e9;
    let offsetSeconds = 0;
    for (let k = 0; k < count; k++) {
      const data = b.slice(p, p + sizes[k]!);
      p += sizes[k]!;
      const samples = opusPacketSamples(data);
      const duration = samples > 0 ? samples / OPUS_SAMPLE_RATE : fallbackDuration;
      this.frames.push({ pts: blockPts + offsetSeconds, duration, data });
      offsetSeconds += duration;
    }
  }

  /** Xiph lacing: fills laceSizes, returns the payload start or -1. */
  private readXiphLacing(b: Uint8Array, p: number, e: number, count: number): number {
    const sizes = this.laceSizes;
    let total = 0;
    for (let k = 0; k < count - 1; k++) {
      let size = 0;
      let v: number;
      do {
        if (p >= e) return -1;
        v = b[p++]!;
        size += v;
      } while (v === 255);
      sizes[k] = size;
      total += size;
    }
    return this.finishLacing(p, e, count, total);
  }

  /** EBML lacing: first size as an unsigned vint, then signed vint differences. */
  private readEbmlLacing(b: Uint8Array, p: number, e: number, count: number): number {
    const sizes = this.laceSizes;
    let total = 0;
    let size = 0;
    for (let k = 0; k < count - 1; k++) {
      if (p >= e || b[p] === 0) return -1;
      const first = b[p]!;
      const length = Math.clz32(first) - 23;
      if (p + length > e) return -1;
      let v = first & (0xff >> length);
      for (let i = 1; i < length; i++) v = v * 256 + b[p + i]!;
      p += length;
      size = k === 0 ? v : size + v - (2 ** (7 * length - 1) - 1);
      if (size < 0) return -1;
      sizes[k] = size;
      total += size;
    }
    return this.finishLacing(p, e, count, total);
  }

  private readFixedLacing(p: number, e: number, count: number): number {
    const total = e - p;
    if (total % count !== 0) return -1;
    this.laceSizes.fill(total / count, 0, count);
    return p;
  }

  /** Sets the last lace size to the remaining bytes; -1 when the sizes overflow the block. */
  private finishLacing(p: number, e: number, count: number, total: number): number {
    const last = e - p - total;
    if (last < 0) return -1;
    this.laceSizes[count - 1] = last;
    return p;
  }

  private blockError(message: string): void {
    if (this.clusterErrorReported) return;
    this.clusterErrorReported = true;
    this.emit({ type: 'error', message: `WebM: ${message}` });
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

/** Creates an incremental demuxer for an `audio/webm` (Opus) SourceBuffer byte stream. */
export function createWebmDemuxer(): Demuxer {
  return new WebmDemuxer();
}
