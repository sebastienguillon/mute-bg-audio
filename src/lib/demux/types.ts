// Shared types of the incremental MSE audio demuxers, plus the byte queue both parsers use.

/** Decoder configuration, ready for a WebCodecs `AudioDecoderConfig`. */
export type AudioCodecConfig = {
  /** WebCodecs codec string: 'opus', 'mp4a.40.<aot>' or 'mp3'. */
  codec: string;
  sampleRate: number;
  channels: number;
  /** OpusHead for Opus (WebM CodecPrivate, or built from an MP4 dOps box); AudioSpecificConfig for AAC. */
  description?: Uint8Array;
  /** Opus pre-skip (or WebM CodecDelay) in samples at 48 kHz. */
  codecDelaySamples?: number;
};

/** One encoded audio frame (an Opus packet or an AAC access unit). */
export interface EncodedAudioFrame {
  /** Container timestamp in seconds (SourceBuffer.timestampOffset is NOT applied). */
  pts: number;
  /** Seconds; from the Opus TOC for Opus in WebM, from trun/defaults for MP4. */
  duration: number;
  /** Standalone copy of the frame bytes. */
  data: Uint8Array;
}

export type DemuxEvent =
  | { type: 'config'; config: AudioCodecConfig }
  | { type: 'frames'; frames: EncodedAudioFrame[] }
  | { type: 'error'; message: string };

/** Incremental parser for the bytes appended to one audio SourceBuffer. */
export interface Demuxer {
  /** Parses the next bytes of the stream (any split is allowed). Never throws. */
  push(bytes: Uint8Array): DemuxEvent[];
  /**
   * Like SourceBuffer.abort(): drops partially parsed data; the next bytes must start at an
   * element/box boundary. The codec configuration and timescale are kept.
   */
  reset(): void;
}

/**
 * FIFO of stream bytes addressed by absolute stream position (bytes pushed since construction).
 *
 * Bytes before a position can be discarded even before they arrive, so skipped regions are never
 * buffered. When the queue is empty, a pushed chunk is borrowed instead of copied; `release()`
 * must be called before control returns to the owner of that chunk.
 */
export class ByteQueue {
  /** Storage; `bytes[head, tail)` holds stream positions `[start, end)`. Valid until the next mutation. */
  bytes: Uint8Array = new Uint8Array(0);
  private head = 0;
  private tail = 0;
  private startPos = 0;
  /** Arriving bytes before this position are dropped (only meaningful while the queue is empty). */
  private discardTo = 0;
  private owned = new Uint8Array(0);

  /** Absolute position of the first retained byte. */
  get start(): number {
    return this.startPos;
  }

  /** Absolute position just past the last retained byte. */
  get end(): number {
    return this.startPos + (this.tail - this.head);
  }

  /** Index into `bytes` of absolute position `pos` (`start <= pos <= end`). */
  index(pos: number): number {
    return this.head + (pos - this.startPos);
  }

  push(chunk: Uint8Array): void {
    let data = chunk;
    if (this.head === this.tail && this.discardTo > this.startPos) {
      const drop = Math.min(data.length, this.discardTo - this.startPos);
      this.startPos += drop;
      data = data.subarray(drop);
    }
    if (data.length === 0) return;
    if (this.head === this.tail) {
      this.bytes = data;
      this.head = 0;
      this.tail = data.length;
      return;
    }
    const size = this.tail - this.head;
    if (this.bytes !== this.owned || this.tail + data.length > this.owned.length) {
      // Compact (and grow when needed) so the retained bytes start at index 0.
      let target = this.owned;
      if (size + data.length > target.length) {
        target = new Uint8Array(Math.max(size + data.length, 2 * target.length, 4096));
      }
      if (this.bytes === target) target.copyWithin(0, this.head, this.tail);
      else target.set(this.bytes.subarray(this.head, this.tail));
      this.owned = target;
      this.bytes = target;
      this.head = 0;
      this.tail = size;
    }
    this.bytes.set(data, this.tail);
    this.tail += data.length;
  }

  /** Drops every byte before `pos`; `pos` may lie beyond `end`. */
  discard(pos: number): void {
    if (pos <= this.startPos) return;
    if (pos >= this.end) {
      this.startPos = this.end;
      this.discardTo = pos;
      this.bytes = this.owned;
      this.head = this.tail = 0;
      return;
    }
    this.head += pos - this.startPos;
    this.startPos = pos;
  }

  /** Copies retained borrowed bytes into owned storage. */
  release(): void {
    if (this.bytes === this.owned) return;
    const size = this.tail - this.head;
    if (size > this.owned.length) this.owned = new Uint8Array(Math.max(size, 4096));
    this.owned.set(this.bytes.subarray(this.head, this.tail));
    this.bytes = this.owned;
    this.head = 0;
    this.tail = size;
  }

  /** Drops all retained bytes; positions keep counting from the current end. */
  clear(): void {
    this.discard(this.end);
  }
}
