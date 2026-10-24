// Entry point of the MSE audio demuxers: picks a parser from a SourceBuffer mime type.
import { createMp4Demuxer } from './mp4';
import { createWebmDemuxer } from './webm';
import type { Demuxer } from './types';

export type { AudioCodecConfig, Demuxer, DemuxEvent, EncodedAudioFrame } from './types';
export { opusPacketSamples } from './opus';

/**
 * Creates a demuxer for the byte stream of a SourceBuffer created with `mime`
 * (e.g. 'audio/webm; codecs="opus"', 'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="opus"').
 * The codec is read from the initialization segment, so unsupported codecs (e.g. Vorbis) are
 * reported as 'error' events. Returns null for non-audio or unsupported container types.
 */
export function createDemuxer(mime: string): Demuxer | null {
  const type = mime.split(';', 1)[0]!.trim().toLowerCase();
  if (type === 'audio/webm') return createWebmDemuxer();
  if (type === 'audio/mp4') return createMp4Demuxer();
  return null;
}
