// The background service worker's message handling, run against WXT's fake browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { RuntimeMessage, TabStatus } from '../../src/lib/protocol';
import { contentSender, pageSender, startBackground, type BackgroundHarness } from './helpers/ui-background-harness';

const TAB = 5;
const popup = pageSender('/popup.html');
const offscreen = pageSender('/offscreen.html');
const engine = (tabId = TAB) => pageSender('/engine.html', tabId);
const TOKEN = '6f1c2a0e-9b7d-4c3e-8a51-2d4f6b8c0e13';

let h: BackgroundHarness;

beforeEach(async () => {
  h = await startBackground();
  h.documents.set(TAB, new Map([[0, 'doc-top']]));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const status = (tabId = TAB) => h.send({ type: 'get-tab-status', tabId }, popup) as Promise<TabStatus | null>;
const captureState = (tabId = TAB) => h.send({ type: 'get-capture-state' }, contentSender(h, tabId));
const captureBroadcasts = () =>
  h.tabMessages.filter((m) => m.message.type === 'capture-state').map((m) => [m.tabId, (m.message as { active: boolean }).active, m.options]);

function report(s: TabStatus, frameId = 0, tabId = TAB): Promise<unknown> {
  return h.send({ type: 'tab-status', status: s }, contentSender(h, tabId, frameId));
}

describe('tab capture and in-page processing', () => {
  it('tells every frame of the tab when capture starts and stops, and answers get-capture-state', async () => {
    expect(await captureState()).toEqual({ active: false });
    const started = await h.send({ type: 'start-tab-capture', tabId: TAB }, popup);
    expect(started).toMatchObject({ status: { mode: 'tabcapture' } });
    // No frameId: tabs.sendMessage reaches all frames of the tab.
    expect(captureBroadcasts()).toEqual([[TAB, true, undefined]]);
    expect(await captureState()).toEqual({ active: true });

    await h.send({ type: 'stop-tab-capture', tabId: TAB }, popup);
    expect(captureBroadcasts()).toEqual([
      [TAB, true, undefined],
      [TAB, false, undefined],
    ]);
    expect(await captureState()).toEqual({ active: false });
  });

  it('tells the frames when the capture ends inside the capture document', async () => {
    await h.send({ type: 'start-tab-capture', tabId: TAB }, popup);
    const ended: TabStatus = { mode: 'off', site: 'tabcapture', enabled: false, detail: 'Tab capture ended.' };
    await h.send({ type: 'offscreen-status', tabId: TAB, status: ended }, offscreen);
    expect(captureBroadcasts().at(-1)).toEqual([TAB, false, undefined]);
    expect(await captureState()).toEqual({ active: false });
  });

  it('does not announce a capture that failed to start', async () => {
    h.captureStart = { mode: 'off', site: 'tabcapture', enabled: false, detail: 'getUserMedia failed' };
    const result = await h.send({ type: 'start-tab-capture', tabId: TAB }, popup);
    expect(result).toMatchObject({ error: 'Tab capture failed: getUserMedia failed' });
    expect(captureBroadcasts().some(([, active]) => active)).toBe(false);
    expect(await captureState()).toEqual({ active: false });
  });

  it('answers from the persisted state after a service-worker restart', async () => {
    await h.send({ type: 'start-tab-capture', tabId: TAB }, popup);
    await h.restart();
    expect(await captureState()).toEqual({ active: true });

    // The capture document went away while the worker was stopped: the frames resume.
    h.offscreenOpen = false;
    h.tabMessages.length = 0;
    await h.restart();
    expect(await captureState()).toEqual({ active: false });
    expect(captureBroadcasts()).toEqual([[TAB, false, undefined]]);
  });

  it('only answers get-capture-state for content scripts of a tab', async () => {
    await h.send({ type: 'start-tab-capture', tabId: TAB }, popup);
    expect(await h.send({ type: 'get-capture-state' }, popup)).toBeUndefined();
    expect(await h.send({ type: 'get-capture-state' }, { id: fakeBrowser.runtime.id, url: 'https://x.test/' })).toBeUndefined();
  });
});

describe('engine tokens', () => {
  const issue = (token: unknown, tabId = TAB) => h.send({ type: 'engine-token', token } as RuntimeMessage, contentSender(h, tabId));
  const verify = (token: unknown, sender = engine()) => h.send({ type: 'engine-verify', token } as RuntimeMessage, sender);

  it('accepts a token once, from an engine iframe in the tab it was issued for', async () => {
    expect(await issue(TOKEN)).toEqual({ ok: true });
    expect(await verify(TOKEN)).toEqual({ ok: true });
    expect(await verify(TOKEN)).toEqual({ ok: false });
  });

  it('refuses tokens of another tab, unknown or malformed ones, and other senders', async () => {
    h.documents.set(6, new Map([[0, 'doc-6']]));
    await issue(TOKEN, 6);
    expect(await verify(TOKEN)).toEqual({ ok: false });
    // ...and the token is spent.
    expect(await verify(TOKEN, engine(6))).toEqual({ ok: false });

    expect(await verify('never-issued-token-0000')).toEqual({ ok: false });
    expect(await issue('short')).toEqual({ ok: false });
    expect(await issue(42)).toEqual({ ok: false });

    await issue(TOKEN);
    // Only engine.html may spend a token; content scripts cannot even ask.
    expect(await verify(TOKEN, pageSender('/popup.html', TAB))).toEqual({ ok: false });
    expect(await verify(TOKEN, contentSender(h, TAB))).toBeUndefined();
    expect(await verify(TOKEN)).toEqual({ ok: true });
  });

  it('expires tokens after 60 s', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await issue(TOKEN);
    clock.mockReturnValue(now + 60_001);
    expect(await verify(TOKEN)).toEqual({ ok: false });
  });

  it('keeps tokens across a service-worker restart, and drops expired ones from storage', async () => {
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await issue(TOKEN);
    await issue('0b8e2f44-old-token-a91c');
    clock.mockReturnValue(now + 30_000);
    await issue('7d3a9c10-new-token-e5b2');
    clock.mockReturnValue(now + 61_000);
    await h.restart();
    expect(await verify('7d3a9c10-new-token-e5b2')).toEqual({ ok: true });
    await h.settle();
    expect(Object.keys(await fakeBrowser.storage.session.get(null)).filter((k) => k.startsWith('engine-token:'))).toEqual([]);
    clock.mockReturnValue(now);
    expect(await verify(TOKEN)).toEqual({ ok: false });
  });

  it('forgets the tokens of a closed tab', async () => {
    await issue(TOKEN);
    await fakeBrowser.tabs.onRemoved.trigger(TAB, { windowId: 1, isWindowClosing: false });
    await h.settle();
    expect(await verify(TOKEN)).toEqual({ ok: false });
  });
});

describe('frame statuses after a load completes', () => {
  const waiting: TabStatus = { mode: 'waiting', site: 'youtube', enabled: true };
  const complete = async () => {
    await fakeBrowser.tabs.onUpdated.trigger(TAB, { status: 'complete' }, { id: TAB } as never);
    await h.settle();
  };

  it('keeps the status of a YouTube embed on a page whose top frame runs no script', async () => {
    h.documents.set(TAB, new Map([[7, 'doc-embed']]));
    await report(waiting, 7);
    await complete();
    expect(await status()).toEqual(waiting);
    // Only the known frame was asked, in its own document.
    expect(h.tabMessages.map((m) => m.options)).toEqual([{ frameId: 7, documentId: 'doc-embed' }]);
  });

  it('drops only the frames whose document no longer runs a script', async () => {
    h.documents.get(TAB)!.set(7, 'doc-embed');
    const top: TabStatus = { mode: 'realtime', site: 'generic', enabled: true };
    await report(top, 0);
    await report(waiting, 7);
    h.documents.get(TAB)!.delete(7); // The embed was removed.
    await complete();
    expect(await status()).toEqual(top);

    // The top frame navigated to a page without our scripts.
    h.documents.get(TAB)!.delete(0);
    await complete();
    expect(await status()).toBeNull();
  });

  it("keeps a subframe's status when the top frame reports for the first time", async () => {
    // A YouTube embed (document_start) reports before the page's generic script (document_idle).
    h.documents.get(TAB)!.set(7, 'doc-embed');
    const embed: TabStatus = { mode: 'lookahead', site: 'youtube', enabled: true, latencyMs: 0 };
    await report(embed, 7);
    await report({ mode: 'waiting', site: 'generic', enabled: true, detail: 'Waiting for the video to play.' }, 0);
    expect(await status()).toEqual(embed);
    // The same top document reporting again keeps it too.
    await report({ mode: 'waiting', site: 'generic', enabled: true }, 0);
    expect(await status()).toEqual(embed);
  });

  it('drops the subframe statuses of the previous top document when a new one reports', async () => {
    h.documents.get(TAB)!.set(7, 'doc-embed');
    await report(waiting, 0);
    await report({ mode: 'realtime', site: 'youtube', enabled: true }, 7);
    // Cross-document navigation: the new top document reports before the load completes.
    h.documents.set(TAB, new Map([[0, 'doc-next']]));
    const next: TabStatus = { mode: 'waiting', site: 'generic', enabled: true };
    await report(next, 0);
    expect(await status()).toEqual(next);
  });

  it('drops the subframes of an old page whose top frame never reported, once the next page loads', async () => {
    h.documents.set(TAB, new Map([[7, 'doc-embed']]));
    await report({ mode: 'realtime', site: 'youtube', enabled: true }, 7);
    // The top frame navigates to a page whose script reports before the load completes; the embed is gone.
    h.documents.set(TAB, new Map([[0, 'doc-next']]));
    const next: TabStatus = { mode: 'waiting', site: 'generic', enabled: true };
    await report(next, 0);
    await complete();
    expect(await status()).toEqual(next);
  });

  it('drops the status of a document that was replaced, until the new one reports', async () => {
    await report(waiting);
    // Cross-document navigation within the frame: the new document's script has not reported yet.
    h.documents.get(TAB)!.set(0, 'doc-next');
    await complete();
    expect(await status()).toBeNull();
    await report({ ...waiting, mode: 'realtime' });
    expect(await status()).toMatchObject({ mode: 'realtime' });
  });
});

describe('status persistence', () => {
  /** storage.session.set calls that wrote a tab record. */
  const tabWrites = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((call) => Object.keys(call[0] as object).some((k) => k.startsWith('tab:'))).length;
  const lookahead = (aheadSeconds: number, rtf = 0.2): TabStatus => ({
    mode: 'lookahead',
    site: 'youtube',
    enabled: true,
    latencyMs: 60,
    lookahead: { state: 'ready', backend: 'webgpu', aheadSeconds, rtf },
  });

  it('skips storage writes for reports that only move the look-ahead progress', async () => {
    const set = vi.spyOn(fakeBrowser.storage.session, 'set');
    await report(lookahead(10.25, 0.21));
    await report(lookahead(10.5, 0.24));
    await report(lookahead(11.75, 0.19));
    // The popup still gets the latest numbers.
    expect((await status())?.lookahead).toMatchObject({ aheadSeconds: 11.75, rtf: 0.19 });
    expect(tabWrites(set)).toBe(1);

    await report({ ...lookahead(12), lookahead: { state: 'ready', backend: 'wasm', aheadSeconds: 12 } });
    await report({ mode: 'realtime', site: 'youtube', enabled: true, latencyMs: 60 });
    expect(tabWrites(set)).toBe(3);
  });

  it('restores the last material status after a restart', async () => {
    await report(lookahead(10));
    await report(lookahead(20));
    await h.restart();
    expect(await status()).toMatchObject({ mode: 'lookahead', lookahead: { state: 'ready', aheadSeconds: 10 } });
  });
});
