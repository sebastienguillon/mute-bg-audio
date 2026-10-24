// A deterministic model of the Media Source Extensions event semantics (W3C MSE), for running the
// MAIN-world hook in Node. Every asynchronous step of the spec ("queue a task", "in parallel")
// goes through one explicit task queue, so tests decide what runs in the same task.
import { vi } from 'vitest';
import { HOOK_HANDSHAKE, type HookMessage } from '../../../src/lib/protocol';

export class TaskQueue {
  private tasks: (() => void)[] = [];

  queue(task: () => void): void {
    this.tasks.push(task);
  }

  /** Runs tasks (including the ones they queue) until none is left. */
  run(): void {
    for (let task = this.tasks.shift(); task; task = this.tasks.shift()) task();
  }
}

const invalidState = () => new DOMException('The SourceBuffer is in an invalid state.', 'InvalidStateError');

/** The receiving end of the hook's port: records every message as the receiver would get it. */
export class FakePort {
  readonly messages: HookMessage[] = [];
  closed = false;

  postMessage(msg: HookMessage, transfer: Transferable[] = []): void {
    // Like a real port: transferred buffers are detached on the sender's side.
    this.messages.push(structuredClone(msg, { transfer }));
  }

  close(): void {
    this.closed = true;
  }

  appends(): Extract<HookMessage, { type: 'sb-append' }>[] {
    return this.messages.filter((m): m is Extract<HookMessage, { type: 'sb-append' }> => m.type === 'sb-append');
  }
}

export interface FakeMseEnv {
  tasks: TaskQueue;
  window: EventTarget & Record<PropertyKey, unknown>;
  MediaSource: typeof FakeMediaSourceBase;
  SourceBuffer: typeof FakeSourceBufferBase;
  HTMLMediaElement: typeof FakeMediaElementBase;
  MediaSourceHandle: new () => object;
  /** Connects like the ISOLATED-world HookBridge does and returns the receiving port. */
  connect(): FakePort;
}

// Base classes are declared once for typing; installFakeMse() creates fresh subclasses (with
// fresh prototypes) per test because the hook replaces prototype methods.
export declare class FakeSourceBufferBase extends EventTarget {
  updating: boolean;
  timestampOffset: number;
  appendWindowStart: number;
  appendWindowEnd: number;
  type: string;
  /** Byte sizes of the appends the "browser" buffered, in completion order. */
  readonly buffered: number[];
  /** The next append fails in the segment parser (append error algorithm). */
  failNext: boolean;
  /** The next appendBuffer() throws QuotaExceededError. */
  quotaNext: boolean;
  appendBuffer(data: BufferSource): void;
  abort(): void;
  remove(start: number, end: number): void;
  changeType(type: string): void;
}

export declare class FakeMediaSourceBase extends EventTarget {
  readyState: 'open' | 'closed';
  sourceBuffers: FakeSourceBufferBase[];
  addSourceBuffer(type: string): FakeSourceBufferBase;
  removeSourceBuffer(sb: FakeSourceBufferBase): void;
  /** The media element stopped using this MediaSource (new src, SPA navigation). */
  detach(): void;
}

export declare class FakeMediaElementBase {
  srcObject: unknown;
}

/** Creates a fresh fake MSE world and installs it as the globals the hook uses. */
export function installFakeMse(): FakeMseEnv {
  const tasks = new TaskQueue();

  class SourceBuffer extends EventTarget {
    updating = false;
    timestampOffset = 0;
    appendWindowStart = 0;
    appendWindowEnd = Infinity;
    readonly buffered: number[] = [];
    failNext = false;
    quotaNext = false;
    parent: MediaSource | null;
    /** The running append or removal (cleared when it completes or is aborted). */
    op: object | null = null;
    removing = false;

    constructor(
      parent: MediaSource,
      public type: string,
    ) {
      super();
      this.parent = parent;
    }

    fire(type: string): void {
      this.dispatchEvent(new Event(type));
    }

    appendBuffer(data: BufferSource): void {
      if (!this.parent || this.updating) throw invalidState();
      if (this.quotaNext) {
        this.quotaNext = false;
        throw new DOMException('The SourceBuffer is full.', 'QuotaExceededError');
      }
      const bytes = data.byteLength;
      const fail = this.failNext;
      this.failNext = false;
      this.updating = true;
      const op = {};
      this.op = op;
      tasks.queue(() => this.fire('updatestart'));
      // Segment parser loop, run "in parallel": completes in a later task.
      tasks.queue(() => {
        if (this.op !== op) return;
        this.op = null;
        this.updating = false;
        if (fail) {
          tasks.queue(() => this.fire('error'));
        } else {
          this.buffered.push(bytes);
          tasks.queue(() => this.fire('update'));
        }
        tasks.queue(() => this.fire('updateend'));
      });
    }

    /** "Abort the buffer append algorithm": queues abort and updateend for the current append. */
    abortAppend(): void {
      this.op = null;
      this.updating = false;
      tasks.queue(() => this.fire('abort'));
      tasks.queue(() => this.fire('updateend'));
    }

    abort(): void {
      if (!this.parent || this.parent.readyState !== 'open' || this.removing) throw invalidState();
      if (this.updating) this.abortAppend();
    }

    remove(_start: number, _end: number): void {
      if (!this.parent || this.updating) throw invalidState();
      this.updating = true;
      this.removing = true;
      tasks.queue(() => this.fire('updatestart'));
      tasks.queue(() => {
        this.updating = false;
        this.removing = false;
        tasks.queue(() => this.fire('update'));
        tasks.queue(() => this.fire('updateend'));
      });
    }

    changeType(type: string): void {
      if (!this.parent || this.updating) throw invalidState();
      this.type = type;
    }
  }

  class MediaSource extends EventTarget {
    readyState: 'open' | 'closed' = 'open';
    sourceBuffers: SourceBuffer[] = [];

    addSourceBuffer(type: string): SourceBuffer {
      if (this.readyState !== 'open') throw invalidState();
      const sb = new SourceBuffer(this, type);
      this.sourceBuffers.push(sb);
      return sb;
    }

    removeSourceBuffer(sb: SourceBuffer): void {
      const i = this.sourceBuffers.indexOf(sb);
      if (i < 0) throw new DOMException('Not a SourceBuffer of this MediaSource.', 'NotFoundError');
      if (sb.updating) sb.abortAppend();
      this.sourceBuffers.splice(i, 1);
      sb.parent = null;
    }

    detach(): void {
      this.readyState = 'closed';
      for (const sb of this.sourceBuffers) {
        if (sb.updating) sb.abortAppend();
        sb.parent = null;
      }
      this.sourceBuffers = [];
      tasks.queue(() => this.dispatchEvent(new Event('sourceclose')));
    }
  }

  // WebIDL operations are enumerable own properties of the prototype (class methods are not).
  for (const proto of [SourceBuffer.prototype, MediaSource.prototype]) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor') Object.defineProperty(proto, name, { enumerable: true });
    }
  }

  class HTMLMediaElement {
    #srcObject: unknown = null;
    get srcObject(): unknown {
      return this.#srcObject;
    }
    set srcObject(v: unknown) {
      this.#srcObject = v;
    }
  }
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { enumerable: true });

  class MediaSourceHandle {}

  let nextUrl = 1;
  const FakeURL = Object.assign(function URL() {}, {
    createObjectURL: (obj: unknown) => (obj instanceof MediaSource ? `blob:https://www.youtube.com/${nextUrl++}` : 'blob:other'),
  });
  Object.defineProperty(FakeURL, 'createObjectURL', { enumerable: true });

  const window = new EventTarget() as EventTarget & Record<PropertyKey, unknown>;
  window.MediaSourceHandle = MediaSourceHandle;
  window.postMessage = (data: unknown, _origin: string, transfer: unknown[] = []) => {
    tasks.queue(() => {
      const event = new Event('message');
      Object.assign(event, { data, source: window, ports: transfer });
      window.dispatchEvent(event);
    });
  };

  vi.stubGlobal('window', window);
  vi.stubGlobal('MediaSource', MediaSource);
  vi.stubGlobal('SourceBuffer', SourceBuffer);
  vi.stubGlobal('HTMLMediaElement', HTMLMediaElement);
  vi.stubGlobal('URL', FakeURL);

  return {
    tasks,
    window,
    MediaSource: MediaSource as unknown as typeof FakeMediaSourceBase,
    SourceBuffer: SourceBuffer as unknown as typeof FakeSourceBufferBase,
    HTMLMediaElement: HTMLMediaElement as unknown as typeof FakeMediaElementBase,
    MediaSourceHandle,
    connect() {
      const port = new FakePort();
      (window.postMessage as (d: unknown, o: string, t: unknown[]) => void)({ [HOOK_HANDSHAKE]: true }, '*', [port]);
      tasks.run();
      return port;
    },
  };
}

/** `size` bytes starting with the WebM (EBML) magic, which the hook treats as an init segment. */
export function initSegment(size = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  b.set([0x1a, 0x45, 0xdf, 0xa3]);
  return b;
}

/** `size` bytes of a media segment (WebM Cluster id), filled with `fill`. */
export function mediaSegment(size: number, fill = 1): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size).fill(fill);
  b.set([0x1f, 0x43, 0xb6, 0x75]);
  return b;
}
