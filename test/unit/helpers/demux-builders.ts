// Byte-level builders for synthetic WebM (EBML) and fragmented MP4 streams used by the demux tests.
import { concat } from './demux-media';

type Bytes = Uint8Array | number[];

const toBytes = (parts: Bytes[]): Uint8Array => concat(...parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p))));

/** Big-endian bytes of a non-negative integer. */
export const be = (value: number, bytes: number): number[] => {
  const out: number[] = [];
  let v = value;
  for (let i = bytes - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
};

// ───────────── EBML / WebM ─────────────

export const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  SeekPreRoll: 0x56bb,
  DefaultDuration: 0x23e383,
  ContentEncodings: 0x6d80,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  DiscardPadding: 0x75a2,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Void: 0xec,
  CRC32: 0xbf,
} as const;

const idBytes = (id: number): number[] => be(id, id >= 0x1000000 ? 4 : id >= 0x10000 ? 3 : id >= 0x100 ? 2 : 1);

/** EBML variable-size integer with the minimal length (or `length` bytes). */
export function vint(value: number, length?: number): number[] {
  let n = length ?? 1;
  while (length === undefined && value >= 2 ** (7 * n) - 1) n++;
  const out = be(value, n);
  out[0]! |= 0x80 >> (n - 1);
  return out;
}

/** Element with a known size. */
export function el(id: number, ...payload: Bytes[]): Uint8Array {
  const data = toBytes(payload);
  return toBytes([idBytes(id), vint(data.length), data]);
}

/** Element with the reserved "unknown size" value. */
export function elUnknown(id: number, ...payload: Bytes[]): Uint8Array {
  return toBytes([idBytes(id), [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], ...payload]);
}

export function uintEl(id: number, value: number): Uint8Array {
  let n = 1;
  while (value >= 2 ** (8 * n)) n++;
  return el(id, be(value, n));
}

export const stringEl = (id: number, s: string): Uint8Array => el(id, [...s].map((c) => c.charCodeAt(0)));

/** OpusHead with mapping family 0. */
export function opusHead(channels = 2, preSkip = 312): Uint8Array {
  return Uint8Array.from([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels, preSkip & 0xff, preSkip >> 8, 0x80, 0xbb, 0, 0, 0, 0, 0]);
}

export interface WebmTrackOptions {
  number?: number;
  type?: number;
  codecId?: string;
  codecPrivate?: Uint8Array | null;
  codecDelayNs?: number;
  channels?: number;
  encrypted?: boolean;
}

export function trackEntry(o: WebmTrackOptions = {}): Uint8Array {
  return el(
    ID.TrackEntry,
    uintEl(ID.TrackNumber, o.number ?? 1),
    uintEl(ID.TrackType, o.type ?? 2),
    stringEl(ID.CodecID, o.codecId ?? 'A_OPUS'),
    o.codecPrivate === null ? [] : el(ID.CodecPrivate, o.codecPrivate ?? opusHead(o.channels ?? 2)),
    o.codecDelayNs === undefined ? [] : uintEl(ID.CodecDelay, o.codecDelayNs),
    uintEl(ID.SeekPreRoll, 80_000_000),
    o.encrypted ? el(ID.ContentEncodings, el(0x6240, uintEl(0x5031, 0))) : [],
    el(ID.Audio, el(ID.SamplingFrequency, [0x40, 0xe7, 0x70, 0, 0, 0, 0, 0]), uintEl(ID.Channels, o.channels ?? 2)),
  );
}

export interface WebmInitOptions {
  timecodeScale?: number;
  tracks?: Uint8Array[];
  /** Segment of unknown size (as in live / DASH streams); default true. */
  unknownSegment?: boolean;
}

/** EBML header + Segment header + SeekHead/Void/Info/Tracks/Tags (a WebM initialization segment). */
export function webmInit(o: WebmInitOptions = {}): Uint8Array {
  const header = el(ID.EBML, uintEl(0x4286, 1), stringEl(ID.DocType, 'webm'));
  const body = toBytes([
    el(ID.SeekHead, el(0x4dbb, el(0x53ab, idBytes(ID.Info)), uintEl(0x53ac, 10))),
    el(ID.Void, new Uint8Array(20)),
    el(ID.Info, uintEl(ID.TimecodeScale, o.timecodeScale ?? 1_000_000), el(0x4489, [0x40, 0xdd, 0x4e, 0, 0, 0, 0, 0])),
    el(ID.Tracks, ...(o.tracks ?? [trackEntry({ codecDelayNs: 6_500_000 })])),
    el(ID.Tags, el(0x7373, el(0x63c0))),
  ]);
  // A known-size Segment covers only the init here: the parser must ignore Segment sizes.
  return toBytes([header, o.unknownSegment === false ? el(ID.Segment, body) : elUnknown(ID.Segment, body)]);
}

export type Lacing = 'none' | 'xiph' | 'fixed' | 'ebml';

/** Block payload: track number, relative timecode, flags and (laced) frames. */
export function blockPayload(track: number, relative: number, frames: Uint8Array[], lacing: Lacing = 'none'): Uint8Array {
  const lacingBits = { none: 0, xiph: 1, ebml: 2, fixed: 3 }[lacing];
  const head = [...vint(track), (relative >> 8) & 0xff, relative & 0xff, 0x80 | (lacingBits << 1)];
  if (lacing === 'none') return toBytes([head, frames[0]!]);
  const sizes: number[] = [frames.length - 1];
  const inner = frames.slice(0, -1);
  if (lacing === 'xiph') {
    for (const f of inner) {
      for (let n = f.length; ; n -= 255) {
        sizes.push(Math.min(n, 255));
        if (n < 255) break;
      }
    }
  } else if (lacing === 'ebml') {
    inner.forEach((f, k) => {
      if (k === 0) return sizes.push(...vint(f.length));
      const diff = f.length - inner[k - 1]!.length;
      let n = 1;
      while (Math.abs(diff) > 2 ** (7 * n - 1) - 2) n++;
      return sizes.push(...vint(diff + 2 ** (7 * n - 1) - 1, n));
    });
  }
  return toBytes([head, sizes, ...frames]);
}

export const simpleBlock = (track: number, relative: number, frames: Uint8Array[], lacing: Lacing = 'none'): Uint8Array =>
  el(ID.SimpleBlock, blockPayload(track, relative, frames, lacing));

export function blockGroup(track: number, relative: number, frame: Uint8Array, durationTicks?: number): Uint8Array {
  return el(
    ID.BlockGroup,
    el(ID.Block, blockPayload(track, relative, [frame])),
    durationTicks === undefined ? [] : uintEl(ID.BlockDuration, durationTicks),
    el(ID.DiscardPadding, [0x10]),
  );
}

export function cluster(timecode: number, children: Uint8Array[], unknownSize = false): Uint8Array {
  const body = [el(ID.CRC32, [0, 0, 0, 0]), uintEl(ID.Timecode, timecode), ...children];
  return unknownSize ? elUnknown(ID.Cluster, ...body) : el(ID.Cluster, ...body);
}

/** An Opus packet with the given TOC byte (plus frame count byte for code 3) and filler payload. */
export function opusPacket(toc: number, size: number, fill = 0x55, frameCount?: number): Uint8Array {
  const p = new Uint8Array(size).fill(fill);
  p[0] = toc;
  if (frameCount !== undefined) p[1] = frameCount;
  return p;
}

// ───────────── ISO BMFF / MP4 ─────────────

const fourcc = (t: string): number[] => [...t].map((c) => c.charCodeAt(0));

export function box(type: string, ...payload: Bytes[]): Uint8Array {
  const data = toBytes(payload);
  return toBytes([be(8 + data.length, 4), fourcc(type), data]);
}

/** Box using the 64-bit largesize field. */
export function largeBox(type: string, ...payload: Bytes[]): Uint8Array {
  const data = toBytes(payload);
  return toBytes([be(1, 4), fourcc(type), be(16 + data.length, 8), data]);
}

export const fullBox = (type: string, version: number, flags: number, ...payload: Bytes[]): Uint8Array =>
  box(type, [version, ...be(flags, 3)], ...payload);

/** Bit writer for AudioSpecificConfig fixtures. */
export function bits(...fields: [value: number, width: number][]): Uint8Array {
  let s = '';
  for (const [v, w] of fields) s += v.toString(2).padStart(w, '0').slice(-w);
  while (s.length % 8) s += '0';
  return Uint8Array.from(s.match(/.{8}/g) ?? [], (b) => parseInt(b, 2));
}

/** ES_Descriptor > DecoderConfigDescriptor > DecoderSpecificInfo. */
export function esds(objectType: number, specificInfo?: Uint8Array): Uint8Array {
  const dsi = specificInfo ? [0x05, specificInfo.length, ...specificInfo] : [];
  const dcd = [0x04, 13 + dsi.length, objectType, 0x15, 0, 0, 0, ...be(128000, 4), ...be(128000, 4), ...dsi];
  // ES_Descriptor with a 4-byte expandable size field, as written by ffmpeg.
  const es = [0x03, 0x80, 0x80, 0x80, 3 + dcd.length + 3, 0, 1, 0, ...dcd, 0x06, 1, 2];
  return fullBox('esds', 0, 0, es);
}

export interface AudioEntryOptions {
  type?: string;
  channels?: number;
  sampleRate?: number;
  /** QuickTime sound sample description version (0, 1 or 2). */
  version?: number;
  children: Uint8Array[];
}

export function audioSampleEntry(o: AudioEntryOptions): Uint8Array {
  const extra = o.version === 1 ? 16 : o.version === 2 ? 36 : 0;
  return box(
    o.type ?? 'mp4a',
    [0, 0, 0, 0, 0, 0, 0, 1], // reserved, data_reference_index
    [...be(o.version ?? 0, 2), 0, 0, 0, 0, 0, 0], // version, revision, vendor
    [...be(o.channels ?? 2, 2), 0, 16, 0, 0, 0, 0, ...be((o.sampleRate ?? 48000) * 65536, 4)],
    new Uint8Array(extra),
    ...o.children,
  );
}

export function dOps(channels = 2, preSkip = 312, family = 0): Uint8Array {
  const mapping = family === 0 ? [] : [1, channels - 1, ...Array.from({ length: channels }, (_, i) => i)];
  return box('dOps', [0, channels, ...be(preSkip, 2), ...be(48000, 4), 0, 0, family, ...mapping]);
}

export interface Mp4TrackOptions {
  id: number;
  handler?: string;
  timescale?: number;
  sampleEntry?: Uint8Array;
}

export function trak(o: Mp4TrackOptions): Uint8Array {
  const entry = o.sampleEntry ?? audioSampleEntry({ children: [esds(0x40, Uint8Array.from([0x11, 0x90]))] });
  return box(
    'trak',
    fullBox('tkhd', 0, 3, new Uint8Array(8), be(o.id, 4), new Uint8Array(68)),
    box(
      'mdia',
      fullBox('mdhd', 0, 0, new Uint8Array(8), be(o.timescale ?? 48000, 4), new Uint8Array(8)),
      fullBox('hdlr', 0, 0, [0, 0, 0, 0], fourcc(o.handler ?? 'soun'), new Uint8Array(12), [0]),
      box('minf', box('stbl', fullBox('stsd', 0, 0, be(1, 4), entry))),
    ),
  );
}

export interface TrexDefaults {
  trackId: number;
  duration?: number;
  size?: number;
}

/** ftyp + moov with the given tracks and mvex/trex defaults. */
export function mp4Init(tracks: Uint8Array[], trex: TrexDefaults[]): Uint8Array {
  return toBytes([
    box('ftyp', fourcc('iso5'), be(512, 4), fourcc('iso6'), fourcc('mp41')),
    box(
      'moov',
      fullBox('mvhd', 0, 0, new Uint8Array(96)),
      ...tracks,
      box('mvex', ...trex.map((t) => fullBox('trex', 0, 0, be(t.trackId, 4), be(1, 4), be(t.duration ?? 0, 4), be(t.size ?? 0, 4), be(0, 4)))),
    ),
  ]);
}

export interface RunSample {
  data: Uint8Array;
  duration?: number;
  compositionOffset?: number;
}

export interface RunSpec {
  version?: number;
  samples: RunSample[];
  /** Write per-sample durations/sizes (default true) and composition offsets (default false). */
  durations?: boolean;
  sizes?: boolean;
  compositionOffsets?: boolean;
  /** Write the data-offset field (default true). */
  dataOffset?: boolean;
}

export interface TrafSpec {
  trackId: number;
  /** 'moof': default-base-is-moof; 'explicit': base-data-offset; 'chain': neither (ISO default rules). */
  base?: 'moof' | 'explicit' | 'chain';
  defaultDuration?: number;
  defaultSize?: number;
  tfdt?: { version: number; time: number } | null;
  runs: RunSpec[];
}

export interface FragmentOptions {
  /** Absolute stream position of the moof (for explicit base-data-offsets). */
  streamPos?: number;
  sequence?: number;
  /** Write the mdat with a 64-bit largesize header. */
  largeMdat?: boolean;
}

/** moof + mdat. Sample data is laid out in traf/run order in one mdat after the moof. */
export function mp4Fragment(trafs: TrafSpec[], options: FragmentOptions = {}): Uint8Array {
  const streamPos = options.streamPos ?? 0;
  const build = (moofSize: number): Uint8Array => {
    let dataPos = moofSize + (options.largeMdat ? 16 : 8); // fragment-relative position of the next sample byte
    let previousTrafEnd = 0;
    const trafBoxes = trafs.map((t, trafIndex) => {
      const mode = t.base ?? 'moof';
      const base = mode === 'explicit' ? 0 : mode === 'moof' || trafIndex === 0 ? 0 : previousTrafEnd;
      const tfhdFlags = (mode === 'explicit' ? 0x1 : 0) | (t.defaultDuration !== undefined ? 0x8 : 0) | (t.defaultSize !== undefined ? 0x10 : 0) | (mode === 'moof' ? 0x20000 : 0);
      const tfhd = fullBox(
        'tfhd', 0, tfhdFlags, be(t.trackId, 4),
        mode === 'explicit' ? be(streamPos, 8) : [],
        t.defaultDuration !== undefined ? be(t.defaultDuration, 4) : [],
        t.defaultSize !== undefined ? be(t.defaultSize, 4) : [],
      );
      const runs = t.runs.map((r) => {
        const durations = r.durations ?? true;
        const sizes = r.sizes ?? true;
        const offsets = r.compositionOffsets ?? false;
        const writeOffset = r.dataOffset ?? true;
        const flags = (writeOffset ? 0x1 : 0) | (durations ? 0x100 : 0) | (sizes ? 0x200 : 0) | (offsets ? 0x800 : 0);
        const fields = r.samples.flatMap((s) => [
          ...(durations ? be(s.duration ?? 1024, 4) : []),
          ...(sizes ? be(s.data.length, 4) : []),
          ...(offsets ? be((s.compositionOffset ?? 0) >>> 0, 4) : []),
        ]);
        const offset = writeOffset ? be((dataPos - base) >>> 0, 4) : [];
        dataPos += r.samples.reduce((n, s) => n + s.data.length, 0);
        return fullBox('trun', r.version ?? 0, flags, be(r.samples.length, 4), offset, fields);
      });
      previousTrafEnd = dataPos;
      const tfdt = t.tfdt === null || t.tfdt === undefined ? [] : fullBox('tfdt', t.tfdt.version, 0, be(t.tfdt.time, t.tfdt.version === 1 ? 8 : 4));
      return box('traf', tfhd, tfdt, ...runs);
    });
    const data = trafs.flatMap((t) => t.runs.flatMap((r) => r.samples.map((s) => s.data)));
    const mdat = options.largeMdat ? largeBox('mdat', ...data) : box('mdat', ...data);
    return toBytes([box('moof', fullBox('mfhd', 0, 0, be(options.sequence ?? 1, 4)), ...trafBoxes), mdat]);
  };
  const first = build(0);
  const moofSize = (first[0]! << 24) | (first[1]! << 16) | (first[2]! << 8) | first[3]!;
  return build(moofSize);
}
