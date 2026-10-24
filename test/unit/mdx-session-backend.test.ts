import { describe, expect, it } from 'vitest';
import { BackendTooSlowError, BackendUnavailableError, TOO_SLOW_REASON } from '../../src/lib/mdx/mdx';
import { SessionBackend, type ModelSession } from '../../src/lib/mdx/session-backend';

interface FakeSession extends ModelSession {
  id: number;
  released: boolean;
}

/** Sessions created by `create`, in order; `behave` decides what each run does. */
function sessions(behave: (session: FakeSession, run: number) => Promise<Float32Array> | Float32Array = (s) => new Float32Array([s.id])) {
  const created: FakeSession[] = [];
  let runs = 0;
  const create = async (): Promise<ModelSession> => {
    const session: FakeSession = {
      id: created.length + 1,
      released: false,
      run: async () => behave(session, ++runs),
      release: async () => {
        session.released = true;
      },
    };
    created.push(session);
    return session;
  };
  return { created, create };
}

const input = new Float32Array(4);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SessionBackend', () => {
  it('creates the session on the first run, reuses it, and re-creates it after release()', async () => {
    const { created, create } = sessions();
    const backend = new SessionBackend({ create, runTimeoutMs: 1000, createTimeoutMs: 1000 });
    expect(created).toHaveLength(0);
    expect([...(await backend.run(input))]).toEqual([1]);
    expect([...(await backend.run(input))]).toEqual([1]);
    expect(created).toHaveLength(1);
    backend.release();
    await tick();
    expect(created[0]!.released).toBe(true);
    expect([...(await backend.run(input))]).toEqual([2]);
  });

  it('drops and releases the session after a failed run, so the next run starts afresh', async () => {
    const { created, create } = sessions((s, run) => {
      if (run === 1) throw new Error('device lost');
      return new Float32Array([s.id]);
    });
    const backend = new SessionBackend({ create, runTimeoutMs: 1000, createTimeoutMs: 1000 });
    await expect(backend.run(input)).rejects.toThrow('device lost');
    await tick();
    expect(created[0]!.released).toBe(true);
    expect([...(await backend.run(input))]).toEqual([2]);
  });

  it('retries creating the session after a failed creation', async () => {
    let attempts = 0;
    const { create: inner } = sessions();
    const create = async () => {
      if (++attempts === 1) throw new BackendUnavailableError('No usable GPU');
      return inner();
    };
    const backend = new SessionBackend({ create, runTimeoutMs: 1000, createTimeoutMs: 1000 });
    await expect(backend.run(input)).rejects.toBeInstanceOf(BackendUnavailableError);
    await expect(backend.run(input)).resolves.toBeInstanceOf(Float32Array);
    expect(attempts).toBe(2);
  });

  it('fails a run that does not answer in time as too slow, and never releases the session while it runs', async () => {
    const { created, create } = sessions((s) => (s.id === 1 ? new Promise<Float32Array>(() => {}) : new Float32Array([s.id])));
    const backend = new SessionBackend({ create, runTimeoutMs: 50, createTimeoutMs: 1000 });
    const t0 = performance.now();
    const failed = backend.run(input);
    await expect(failed).rejects.toBeInstanceOf(BackendTooSlowError);
    await expect(failed).rejects.toThrow(TOO_SLOW_REASON);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    // The hung run never settles: its session is leaked, not freed under it; the next run uses a new one.
    expect([...(await backend.run(input))]).toEqual([2]);
    backend.release();
    await tick();
    expect(created.map((s) => s.released)).toEqual([false, true]);
  });

  it('releases a session whose run timed out once that run settles', async () => {
    const order: string[] = [];
    let answer: (() => void) | null = null;
    const { created, create } = sessions((s) => {
      order.push(`run ${s.id}`);
      if (s.id !== 1) return new Float32Array([s.id]);
      return new Promise<Float32Array>((resolve) => (answer = () => resolve(new Float32Array(1))));
    });
    const tracked = async () => {
      const session = await create();
      const release = session.release;
      session.release = () => {
        order.push(`release ${(session as FakeSession).id}`);
        return release();
      };
      return session;
    };
    const backend = new SessionBackend({ create: tracked, runTimeoutMs: 30, createTimeoutMs: 1000 });
    await expect(backend.run(input)).rejects.toBeInstanceOf(BackendTooSlowError);
    // Idle release and dispose do not free it either while the run executes.
    backend.release();
    await new Promise((r) => setTimeout(r, 50));
    expect(created[0]!.released).toBe(false);
    order.push('run 1 ends');
    (answer as (() => void) | null)?.();
    await tick();
    expect(created[0]!.released).toBe(true);
    expect(order).toEqual(['run 1', 'run 1 ends', 'release 1']);
  });

  it('defers release() until the running run settles, and fails a run waiting for a session released meanwhile', async () => {
    let answer: (() => void) | null = null;
    let finish: (() => void) | null = null;
    const { created, create } = sessions(() => new Promise<Float32Array>((resolve) => (answer = () => resolve(new Float32Array(1)))));
    const backend = new SessionBackend({ create, runTimeoutMs: 1000, createTimeoutMs: 1000 });
    const running = backend.run(input);
    await tick();
    backend.release();
    await tick();
    expect(created[0]!.released).toBe(false);
    (answer as (() => void) | null)?.();
    await expect(running).resolves.toBeInstanceOf(Float32Array);
    await tick();
    expect(created[0]!.released).toBe(true);

    // Released while the session is being created: the run does not use it, and it is freed.
    const slow = new SessionBackend({
      create: () => new Promise<ModelSession>((resolve) => (finish = () => resolve(create()))),
      runTimeoutMs: 1000,
      createTimeoutMs: 1000,
    });
    const waiting = slow.run(input);
    slow.release();
    (finish as (() => void) | null)?.();
    await expect(waiting).rejects.toThrow('The look-ahead model was released.');
    await tick();
    expect(created[1]!.released).toBe(true);
  });

  it('gives the first run of a session (shader compilation) a longer timeout', async () => {
    const { create } = sessions(() => new Promise<Float32Array>((resolve) => setTimeout(() => resolve(new Float32Array(1)), 60)));
    const backend = new SessionBackend({ create, runTimeoutMs: 30, firstRunTimeoutMs: 500, createTimeoutMs: 1000 });
    await expect(backend.run(input)).resolves.toBeInstanceOf(Float32Array);
    await expect(backend.run(input)).rejects.toBeInstanceOf(BackendTooSlowError);
  });

  it('fails a creation that does not finish in time, releases the session if it arrives later, and creates the next one after it', async () => {
    let finish: ((session: ModelSession) => void) | null = null;
    const late: FakeSession = { id: 1, released: false, run: async () => new Float32Array(1), release: async () => void (late.released = true) };
    let creating = 0;
    let overlapped = false;
    const { create: next } = sessions();
    let first = true;
    const backend = new SessionBackend({
      create: () => {
        overlapped ||= creating > 0;
        creating++;
        const done = (s: ModelSession) => {
          creating--;
          return s;
        };
        if (!first) return next().then(done);
        first = false;
        return new Promise<ModelSession>((resolve) => (finish = resolve)).then(done);
      },
      runTimeoutMs: 1000,
      createTimeoutMs: 30,
    });
    await expect(backend.run(input)).rejects.toThrow('Loading the look-ahead model timed out.');
    // The next creation waits for the late one (ONNX Runtime creates one WebGPU session at a time).
    const second = backend.run(input);
    await new Promise((r) => setTimeout(r, 10));
    expect(creating).toBe(1);
    (finish as ((session: ModelSession) => void) | null)?.(late);
    await expect(second).resolves.toBeInstanceOf(Float32Array);
    expect(late.released).toBe(true);
    expect(overlapped).toBe(false);
  });
});
