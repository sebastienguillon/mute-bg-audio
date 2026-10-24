// MAIN-world hook: observes what YouTube's player appends to its audio SourceBuffers so the
// look-ahead model can process audio before it is played. It never changes what the page does:
// every wrapped method calls the original with the original arguments, and the wrappers look like
// the natives to page code (same property flags, name and length, no prototype).
//
// The ISOLATED-world controller connects with a MessagePort (window.postMessage handshake). Until
// then, and between connections, the hook keeps each audio SourceBuffer's latest init segment and
// a bounded window of recent media appends, and replays them to a new connection.
import { HOOK_HANDSHAKE, type HookMessage } from '@/lib/protocol';

/** Bytes of recent media appends kept per SourceBuffer for replay (~4 min of 128 kbit/s Opus). */
const REPLAY_BYTES_PER_SB = 4 * 1024 * 1024;
/** Upper bound for everything the hook keeps. */
const REPLAY_BYTES_TOTAL = 24 * 1024 * 1024;
/** Guards against a second install in the same window (the hook must wrap the natives only once). */
const INSTALLED = Symbol.for('mse-observer');

type AppendMessage = Extract<HookMessage, { type: 'sb-append' }>;

/**
 * An appendBuffer() or remove() that has started and whose 'updateend' has not been dispatched
 * yet. Each operation ends with exactly one 'updateend', in order, preceded by 'abort' or
 * 'error' if it failed; so the oldest pending operation is the one the next event belongs to,
 * even when the page starts a new operation before the events of the previous one arrive (e.g.
 * abort() followed by appendBuffer() in the same task).
 */
interface Operation {
  /** The append's message (null for remove(), non-audio buffers and appends already settled). */
  append: AppendMessage | null;
  failed: boolean;
}

interface SbState {
  id: number;
  msId: number;
  mime: string;
  audio: boolean;
  /** False once the SourceBuffer was removed or its MediaSource closed. */
  live: boolean;
  ops: Operation[];
  init: AppendMessage | null;
  recent: AppendMessage[];
  recentBytes: number;
}

export default defineContentScript({
  matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    const w = window as unknown as Record<symbol, unknown>;
    if (typeof MediaSource === 'undefined' || typeof SourceBuffer === 'undefined' || w[INSTALLED]) return;
    Object.defineProperty(window, INSTALLED, { value: true });

    let nextId = 1;
    const msIds = new WeakMap<MediaSource, number>();
    const msUrls = new Map<number, string>();
    const sbStates = new WeakMap<SourceBuffer, SbState>();
    /** Audio SourceBuffers whose data is kept for replay. */
    const audioSbs = new Map<number, SbState>();
    let port: MessagePort | null = null;
    let totalBytes = 0;
    /** The page attached a MediaSourceHandle (MSE in a worker); replayed to every connection. */
    let workerMse = false;

    const send = (msg: HookMessage, transfer: Transferable[] = []) => {
      if (!port) return;
      try {
        port.postMessage(msg, transfer);
      } catch {
        port = null;
      }
    };

    /** Forgets the replay data of an audio SourceBuffer. */
    const forget = (st: SbState) => {
      totalBytes -= st.recentBytes + (st.init?.data.byteLength ?? 0);
      st.init = null;
      st.recent = [];
      st.recentBytes = 0;
      audioSbs.delete(st.id);
    };

    /** The SourceBuffer is gone (removed, or its MediaSource closed): tell the receiver and drop it. */
    const retire = (st: SbState) => {
      if (!st.live) return;
      st.live = false;
      st.ops = [];
      if (st.audio) {
        forget(st);
        send({ type: 'sb-gone', msId: st.msId, sbId: st.id });
      }
    };

    const msIdOf = (ms: MediaSource) => {
      let id = msIds.get(ms);
      if (id === undefined) {
        id = nextId++;
        msIds.set(ms, id);
        const msId = id;
        // Detaching a MediaSource (new video, ad, SPA navigation) empties its sourceBuffers
        // without calling removeSourceBuffer.
        ms.addEventListener('sourceclose', () => {
          for (const st of [...audioSbs.values()]) if (st.msId === msId) retire(st);
          msUrls.delete(msId);
        });
      }
      return id;
    };

    const isInitSegment = (b: Uint8Array) =>
      (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) || // EBML
      (b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70); // 'ftyp'

    const remember = (st: SbState, msg: AppendMessage) => {
      const bytes = new Uint8Array(msg.data);
      if (isInitSegment(bytes)) {
        totalBytes -= st.recentBytes + (st.init?.data.byteLength ?? 0);
        st.init = { ...msg, data: msg.data.slice(0) };
        st.recent = [];
        st.recentBytes = 0;
        totalBytes += msg.data.byteLength;
        return;
      }
      st.recent.push({ ...msg, data: msg.data.slice(0) });
      st.recentBytes += msg.data.byteLength;
      totalBytes += msg.data.byteLength;
      while (st.recent.length > 1 && (st.recentBytes > REPLAY_BYTES_PER_SB || totalBytes > REPLAY_BYTES_TOTAL)) {
        const old = st.recent.shift()!;
        st.recentBytes -= old.data.byteLength;
        totalBytes -= old.data.byteLength;
      }
    };

    /** Reports a finished append (the data is transferred to the receiver). */
    const settle = (st: SbState, msg: AppendMessage, ok: boolean) => {
      if (!st.live || !st.audio) return;
      msg.ok = ok;
      if (ok) remember(st, msg);
      send(msg, [msg.data]);
    };

    /** Persistent listeners, so every event is matched to the operation it belongs to. */
    const track = (sb: SourceBuffer, st: SbState) => {
      const onFail = () => {
        const op = st.ops[0];
        if (op) op.failed = true;
      };
      sb.addEventListener('abort', onFail);
      sb.addEventListener('error', onFail);
      sb.addEventListener('updateend', () => {
        const op = st.ops.shift();
        if (op?.append) settle(st, op.append, !op.failed);
      });
    };

    const snapshot = (sb: SourceBuffer, st: SbState, data: BufferSource): AppendMessage | null => {
      if (!st.audio || !st.live) return null;
      try {
        const view = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data as ArrayBuffer);
        return {
          type: 'sb-append',
          msId: st.msId,
          sbId: st.id,
          data: view.slice().buffer,
          timestampOffset: sb.timestampOffset,
          appendWindowStart: sb.appendWindowStart,
          appendWindowEnd: sb.appendWindowEnd,
          ok: true,
        };
      } catch {
        return null;
      }
    };

    // ── MediaSource / SourceBuffer wrappers ──
    const MSP = MediaSource.prototype;
    const SBP = SourceBuffer.prototype;
    const orig = {
      addSourceBuffer: MSP.addSourceBuffer,
      removeSourceBuffer: MSP.removeSourceBuffer,
      appendBuffer: SBP.appendBuffer,
      abort: SBP.abort,
      remove: SBP.remove,
      changeType: SBP.changeType as SourceBuffer['changeType'] | undefined,
      createObjectURL: URL.createObjectURL,
    };

    /**
     * Replaces a native method, keeping its property flags, name and length. The wrappers are
     * method definitions, so like the natives they have no prototype and are not constructors.
     */
    const wrap = (obj: object, name: string, fn: Function) => {
      const desc = Object.getOwnPropertyDescriptor(obj, name);
      if (!desc || typeof desc.value !== 'function') return;
      const native = desc.value as Function;
      Object.defineProperty(fn, 'name', { value: native.name, configurable: true });
      Object.defineProperty(fn, 'length', { value: native.length, configurable: true });
      Object.defineProperty(obj, name, { ...desc, value: fn });
    };

    const audioMime = (type: string) => /^audio\//i.test(type);

    wrap(MSP, 'addSourceBuffer', {
      addSourceBuffer(this: MediaSource, type: string) {
        const sb = orig.addSourceBuffer.call(this, type);
        try {
          const msId = msIdOf(this);
          const audio = audioMime(type);
          const st: SbState = { id: nextId++, msId, mime: type, audio, live: true, ops: [], init: null, recent: [], recentBytes: 0 };
          sbStates.set(sb, st);
          track(sb, st);
          if (audio) audioSbs.set(st.id, st);
          send({ type: 'sb-add', msId, sbId: st.id, mime: type });
        } catch {}
        return sb;
      },
    }.addSourceBuffer);

    wrap(MSP, 'removeSourceBuffer', {
      removeSourceBuffer(this: MediaSource, sb: SourceBuffer) {
        const r = orig.removeSourceBuffer.call(this, sb);
        const st = sbStates.get(sb);
        if (st) retire(st);
        return r;
      },
    }.removeSourceBuffer);

    wrap(SBP, 'appendBuffer', {
      appendBuffer(this: SourceBuffer, data: BufferSource) {
        const st = sbStates.get(this);
        if (!st) return orig.appendBuffer.call(this, data);
        const msg = snapshot(this, st, data);
        // A throw (e.g. QuotaExceededError) means no operation started, so none is recorded.
        const r = orig.appendBuffer.call(this, data);
        if (st.live) st.ops.push({ append: msg, failed: false });
        return r;
      },
    }.appendBuffer);

    wrap(SBP, 'abort', {
      abort(this: SourceBuffer) {
        const st = sbStates.get(this);
        const updating = this.updating;
        const r = orig.abort.call(this);
        if (st?.live) {
          // The aborted operation is the latest one. Report it as failed now; it stays in the queue
          // (settled) to absorb its own queued 'abort' and 'updateend' events.
          const op = updating ? st.ops[st.ops.length - 1] : undefined;
          if (op?.append) {
            settle(st, op.append, false);
            op.append = null;
          }
          if (st.audio) send({ type: 'sb-abort', msId: st.msId, sbId: st.id });
        }
        return r;
      },
    }.abort);

    wrap(SBP, 'remove', {
      remove(this: SourceBuffer, start: number, end: number) {
        const r = orig.remove.call(this, start, end);
        const st = sbStates.get(this);
        if (st?.live) {
          st.ops.push({ append: null, failed: false });
          if (st.audio) send({ type: 'sb-remove', msId: st.msId, sbId: st.id, start, end });
        }
        return r;
      },
    }.remove);

    const nativeChangeType = orig.changeType;
    if (nativeChangeType) {
      wrap(SBP, 'changeType', {
        changeType(this: SourceBuffer, type: string) {
          const r = nativeChangeType.call(this, type);
          const st = sbStates.get(this);
          if (st?.live) {
            const audio = audioMime(type);
            if (audio) {
              // The next init segment starts over: what was kept belongs to the old type.
              if (st.audio) forget(st);
              st.mime = type;
              st.audio = true;
              audioSbs.set(st.id, st);
              send({ type: 'sb-change-type', msId: st.msId, sbId: st.id, mime: type });
            } else if (st.audio) {
              forget(st);
              st.audio = false;
              send({ type: 'sb-gone', msId: st.msId, sbId: st.id });
            }
          }
          return r;
        },
      }.changeType);
    }

    wrap(URL, 'createObjectURL', {
      createObjectURL(obj: Blob | MediaSource) {
        const url = orig.createObjectURL.call(URL, obj as Blob);
        try {
          if (obj instanceof MediaSource) {
            const msId = msIdOf(obj);
            msUrls.set(msId, url);
            send({ type: 'ms-url', msId, url });
          }
        } catch {}
        return url;
      },
    }.createObjectURL);

    // MSE in a dedicated worker bypasses the main-thread prototypes: report it.
    const srcObjectDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    const Handle = (window as unknown as { MediaSourceHandle?: abstract new () => object }).MediaSourceHandle;
    const nativeSetter = srcObjectDesc?.set;
    if (srcObjectDesc && nativeSetter && Handle) {
      // An accessor definition, so the setter is named 'set srcObject' like the native one.
      const setter = Object.getOwnPropertyDescriptor(
        {
          set srcObject(v: unknown) {
            if (v instanceof Handle && !workerMse) {
              workerMse = true;
              send({ type: 'ms-worker' });
            }
            nativeSetter.call(this, v);
          },
        },
        'srcObject',
      )!.set!;
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { ...srcObjectDesc, set: setter });
    }

    // ── Handshake with the ISOLATED world ──
    const replay = () => {
      if (workerMse) send({ type: 'ms-worker' });
      for (const [msId, url] of msUrls) send({ type: 'ms-url', msId, url });
      for (const st of audioSbs.values()) {
        send({ type: 'sb-add', msId: st.msId, sbId: st.id, mime: st.mime });
        if (st.init) send({ ...st.init, data: st.init.data.slice(0) });
        for (const m of st.recent) send({ ...m, data: m.data.slice(0) });
      }
    };
    window.addEventListener(
      'message',
      (e) => {
        if (e.source !== window || !e.data || e.data[HOOK_HANDSHAKE] !== true || !e.ports[0]) return;
        e.stopImmediatePropagation();
        port?.close();
        port = e.ports[0];
        replay();
      },
      true,
    );
  },
});
