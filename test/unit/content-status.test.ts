// Pure parts of the page controller: status change keys, mixer mode mapping and host rules.
import { describe, expect, it } from 'vitest';
import { isYouTubeHost } from '../../src/content/media';
import { mixerStatus, statusKey } from '../../src/content/status';
import type { MixerStats, TabStatus } from '../../src/lib/protocol';

const stats = (patch: Partial<MixerStats>): MixerStats => ({
  mode: 'realtime',
  locked: false,
  latency: 2880,
  underruns: 0,
  inRms: 0.1,
  outRms: 0.05,
  laAhead: 0,
  rtRoundTripMs: 4,
  rtHealthy: true,
  ...patch,
});

describe('statusKey', () => {
  const status = (aheadSeconds: number, rtf: number): TabStatus => ({
    mode: 'lookahead',
    site: 'youtube',
    enabled: true,
    latencyMs: 60,
    lookahead: { state: 'ready', backend: 'webgpu', aheadSeconds, rtf },
  });

  it('ignores look-ahead progress within 5 s buckets and rtf within 0.05', () => {
    expect(statusKey(status(20.1, 0.081))).toBe(statusKey(status(21.9, 0.089)));
    expect(statusKey(status(22.6, 0.09))).not.toBe(statusKey(status(20.1, 0.09)));
    expect(statusKey(status(20, 0.081))).not.toBe(statusKey(status(20, 0.126)));
  });

  it('changes with anything else', () => {
    expect(statusKey(status(20, 0.08))).not.toBe(statusKey({ ...status(20, 0.08), mode: 'realtime' }));
    expect(statusKey(status(20, 0.08))).not.toBe(statusKey({ ...status(20, 0.08), latencyMs: 70 }));
    const plain: TabStatus = { mode: 'waiting', site: 'generic', enabled: true, detail: 'Paused.' };
    expect(statusKey(plain)).toBe(JSON.stringify(plain));
    expect(statusKey(plain)).not.toBe(statusKey({ ...plain, detail: 'No sound.' }));
  });
});

describe('mixerStatus', () => {
  it('reports processing modes with their latency', () => {
    expect(mixerStatus(stats({ mode: 'realtime' }), false, null)).toEqual({ mode: 'realtime', latencyMs: 60 });
    expect(mixerStatus(stats({ mode: 'lookahead', latency: 3360 }), false, null)).toEqual({ mode: 'lookahead', latencyMs: 70 });
  });

  it("maps 'idle' to waiting: paused, or playing without sound", () => {
    expect(mixerStatus(stats({ mode: 'idle' }), true, null)).toEqual({ mode: 'waiting', detail: 'Paused.' });
    expect(mixerStatus(stats({ mode: 'idle' }), false, null)).toEqual({ mode: 'waiting', detail: 'No sound.' });
  });

  it('explains pass-through with the real-time error', () => {
    expect(mixerStatus(stats({ mode: 'passthrough' }), false, 'The real-time model failed to start.')).toEqual({
      mode: 'passthrough',
      latencyMs: 60,
      detail: 'The real-time model failed to start.',
    });
    expect(mixerStatus(stats({ mode: 'passthrough' }), false, null)).toEqual({ mode: 'passthrough', latencyMs: 60 });
  });

  it("treats 'bypass' while enabled as starting", () => {
    expect(mixerStatus(stats({ mode: 'bypass', latency: 0 }), false, null)).toEqual({ mode: 'starting' });
  });
});

describe('YouTube hosts', () => {
  it('recognises every host the YouTube content scripts run on', () => {
    for (const host of ['www.youtube.com', 'music.youtube.com', 'studio.youtube.com', 'youtube.com', 'www.youtube-nocookie.com']) {
      expect(isYouTubeHost(host), host).toBe(true);
    }
    for (const host of ['vimeo.com', 'notyoutube.com', 'youtube.com.evil.test']) expect(isYouTubeHost(host), host).toBe(false);
  });
});
