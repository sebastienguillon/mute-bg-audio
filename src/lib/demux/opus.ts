// Opus helpers: packet duration from the TOC byte (RFC 6716 §3.1) and the OpusHead
// identification header (RFC 7845 §5.1).

/** Opus always decodes at 48 kHz. */
export const OPUS_SAMPLE_RATE = 48000;

/** Frame size in samples at 48 kHz for each of the 32 TOC configurations (RFC 6716 Table 2). */
const FRAME_SAMPLES = new Uint16Array([
  480, 960, 1920, 2880, // SILK NB: 10, 20, 40, 60 ms
  480, 960, 1920, 2880, // SILK MB
  480, 960, 1920, 2880, // SILK WB
  480, 960, // Hybrid SWB: 10, 20 ms
  480, 960, // Hybrid FB
  120, 240, 480, 960, // CELT NB: 2.5, 5, 10, 20 ms
  120, 240, 480, 960, // CELT WB
  120, 240, 480, 960, // CELT SWB
  120, 240, 480, 960, // CELT FB
]);

/**
 * Number of samples (at 48 kHz) in an Opus packet, from its TOC byte and, for code 3 packets, the
 * frame count byte. Returns 0 for packets whose duration cannot be determined (empty packet, code 3
 * without a frame count byte, or a frame count of 0). Durations above the 120 ms limit of RFC 6716
 * are returned as computed (like Chrome, the decoder decides what to do with them).
 */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  const frameSamples = FRAME_SAMPLES[toc >> 3]!;
  switch (toc & 3) {
    case 0:
      return frameSamples;
    case 1:
    case 2:
      return 2 * frameSamples;
    default:
      return packet.length < 2 ? 0 : (packet[1]! & 0x3f) * frameSamples;
  }
}

/** Fields of an OpusHead / dOps header. */
export interface OpusHeadFields {
  channels: number;
  preSkip: number;
  inputSampleRate: number;
  /** Q7.8 dB, signed. */
  outputGain: number;
  mappingFamily: number;
  /** Present when `mappingFamily !== 0`. */
  streamCount?: number;
  coupledCount?: number;
  channelMapping?: Uint8Array;
}

const OPUS_HEAD_MAGIC = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"

/** Parses an OpusHead (e.g. WebM CodecPrivate). Returns null when it is not a valid version 1 header. */
export function parseOpusHead(head: Uint8Array): OpusHeadFields | null {
  if (head.length < 19) return null;
  for (let i = 0; i < 8; i++) if (head[i] !== OPUS_HEAD_MAGIC[i]) return null;
  if (head[8]! >> 4 !== 0) return null; // major version must be 0 (version 1..15)
  const channels = head[9]!;
  const mappingFamily = head[18]!;
  if (channels === 0) return null;
  const fields: OpusHeadFields = {
    channels,
    preSkip: head[10]! | (head[11]! << 8),
    inputSampleRate: (head[12]! | (head[13]! << 8) | (head[14]! << 16) | (head[15]! << 24)) >>> 0,
    outputGain: ((head[16]! | (head[17]! << 8)) << 16) >> 16,
    mappingFamily,
  };
  if (mappingFamily !== 0) {
    if (head.length < 21 + channels) return null;
    fields.streamCount = head[19]!;
    fields.coupledCount = head[20]!;
    fields.channelMapping = head.slice(21, 21 + channels);
  } else if (channels > 2) {
    return null;
  }
  return fields;
}

/** Builds an OpusHead (19 bytes for mapping family 0, 21 + channels otherwise). */
export function buildOpusHead(fields: OpusHeadFields): Uint8Array {
  const mapped = fields.mappingFamily !== 0;
  const head = new Uint8Array(mapped ? 21 + fields.channels : 19);
  head.set(OPUS_HEAD_MAGIC);
  head[8] = 1;
  head[9] = fields.channels;
  head[10] = fields.preSkip & 0xff;
  head[11] = (fields.preSkip >> 8) & 0xff;
  for (let i = 0; i < 4; i++) head[12 + i] = (fields.inputSampleRate >>> (8 * i)) & 0xff;
  head[16] = fields.outputGain & 0xff;
  head[17] = (fields.outputGain >> 8) & 0xff;
  head[18] = fields.mappingFamily;
  if (mapped) {
    head[19] = fields.streamCount ?? 0;
    head[20] = fields.coupledCount ?? 0;
    if (fields.channelMapping) head.set(fields.channelMapping.subarray(0, fields.channels), 21);
  }
  return head;
}
