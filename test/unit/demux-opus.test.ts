import { describe, expect, it } from 'vitest';
import { buildOpusHead, opusPacketSamples, parseOpusHead } from '../../src/lib/demux/opus';

/** Expected frame size (48 kHz samples) per TOC config, written out from RFC 6716 Table 2. */
function expectedFrameSamples(config: number): number {
  const ms = config < 12 ? [10, 20, 40, 60][config & 3]! : config < 16 ? [10, 20][config & 1]! : [2.5, 5, 10, 20][config & 3]!;
  return ms * 48;
}

const packet = (...bytes: number[]) => Uint8Array.from(bytes);

describe('opusPacketSamples', () => {
  it('covers every config for code 0 (one frame), with and without the stereo flag', () => {
    for (let config = 0; config < 32; config++) {
      for (const stereo of [0, 4]) {
        expect(opusPacketSamples(packet((config << 3) | stereo, 0xaa))).toBe(expectedFrameSamples(config));
      }
    }
  });

  it('counts two frames for code 1 (equal sizes) and code 2 (different sizes)', () => {
    for (let config = 0; config < 32; config++) {
      expect(opusPacketSamples(packet((config << 3) | 1, 1, 2))).toBe(2 * expectedFrameSamples(config));
      expect(opusPacketSamples(packet((config << 3) | 2, 1, 2, 3))).toBe(2 * expectedFrameSamples(config));
    }
  });

  it('reads the frame count of code 3 packets, ignoring the VBR and padding bits', () => {
    for (let config = 0; config < 32; config++) {
      for (const count of [1, 2, 3, 6, 48]) {
        for (const flags of [0x00, 0x40, 0x80, 0xc0]) {
          expect(opusPacketSamples(packet((config << 3) | 3, flags | count, 0))).toBe(count * expectedFrameSamples(config));
        }
      }
    }
  });

  it('matches known durations', () => {
    expect(opusPacketSamples(packet(0xfc, 0x00))).toBe(960); // CELT FB 20 ms, as libopus writes
    expect(opusPacketSamples(packet(0x78))).toBe(960); // Hybrid FB 20 ms (config 15)
    expect(opusPacketSamples(packet(0x18 | 3, 3))).toBe(3 * 2880); // SILK NB 60 ms × 3 = 180 ms (over the RFC limit, kept)
    expect(opusPacketSamples(packet(0x80 | 3, 48))).toBe(48 * 120); // CELT 2.5 ms × 48 = 120 ms
  });

  it('returns 0 when the duration cannot be determined', () => {
    expect(opusPacketSamples(new Uint8Array(0))).toBe(0);
    expect(opusPacketSamples(packet(0xfb))).toBe(0); // code 3 without a count byte
    expect(opusPacketSamples(packet(0xfb, 0x00))).toBe(0); // code 3 with M = 0
    expect(opusPacketSamples(packet(0xfb, 0xc0))).toBe(0);
  });
});

describe('OpusHead', () => {
  it('round-trips mapping family 0 and 1 headers', () => {
    const fields = { channels: 2, preSkip: 312, inputSampleRate: 44100, outputGain: -256, mappingFamily: 0 };
    const head = buildOpusHead(fields);
    expect(head.length).toBe(19);
    expect(Array.from(head.subarray(0, 12))).toEqual([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2, 0x38, 0x01]);
    expect(parseOpusHead(head)).toEqual(fields);

    const surround = { channels: 6, preSkip: 3840, inputSampleRate: 48000, outputGain: 0, mappingFamily: 1, streamCount: 4, coupledCount: 2, channelMapping: Uint8Array.from([0, 4, 1, 2, 3, 5]) };
    const head6 = buildOpusHead(surround);
    expect(head6.length).toBe(27);
    expect(parseOpusHead(head6)).toEqual(surround);
  });

  it('rejects invalid headers', () => {
    const head = buildOpusHead({ channels: 2, preSkip: 0, inputSampleRate: 48000, outputGain: 0, mappingFamily: 0 });
    expect(parseOpusHead(head.subarray(0, 18))).toBeNull();
    expect(parseOpusHead(Uint8Array.from(head, (v, i) => (i === 0 ? 0 : v)))).toBeNull(); // magic
    expect(parseOpusHead(Uint8Array.from(head, (v, i) => (i === 8 ? 0x10 : v)))).toBeNull(); // major version 1
    expect(parseOpusHead(Uint8Array.from(head, (v, i) => (i === 9 ? 0 : v)))).toBeNull(); // no channels
    expect(parseOpusHead(Uint8Array.from(head, (v, i) => (i === 9 ? 3 : v)))).toBeNull(); // family 0 with 3 channels
    expect(parseOpusHead(Uint8Array.from(head, (v, i) => (i === 18 ? 1 : v)))).toBeNull(); // family 1 without a mapping table
  });
});
