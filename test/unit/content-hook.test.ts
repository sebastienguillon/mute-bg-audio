// The MAIN-world MediaSource hook, run against a spec-modelled fake MSE (helpers/content-fake-mse).
import { afterEach, describe, expect, it, vi } from 'vitest';
import hook from '../../src/entrypoints/youtube-hook.content';
import { installFakeMse, initSegment, mediaSegment, type FakeMseEnv } from './helpers/content-fake-mse';

const AUDIO = 'audio/webm; codecs="opus"';
const VIDEO = 'video/webm; codecs="vp9"';
const MiB = 1024 * 1024;

/** The MAIN-world entrypoint gets no WXT context. */
const runHook = () => (hook.main as () => void)();

function setup(): FakeMseEnv {
  const env = installFakeMse();
  runHook();
  return env;
}

/** A MediaSource with an object URL and one audio SourceBuffer that got its init segment. */
function audioSource(e: FakeMseEnv) {
  const ms = new e.MediaSource();
  const url = URL.createObjectURL(ms as unknown as MediaSource);
  const sb = ms.addSourceBuffer(AUDIO);
  sb.appendBuffer(initSegment());
  e.tasks.run();
  return { ms, url, sb };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('youtube-hook', () => {
  it('attributes abort() followed by appendBuffer() in the same task to the right appends', () => {
    const e = setup();
    const port = e.connect();
    const { sb } = audioSource(e);
    sb.appendBuffer(mediaSegment(1000));
    // A seek: the player aborts the running append and appends the new data right away.
    sb.abort();
    sb.appendBuffer(mediaSegment(2000, 2));
    e.tasks.run();
    expect(sb.buffered).toEqual([64, 2000]);
    const tail = port.messages.slice(-3);
    expect(tail.map((m) => m.type)).toEqual(['sb-append', 'sb-abort', 'sb-append']);
    expect(tail[0]).toMatchObject({ ok: false });
    expect(tail[2]).toMatchObject({ ok: true });
    expect((tail[2] as { data: ArrayBuffer }).data.byteLength).toBe(2000);
    // Only the successful append is kept for a later connection.
    const replay = e.connect().appends();
    expect(replay.map((m) => m.data.byteLength)).toEqual([64, 2000]);
  });

  it("keeps attribution when the page starts the next append from its 'update' listener", () => {
    const e = setup();
    const port = e.connect();
    const { sb } = audioSource(e);
    const next = [mediaSegment(300), mediaSegment(400)];
    // 'update' fires before 'updateend', so the next append runs before the previous one's updateend.
    sb.addEventListener('update', () => {
      const data = next.shift();
      if (data) sb.appendBuffer(data);
    });
    sb.appendBuffer(mediaSegment(200));
    e.tasks.run();
    expect(sb.buffered).toEqual([64, 200, 300, 400]);
    expect(port.appends().map((m) => [m.data.byteLength, m.ok])).toEqual([
      [64, true],
      [200, true],
      [300, true],
      [400, true],
    ]);
  });

  it('reports an append that fails to parse as not ok and does not keep it', () => {
    const e = setup();
    const port = e.connect();
    const { sb } = audioSource(e);
    sb.failNext = true;
    sb.appendBuffer(mediaSegment(500));
    e.tasks.run();
    sb.appendBuffer(mediaSegment(600));
    e.tasks.run();
    expect(port.appends().map((m) => [m.data.byteLength, m.ok])).toEqual([
      [64, true],
      [500, false],
      [600, true],
    ]);
    expect(e.connect().appends().map((m) => m.data.byteLength)).toEqual([64, 600]);
  });

  it('records nothing for an appendBuffer() that throws, and rethrows the native error', () => {
    const e = setup();
    const port = e.connect();
    const { sb } = audioSource(e);
    sb.quotaNext = true;
    expect(() => sb.appendBuffer(mediaSegment(700))).toThrow(expect.objectContaining({ name: 'QuotaExceededError' }));
    sb.appendBuffer(mediaSegment(800));
    e.tasks.run();
    expect(port.appends().map((m) => [m.data.byteLength, m.ok])).toEqual([
      [64, true],
      [800, true],
    ]);
  });

  it('matches events to appends after a remove()', () => {
    const e = setup();
    const port = e.connect();
    const { sb } = audioSource(e);
    sb.remove(0, 10);
    e.tasks.run();
    sb.appendBuffer(mediaSegment(900));
    e.tasks.run();
    expect(port.messages.slice(-2)).toMatchObject([{ type: 'sb-remove', start: 0, end: 10 }, { type: 'sb-append', ok: true }]);
  });

  it('reports every audio SourceBuffer of a closed MediaSource as gone and forgets it', () => {
    const e = setup();
    const port = e.connect();
    const first = audioSource(e);
    const video = first.ms.addSourceBuffer(VIDEO);
    const second = audioSource(e);
    // An append still running when the element moves on to another MediaSource.
    first.sb.appendBuffer(mediaSegment(1000));
    first.ms.detach();
    e.tasks.run();
    const gone = port.messages.filter((m) => m.type === 'sb-gone');
    expect(gone).toHaveLength(1);
    const added = port.messages.find((m) => m.type === 'sb-add' && m.mime === AUDIO);
    expect(added?.type).toBe('sb-add');
    if (added?.type !== 'sb-add') return;
    expect(gone[0]).toEqual({ type: 'sb-gone', msId: added.msId, sbId: added.sbId });
    // The aborted append is not reported after the SourceBuffer is gone.
    expect(port.messages.at(-1)).toEqual(gone[0]);
    expect(video.buffered).toEqual([]);
    // A new connection only hears about the open MediaSource.
    const replay = e.connect().messages;
    const urls = replay.filter((m) => m.type === 'ms-url');
    expect(urls.map((m) => m.url)).toEqual([second.url]);
    const adds = replay.filter((m) => m.type === 'sb-add');
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ msId: urls[0]!.msId, mime: AUDIO });
  });

  it('reports removeSourceBuffer() as gone', () => {
    const e = setup();
    const port = e.connect();
    const { ms, sb } = audioSource(e);
    ms.removeSourceBuffer(sb);
    e.tasks.run();
    expect(port.messages.at(-1)).toMatchObject({ type: 'sb-gone' });
    expect(e.connect().messages.filter((m) => m.type === 'sb-add')).toHaveLength(0);
  });

  it('starts the replay over at changeType() without leaking the replay budget', () => {
    const e = setup();
    const port = e.connect();
    const { sb } = audioSource(e);
    sb.appendBuffer(mediaSegment(1000));
    e.tasks.run();
    // Large init segments and type changes: each changeType must release what it drops
    // (24 MiB is the hook's total replay budget).
    for (let i = 0; i < 8; i++) {
      sb.appendBuffer(initSegment(3.5 * MiB));
      e.tasks.run();
      sb.changeType(i % 2 ? AUDIO : 'audio/mp4; codecs="mp4a.40.2"');
    }
    expect(port.messages.filter((m) => m.type === 'sb-change-type')).toHaveLength(8);
    sb.appendBuffer(initSegment(100));
    e.tasks.run();
    for (let i = 0; i < 3; i++) {
      sb.appendBuffer(mediaSegment(MiB));
      e.tasks.run();
    }
    expect(e.connect().appends().map((m) => m.data.byteLength)).toEqual([100, MiB, MiB, MiB]);
  });

  it('stops forwarding a SourceBuffer whose type changes to video', () => {
    const e = setup();
    const port = e.connect();
    const { sb } = audioSource(e);
    sb.changeType(VIDEO);
    sb.appendBuffer(mediaSegment(100));
    e.tasks.run();
    expect(port.messages.at(-1)).toMatchObject({ type: 'sb-gone' });
    expect(port.appends()).toHaveLength(1);
  });

  it('replays the worker-MSE fact, the object URLs and the kept appends in order', () => {
    const e = setup();
    const el = new e.HTMLMediaElement();
    const handle = new e.MediaSourceHandle();
    el.srcObject = handle;
    expect(el.srcObject).toBe(handle);
    const { url } = audioSource(e);
    const sb2 = new e.MediaSource().addSourceBuffer(VIDEO);
    sb2.appendBuffer(mediaSegment(50));
    e.tasks.run();
    for (const port of [e.connect(), e.connect()]) {
      expect(port.messages.map((m) => m.type)).toEqual(['ms-worker', 'ms-url', 'sb-add', 'sb-append']);
      expect(port.messages[1]).toMatchObject({ url });
      expect(port.appends()[0]!.data.byteLength).toBe(64);
    }
  });

  it('closes the previous port when another connection arrives', () => {
    const e = setup();
    const first = e.connect();
    e.connect();
    expect(first.closed).toBe(true);
  });

  it('installs wrappers that look like the native methods, once', () => {
    const before = installFakeMse();
    const natives = {
      appendBuffer: Object.getOwnPropertyDescriptor(before.SourceBuffer.prototype, 'appendBuffer')!,
      addSourceBuffer: Object.getOwnPropertyDescriptor(before.MediaSource.prototype, 'addSourceBuffer')!,
    };
    const windowKeys = Reflect.ownKeys(before.window).filter((k) => typeof k === 'string');
    runHook();
    runHook();
    const targets: [object, string][] = [
      [before.SourceBuffer.prototype, 'appendBuffer'],
      [before.SourceBuffer.prototype, 'abort'],
      [before.SourceBuffer.prototype, 'remove'],
      [before.SourceBuffer.prototype, 'changeType'],
      [before.MediaSource.prototype, 'addSourceBuffer'],
      [before.MediaSource.prototype, 'removeSourceBuffer'],
      [URL, 'createObjectURL'],
    ];
    for (const [obj, name] of targets) {
      const d = Object.getOwnPropertyDescriptor(obj, name)!;
      expect(d, name).toMatchObject({ enumerable: true, writable: true, configurable: true });
      const fn = d.value as Function;
      expect(fn.name).toBe(name);
      expect(Object.hasOwn(fn, 'prototype'), name).toBe(false);
      expect(() => Reflect.construct(fn, []), name).toThrow(TypeError);
    }
    expect((Object.getOwnPropertyDescriptor(before.SourceBuffer.prototype, 'appendBuffer')!.value as Function).length).toBe(
      (natives.appendBuffer.value as Function).length,
    );
    expect(Object.getOwnPropertyDescriptor(before.SourceBuffer.prototype, 'appendBuffer')!.value).not.toBe(natives.appendBuffer.value);
    const srcObject = Object.getOwnPropertyDescriptor(before.HTMLMediaElement.prototype, 'srcObject')!;
    expect(srcObject.set!.name).toBe('set srcObject');
    expect(srcObject.enumerable).toBe(true);
    // No string-named marker on window (page scripts enumerate those).
    expect(Reflect.ownKeys(before.window).filter((k) => typeof k === 'string')).toEqual(windowKeys);
    // Wrapped once: one report per append.
    const port = before.connect();
    audioSource(before);
    expect(port.appends()).toHaveLength(1);
  });
});
