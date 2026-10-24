import { describe, expect, it } from 'vitest';
import { createDemuxer } from '../../src/lib/demux';
import { opusHead, trackEntry, webmInit } from './helpers/demux-builders';

describe('createDemuxer', () => {
  it('returns a demuxer for audio WebM and MP4 mime types, case-insensitively', () => {
    for (const mime of [
      'audio/webm; codecs="opus"',
      'AUDIO/WEBM;CODECS="OPUS"',
      'audio/webm; codecs="vorbis"',
      'audio/mp4; codecs="mp4a.40.2"',
      'Audio/MP4; codecs="mp4a.40.5"',
      'audio/mp4; codecs="opus"',
      ' audio/mp4 ',
    ]) {
      expect(createDemuxer(mime), mime).not.toBeNull();
    }
  });

  it('returns null for video and unsupported containers', () => {
    for (const mime of ['video/webm; codecs="vp9"', 'video/mp4; codecs="avc1.4d401f"', 'audio/mpeg', 'audio/aac', 'text/vtt', '']) {
      expect(createDemuxer(mime), mime).toBeNull();
    }
  });

  it('dispatches to the right parser', () => {
    const init = webmInit({ tracks: [trackEntry({ codecPrivate: opusHead(1) })] });
    expect(createDemuxer('audio/webm; codecs="opus"')!.push(init)).toEqual([
      { type: 'config', config: { codec: 'opus', sampleRate: 48000, channels: 1, description: opusHead(1), codecDelaySamples: 312 } },
    ]);
    expect(createDemuxer('audio/mp4; codecs="mp4a.40.2"')!.push(init)[0]?.type).toBe('error');
  });

  it('reports Vorbis WebM streams as unsupported', () => {
    const events = createDemuxer('audio/webm; codecs="vorbis"')!.push(webmInit({ tracks: [trackEntry({ codecId: 'A_VORBIS', codecPrivate: Uint8Array.of(2, 1, 1, 0, 0) })] }));
    expect(events).toEqual([{ type: 'error', message: 'WebM: Vorbis is not supported' }]);
  });
});
