// Runs the real background service worker (src/entrypoints/background.ts) against WXT's in-memory
// fake browser, with the APIs it does not implement (tabs.sendMessage, offscreen, tabCapture,
// scripting, permissions) scripted here. Content scripts are modelled as documents per frame.
import { vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { Browser } from 'wxt/browser';
import type { RuntimeMessage, TabStatus } from '../../../src/lib/protocol';

export const EXTENSION_ID = fakeBrowser.runtime.id;
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

/** A message the background sent to a tab's content scripts. */
export interface TabMessage {
  tabId: number;
  message: RuntimeMessage;
  options?: { frameId?: number; documentId?: string };
}

export interface BackgroundHarness {
  /** Documents running a content script, per tab: frameId → documentId. */
  readonly documents: Map<number, Map<number, string>>;
  /** Messages sent with tabs.sendMessage, in order. */
  readonly tabMessages: TabMessage[];
  /** Status the capture document answers to 'offscreen-start'. */
  captureStart: TabStatus;
  /** Whether the offscreen (capture) document is open. */
  offscreenOpen: boolean;
  /** Delivers a runtime message to the background; resolves with its reply (undefined: none). */
  send(message: RuntimeMessage, sender: Browser.runtime.MessageSender): Promise<unknown>;
  /** Stops the worker (its listeners and memory go, storage.session stays) and starts a new one. */
  restart(): Promise<void>;
  /** Lets pending promise chains and zero-delay timers run. */
  settle(): Promise<void>;
}

/** Sender of a content script in `frameId` of `tabId` (its document must be in `documents`). */
export function contentSender(h: BackgroundHarness, tabId: number, frameId = 0): Browser.runtime.MessageSender {
  const documentId = h.documents.get(tabId)?.get(frameId);
  return { id: EXTENSION_ID, tab: { id: tabId } as Browser.tabs.Tab, frameId, documentId, url: 'https://www.youtube.com/watch?v=x' };
}

/** Sender of an extension page (`path` e.g. '/popup.html'), embedded in `tabId` when given. */
export function pageSender(path: string, tabId?: number): Browser.runtime.MessageSender {
  const sender: Browser.runtime.MessageSender = { id: EXTENSION_ID, url: `chrome-extension://${EXTENSION_ID}${path}` };
  if (tabId !== undefined) {
    sender.tab = { id: tabId } as Browser.tabs.Tab;
    sender.frameId = 9;
  }
  return sender;
}

export async function startBackground(): Promise<BackgroundHarness> {
  fakeBrowser.reset();
  const h: BackgroundHarness = {
    documents: new Map(),
    tabMessages: [],
    captureStart: { mode: 'tabcapture', site: 'tabcapture', enabled: true, latencyMs: 60 },
    offscreenOpen: false,
    async send(message, sender) {
      let answered = false;
      let respond!: (response: unknown) => void;
      const response = new Promise<unknown>((resolve) => {
        respond = (value) => {
          answered = true;
          resolve(value);
        };
      });
      const results: unknown[] = await fakeBrowser.runtime.onMessage.trigger(message, sender, respond);
      // Like Chrome: a listener answers synchronously, or returns true to answer later.
      return answered || results.includes(true) ? response : undefined;
    },
    async restart() {
      fakeBrowser.runtime.onMessage.removeAllListeners();
      fakeBrowser.storage.onChanged.removeAllListeners();
      fakeBrowser.tabs.onRemoved.removeAllListeners();
      fakeBrowser.tabs.onUpdated.removeAllListeners();
      await run();
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
  };

  const browser = fakeBrowser as unknown as Record<string, Record<string, unknown>>;
  browser.tabs!.sendMessage = vi.fn(async (tabId: number, message: RuntimeMessage, options?: TabMessage['options']) => {
    h.tabMessages.push(options ? { tabId, message, options } : { tabId, message });
    const docs = h.documents.get(tabId);
    const frameId = options?.frameId;
    const reachable =
      frameId === undefined
        ? !!docs && docs.size > 0
        : docs?.has(frameId) && (!options?.documentId || docs.get(frameId) === options.documentId);
    if (!reachable) throw new Error(NO_RECEIVER);
    return undefined; // Content scripts do not answer these messages.
  });
  // The background talks to the capture document through runtime.sendMessage.
  browser.runtime!.sendMessage = vi.fn(async (message: RuntimeMessage) => {
    if (!h.offscreenOpen) throw new Error(NO_RECEIVER);
    if (message.type === 'offscreen-start') return h.captureStart;
    return true;
  });
  browser.offscreen = {
    hasDocument: vi.fn(async () => h.offscreenOpen),
    createDocument: vi.fn(async () => void (h.offscreenOpen = true)),
    closeDocument: vi.fn(async () => void (h.offscreenOpen = false)),
  };
  browser.tabCapture = { getMediaStreamId: vi.fn(async () => 'stream-id') };
  browser.scripting = {
    executeScript: vi.fn(async () => []),
    getRegisteredContentScripts: vi.fn(async () => []),
    registerContentScripts: vi.fn(async () => {}),
    updateContentScripts: vi.fn(async () => {}),
    unregisterContentScripts: vi.fn(async () => {}),
  };
  const event = { addListener: vi.fn(), removeListener: vi.fn() };
  browser.permissions = { contains: vi.fn(async () => false), onAdded: event, onRemoved: event };

  async function run(): Promise<void> {
    const { default: background } = await import('../../../src/entrypoints/background');
    background.main();
  }
  await run();
  return h;
}
