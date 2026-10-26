// Background service worker: aggregates the per-tab status reported by content scripts and the
// tab-capture document, drives the action icon and badge, remembers each tab's on/off switch (a
// tab starts off; the popup switches it), injects the generic content script on demand,
// keeps the "always run on this site" registration in sync, runs tab capture sessions (telling the
// tab's content scripts to stand down meanwhile) and issues the one-time tokens with which an
// engine iframe recognises the content script that created it.
//
// MV3 service workers are stopped when idle, so per-tab state, switches and engine tokens live in
// chrome.storage.session (one key each) and are restored on start-up before any event is handled.
import type { RuntimeMessage, TabState, TabStatus } from '@/lib/protocol';
import { normalizeSettings, type Settings } from '@/lib/settings';
import {
  ACTION_ICON_PATHS,
  actionTitle,
  aggregateTabStatus,
  badgeFor,
  iconFor,
  originMatchPattern,
  stableStatus,
  type CommandResult,
} from '@/lib/tab-status';
import type { Browser } from 'wxt/browser';

const GENERIC_SCRIPT = '/content-scripts/generic.js';
const AUTO_SCRIPT_ID = 'generic-auto';
const OFFSCREEN_PATH = 'offscreen.html';
const ENGINE_PATH = '/engine.html';
const TAB_KEY_PREFIX = 'tab:';
const SWITCH_KEY_PREFIX = 'switch:';
const TOKEN_KEY_PREFIX = 'engine-token:';
const NO_RECEIVER = 'Receiving end does not exist';
/** An engine token is presented right after the engine iframe loads; it is not valid for longer. */
const TOKEN_TTL_MS = 60_000;
/** Bound on outstanding engine tokens (content scripts ask for one per engine they start). */
const MAX_TOKENS = 64;
/** crypto.randomUUID() and similar random strings. */
const TOKEN_PATTERN = /^[\w-]{16,128}$/;

/** Everything the worker knows about one tab. */
interface TabRecord {
  /** Latest status per frame, keyed by frameId (0 = top frame). */
  frames: Map<number, FrameEntry>;
  /** Tab-capture session status (enabled), or a stopped record carrying an error detail. */
  capture: TabStatus | null;
}

interface FrameEntry {
  status: TabStatus;
  documentId?: string;
}

/** JSON form of a TabRecord in storage.session. */
interface StoredTab {
  frames: [number, FrameEntry][];
  capture: TabStatus | null;
}

/** A one-time engine token (see 'engine-token' and 'engine-verify' in protocol.ts). */
interface EngineToken {
  tabId: number;
  frameId: number;
  /** Date.now() from which the token is refused. */
  expires: number;
}

export default defineBackground(() => {
  const tabs = new Map<number, TabRecord>();
  /** The on/off switch of each tab the user set it for in the popup (the others are off). */
  const switches = new Map<number, boolean>();
  /** Last icon/badge/title applied per tab, to skip redundant action updates. */
  const appliedBadges = new Map<number, string>();
  /** persistedKey() of what storage.session holds per tab, to skip writes that change nothing. */
  const persisted = new Map<number, string>();
  /** Outstanding engine tokens, oldest first. */
  const tokens = new Map<string, EngineToken>();
  const extensionOrigin = new URL(browser.runtime.getURL('/')).origin;
  const ready = restore();

  // ───────────── state ─────────────

  async function restore(): Promise<void> {
    try {
      const stored = await browser.storage.session.get(null);
      const now = Date.now();
      const restoredTokens: [string, EngineToken][] = [];
      const expired: string[] = [];
      for (const [key, value] of Object.entries(stored)) {
        if (key.startsWith(TAB_KEY_PREFIX)) {
          const tabId = Number(key.slice(TAB_KEY_PREFIX.length));
          if (!Number.isInteger(tabId)) continue;
          const tab = value as StoredTab;
          tabs.set(tabId, { frames: new Map(tab.frames), capture: tab.capture });
          persisted.set(tabId, persistedKey(tab));
        } else if (key.startsWith(SWITCH_KEY_PREFIX)) {
          const tabId = Number(key.slice(SWITCH_KEY_PREFIX.length));
          if (Number.isInteger(tabId) && typeof value === 'boolean') switches.set(tabId, value);
        } else if (key.startsWith(TOKEN_KEY_PREFIX)) {
          const token = value as EngineToken;
          if (token.expires > now) restoredTokens.push([key.slice(TOKEN_KEY_PREFIX.length), token]);
          else expired.push(key);
        }
      }
      for (const [token, entry] of restoredTokens.sort((a, b) => a[1].expires - b[1].expires)) tokens.set(token, entry);
      if (expired.length > 0) void browser.storage.session.remove(expired).catch(() => {});
      // The capture document may have been closed (or crashed) while the worker was asleep.
      if ([...tabs.values()].some((t) => t.capture?.enabled) && !(await browser.offscreen.hasDocument())) {
        for (const [tabId, tab] of tabs) {
          if (tab.capture?.enabled) setCapture(tabId, null);
        }
      }
    } catch {
      // Start from an empty state; content scripts re-report within a few seconds.
    }
  }

  function record(tabId: number): TabRecord {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { frames: new Map(), capture: null };
      tabs.set(tabId, tab);
    }
    return tab;
  }

  function statusOf(tabId: number): TabStatus | null {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    return aggregateTabStatus(
      [...tab.frames].map(([frameId, entry]) => [frameId, entry.status] as const),
      tab.capture,
    );
  }

  /**
   * Persists the tab and refreshes its badge. Reports that only move the look-ahead progress are
   * kept in memory (the popup reads them from there) without a storage write each.
   */
  function commit(tabId: number): void {
    const tab = tabs.get(tabId);
    const key = TAB_KEY_PREFIX + tabId;
    if (!tab || (tab.frames.size === 0 && !tab.capture)) {
      tabs.delete(tabId);
      persisted.delete(tabId);
      void browser.storage.session.remove(key).catch(() => {});
    } else {
      const stored: StoredTab = { frames: [...tab.frames], capture: tab.capture };
      const material = persistedKey(stored);
      if (persisted.get(tabId) !== material) {
        persisted.set(tabId, material);
        void browser.storage.session.set({ [key]: stored }).catch(() => {
          if (persisted.get(tabId) === material) persisted.delete(tabId);
        });
      }
    }
    applyBadge(tabId);
  }

  /** Drops everything about a closed tab. */
  function forget(tabId: number): void {
    tabs.delete(tabId);
    switches.delete(tabId);
    appliedBadges.delete(tabId);
    persisted.delete(tabId);
    void browser.storage.session.remove([TAB_KEY_PREFIX + tabId, SWITCH_KEY_PREFIX + tabId]).catch(() => {});
    dropTokens((entry) => entry.tabId === tabId);
  }

  /** Remembers the popup's switch for a tab; stored before the reply, for frames that start next. */
  async function setSwitch(tabId: number, enabled: boolean): Promise<void> {
    switches.set(tabId, enabled);
    await browser.storage.session.set({ [SWITCH_KEY_PREFIX + tabId]: enabled }).catch(() => {});
  }

  function applyBadge(tabId: number): void {
    const status = statusOf(tabId);
    const icon = iconFor(status);
    const badge = badgeFor(status);
    const title = actionTitle(status);
    const key = `${icon}|${badge.text}|${badge.color}|${title}`;
    if (appliedBadges.get(tabId) === key) return;
    appliedBadges.set(tabId, key);
    const ignore = () => {}; // The tab may have closed meanwhile.
    void browser.action.setIcon({ tabId, path: { ...ACTION_ICON_PATHS[icon] } }).catch(ignore);
    void browser.action.setBadgeText({ tabId, text: badge.text }).catch(ignore);
    void browser.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(ignore);
    void browser.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(ignore);
    void browser.action.setTitle({ tabId, title }).catch(ignore);
  }

  function onFrameStatus(tabId: number, frameId: number, documentId: string | undefined, status: TabStatus): void {
    const tab = record(tabId);
    const previous = frameId === 0 ? tab.frames.get(0)?.documentId : undefined;
    if (documentId && previous && previous !== documentId) {
      // A new top document: statuses of the previous document's subframes are stale. A first
      // report (no previous top entry) keeps them: subframes such as YouTube embeds often report
      // before the top frame's script runs, and verifyAfterLoad drops the ones of an old document.
      tab.frames.clear();
    }
    tab.frames.set(frameId, { status, documentId });
    commit(tabId);
  }

  /**
   * After a load completes, drops the status of every frame whose document no longer runs a
   * content script (cross-document navigation to a page we do not run on, removed iframe). Frames
   * that still answer keep theirs: same-document navigations (YouTube), and YouTube embeds on pages
   * whose top frame never ran a script.
   */
  async function verifyAfterLoad(tabId: number): Promise<void> {
    const tab = tabs.get(tabId);
    if (!tab) return;
    appliedBadges.delete(tabId); // Chrome resets tab-specific action values on navigation.
    await Promise.all(
      [...tab.frames].map(async ([frameId, entry]) => {
        if (await frameRuns(tabId, frameId, entry.documentId)) return;
        // Unless a new document in that frame has reported meanwhile.
        const frames = tabs.get(tabId)?.frames;
        if (frames?.get(frameId) === entry) frames.delete(frameId);
      }),
    );
    const current = tabs.get(tabId);
    if (current?.capture && !current.capture.enabled) current.capture = null; // Old capture error.
    commit(tabId);
  }

  /** Whether a content script still runs in the frame (in the given document, when known). */
  async function frameRuns(tabId: number, frameId: number, documentId: string | undefined): Promise<boolean> {
    try {
      // Content scripts ignore this message type (the reply is undefined); only "no receiver" matters.
      const probe: RuntimeMessage = { type: 'get-tab-status', tabId };
      await browser.tabs.sendMessage(tabId, probe, documentId ? { frameId, documentId } : { frameId });
      return true;
    } catch (e) {
      return !errorMessage(e).includes(NO_RECEIVER);
    }
  }

  // ───────────── engine tokens ─────────────

  /** Remembers a token for the engine iframe a content script is about to start. */
  async function issueToken(token: unknown, tabId: number, frameId: number): Promise<boolean> {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token) || tokens.has(token)) return false;
    pruneTokens();
    const entry: EngineToken = { tabId, frameId, expires: Date.now() + TOKEN_TTL_MS };
    tokens.set(token, entry);
    // Stored before the reply: the worker may be restarted before the engine presents the token.
    await browser.storage.session.set({ [TOKEN_KEY_PREFIX + token]: entry }).catch(() => {});
    return true;
  }

  /** True when the token was issued for this tab and has not expired. Every token is used once. */
  function verifyToken(token: unknown, tabId: number | undefined): boolean {
    const entry = typeof token === 'string' ? tokens.get(token) : undefined;
    if (!entry) return false;
    dropTokens((t) => t === entry);
    return entry.tabId === tabId && entry.expires > Date.now();
  }

  /** Drops expired tokens and, beyond MAX_TOKENS - 1, the oldest ones (room for one more). */
  function pruneTokens(): void {
    const now = Date.now();
    let excess = tokens.size - (MAX_TOKENS - 1);
    dropTokens((entry) => {
      if (entry.expires > now && excess <= 0) return false;
      excess--;
      return true;
    });
  }

  /** Removes the matching tokens (visited oldest first) from memory and storage. */
  function dropTokens(match: (entry: EngineToken) => boolean): void {
    const keys: string[] = [];
    for (const [token, entry] of tokens) {
      if (!match(entry)) continue;
      tokens.delete(token);
      keys.push(TOKEN_KEY_PREFIX + token);
    }
    if (keys.length > 0) void browser.storage.session.remove(keys).catch(() => {});
  }

  // ───────────── settings ─────────────

  async function loadSettings(): Promise<Settings> {
    const stored = await browser.storage.local.get('settings');
    return normalizeSettings(stored.settings);
  }

  async function onSettingsChanged(settings: Settings, previous: Settings): Promise<void> {
    await ready;
    const capturing = [...tabs].filter(([, tab]) => tab.capture?.enabled).map(([tabId]) => tabId);
    if (!settings.enabled) {
      // Master switch off: give the tabs their own audio back with no added latency.
      await Promise.all(capturing.map((tabId) => stopCapture(tabId)));
    } else if (capturing.length > 0) {
      await sendToOffscreen({ type: 'offscreen-settings', settings }).catch(() => {});
    }
    if (!sameSet(settings.autoSites, previous.autoSites)) scheduleAutoSitesSync();
  }

  // ───────────── generic script: on demand and on chosen sites ─────────────

  async function enableOnTab(tabId: number): Promise<CommandResult> {
    let error: string | undefined;
    try {
      await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: [GENERIC_SCRIPT] });
    } catch (e) {
      error = describeInjectionError(errorMessage(e));
    }
    // The script enables itself; the explicit command also covers a script injected earlier, and
    // the frames that run a script of their own when the page could not get one (YouTube embeds).
    const status = (await browser.tabs
      .sendMessage(tabId, { type: 'tab-command', command: 'enable' } satisfies RuntimeMessage)
      .catch(() => null)) as TabStatus | null;
    if (error && !status?.enabled) return { status: statusOf(tabId), error };
    return { status: status ?? statusOf(tabId) };
  }

  let autoSitesSync: Promise<void> | null = null;
  let autoSitesDirty = false;

  /** Coalesces sync requests: at most one running and one pending. */
  function scheduleAutoSitesSync(): void {
    autoSitesDirty = true;
    autoSitesSync ??= (async () => {
      while (autoSitesDirty) {
        autoSitesDirty = false;
        await syncAutoSites().catch(() => {});
      }
      autoSitesSync = null;
    })();
  }

  /** Registers the generic script on every auto site whose host permission is granted. */
  async function syncAutoSites(): Promise<void> {
    const settings = await loadSettings();
    const matches: string[] = [];
    for (const origin of settings.autoSites) {
      const pattern = originMatchPattern(origin);
      if (pattern && !matches.includes(pattern) && (await browser.permissions.contains({ origins: [pattern] }))) {
        matches.push(pattern);
      }
    }
    const [existing] = await browser.scripting.getRegisteredContentScripts({ ids: [AUTO_SCRIPT_ID] });
    if (matches.length === 0) {
      if (existing) await browser.scripting.unregisterContentScripts({ ids: [AUTO_SCRIPT_ID] });
      return;
    }
    const script: Browser.scripting.RegisteredContentScript = {
      id: AUTO_SCRIPT_ID,
      matches,
      allFrames: true,
      runAt: 'document_idle',
      js: [GENERIC_SCRIPT],
    };
    if (!existing) await browser.scripting.registerContentScripts([script]);
    else if (!sameSet(existing.matches ?? [], matches)) await browser.scripting.updateContentScripts([script]);
  }

  // ───────────── tab capture ─────────────

  function setCapture(tabId: number, capture: TabStatus | null): void {
    const tab = record(tabId);
    const wasActive = !!tab.capture?.enabled;
    tab.capture = capture;
    commit(tabId);
    // The tab's content scripts were told (or answered when asking) that capture was running.
    if (wasActive && !capture?.enabled) sendCaptureState(tabId, false);
  }

  /**
   * Tells every frame of the tab whether a capture session processes its audio: in-page processing
   * stands down meanwhile, or the session would process the already processed output again.
   */
  function sendCaptureState(tabId: number, active: boolean): void {
    // Frames without a content script do not need to know.
    void browser.tabs.sendMessage(tabId, { type: 'capture-state', active } satisfies RuntimeMessage).catch(() => {});
  }

  function captureCount(): number {
    let n = 0;
    for (const tab of tabs.values()) if (tab.capture?.enabled) n++;
    return n;
  }

  function captureError(detail: string): TabStatus {
    return { mode: 'off', site: 'tabcapture', enabled: false, detail };
  }

  async function startCapture(tabId: number): Promise<CommandResult> {
    if (tabs.get(tabId)?.capture?.enabled) return { status: statusOf(tabId) };
    let streamId: string;
    try {
      // Allowed because the user just invoked the action on this tab (popup).
      streamId = await browser.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      const error = describeCaptureError(errorMessage(e));
      setCapture(tabId, captureError(error));
      return { status: statusOf(tabId), error };
    }
    setCapture(tabId, { mode: 'starting', site: 'tabcapture', enabled: true });
    try {
      const settings = await loadSettings();
      await ensureOffscreen();
      const status = (await sendToOffscreen({ type: 'offscreen-start', tabId, streamId, settings })) as
        | TabStatus
        | undefined;
      if (!status) throw new Error('The capture page did not answer.');
      if (!status.enabled) throw new Error(status.detail ?? 'Tab capture did not start.');
      if (tabs.get(tabId)?.capture?.enabled) {
        setCapture(tabId, status);
        sendCaptureState(tabId, true);
      } else {
        // Stopped (popup, tab closed, master switch) while starting.
        await stopCapture(tabId);
      }
      return { status: statusOf(tabId) };
    } catch (e) {
      // Stopped while starting: the failure is the consequence, not an error to report.
      if (!tabs.get(tabId)?.capture?.enabled) return { status: statusOf(tabId) };
      const error = describeCaptureError(errorMessage(e));
      setCapture(tabId, captureError(error));
      await closeOffscreenIfIdle();
      return { status: statusOf(tabId), error };
    }
  }

  async function stopCapture(tabId: number): Promise<CommandResult> {
    if (tabs.get(tabId)?.capture) setCapture(tabId, null);
    await sendToOffscreen({ type: 'offscreen-stop', tabId }).catch(() => {});
    await closeOffscreenIfIdle();
    return { status: statusOf(tabId) };
  }

  function onCaptureStatus(tabId: number, status: TabStatus): void {
    // Ignore late reports for sessions that were already stopped here.
    if (!tabs.get(tabId)?.capture?.enabled) return;
    if (status.enabled) {
      setCapture(tabId, status);
    } else {
      // The session ended inside the document (track ended, error).
      setCapture(tabId, status.detail ? status : null);
      void closeOffscreenIfIdle();
    }
  }

  /** Serialises offscreen document creation/closing so they never race. */
  let offscreenQueue: Promise<unknown> = Promise.resolve();

  function onOffscreenQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = offscreenQueue.then(task, task);
    offscreenQueue = run.catch(() => {});
    return run;
  }

  function ensureOffscreen(): Promise<void> {
    return onOffscreenQueue(async () => {
      if (await browser.offscreen.hasDocument()) return;
      await browser.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
        justification: 'Processes the audio of a captured tab to remove its background music and plays the result.',
      });
    });
  }

  function closeOffscreenIfIdle(): Promise<void> {
    return onOffscreenQueue(async () => {
      if (captureCount() === 0 && (await browser.offscreen.hasDocument())) await browser.offscreen.closeDocument();
    });
  }

  /** Sends a message to the offscreen document, retrying while it is still loading. */
  async function sendToOffscreen(message: RuntimeMessage): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await browser.runtime.sendMessage(message);
      } catch (e) {
        const retry = attempt < 20 && errorMessage(e).includes(NO_RECEIVER) && (await browser.offscreen.hasDocument());
        if (!retry) throw e;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  // ───────────── events ─────────────

  /** URL of the sending extension page, or null for content scripts. */
  function extensionPageUrl(sender: Browser.runtime.MessageSender): URL | null {
    const url = sender.url ? new URL(sender.url) : null;
    return url?.origin === extensionOrigin ? url : null;
  }

  /** Answers an async command once state is restored. */
  function reply(sendResponse: (response: unknown) => void, task: () => Promise<CommandResult>): true {
    ready
      .then(task)
      .then(sendResponse, (e: unknown) => sendResponse({ status: null, error: errorMessage(e) } satisfies CommandResult));
    return true;
  }

  /** Messages from the content scripts of a tab. */
  function onContentMessage(
    msg: RuntimeMessage,
    sender: Browser.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean {
    const tabId = sender.tab?.id;
    if (tabId === undefined || tabId < 0) return false;
    switch (msg.type) {
      case 'tab-status':
        void ready.then(() => onFrameStatus(tabId, sender.frameId ?? 0, sender.documentId, msg.status));
        return false;
      case 'get-tab-state':
        void ready.then(() =>
          sendResponse({ capture: !!tabs.get(tabId)?.capture?.enabled, enabled: switches.get(tabId) ?? null } satisfies TabState),
        );
        return true;
      case 'engine-token':
        void ready
          .then(() => issueToken(msg.token, tabId, sender.frameId ?? 0))
          .then((ok) => sendResponse({ ok }));
        return true;
      default:
        return false;
    }
  }

  /** Messages from extension pages: the popup, the capture document and engine iframes. */
  function onPageMessage(
    msg: RuntimeMessage,
    page: URL,
    sender: Browser.runtime.MessageSender,
    sendResponse: (response: unknown) => void,
  ): boolean {
    switch (msg.type) {
      case 'get-tab-status':
        void ready.then(() => sendResponse(statusOf(msg.tabId)));
        return true;
      case 'set-tab-enabled':
        if (!Number.isInteger(msg.tabId) || typeof msg.enabled !== 'boolean') return false;
        void ready.then(() => setSwitch(msg.tabId, msg.enabled)).then(() => sendResponse({ ok: true }));
        return true;
      case 'enable-on-tab':
        return reply(sendResponse, () => enableOnTab(msg.tabId));
      case 'start-tab-capture':
        return reply(sendResponse, () => startCapture(msg.tabId));
      case 'stop-tab-capture':
        return reply(sendResponse, () => stopCapture(msg.tabId));
      case 'offscreen-status':
        void ready.then(() => onCaptureStatus(msg.tabId, msg.status));
        return false;
      case 'engine-verify': {
        // Only an engine iframe may spend a token; sender.tab is the tab that embeds it.
        if (page.pathname !== ENGINE_PATH) {
          sendResponse({ ok: false });
          return false;
        }
        const tabId = sender.tab?.id;
        void ready.then(() => sendResponse({ ok: verifyToken(msg.token, tabId) }));
        return true;
      }
      default:
        return false;
    }
  }

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as RuntimeMessage | undefined;
    if (typeof msg?.type !== 'string' || sender.id !== browser.runtime.id) return false;
    const page = extensionPageUrl(sender);
    return page ? onPageMessage(msg, page, sender, sendResponse) : onContentMessage(msg, sender, sendResponse);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    const change = changes.settings;
    if (area !== 'local' || !change) return;
    void onSettingsChanged(normalizeSettings(change.newValue), normalizeSettings(change.oldValue));
  });

  browser.permissions.onAdded.addListener(scheduleAutoSitesSync);
  browser.permissions.onRemoved.addListener(scheduleAutoSitesSync);

  browser.tabs.onRemoved.addListener((tabId) => {
    void ready.then(async () => {
      const capturing = !!tabs.get(tabId)?.capture?.enabled;
      forget(tabId);
      if (capturing) {
        await sendToOffscreen({ type: 'offscreen-stop', tabId }).catch(() => {});
        await closeOffscreenIfIdle();
      }
    });
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'complete') void ready.then(() => verifyAfterLoad(tabId));
  });

  // Registrations persist across sessions; re-check them on every start (permissions may have
  // been revoked from chrome://extensions while we were not running).
  scheduleAutoSitesSync();
});

/** What a stored tab record says, without the numbers that change with every report. */
function persistedKey(tab: StoredTab): string {
  return JSON.stringify({
    frames: tab.frames.map(([frameId, entry]) => [frameId, entry.documentId, stableStatus(entry.status)]),
    capture: tab.capture && stableStatus(tab.capture),
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeInjectionError(message: string): string {
  if (/file:/i.test(message)) {
    return 'Allow access to file URLs in the extension details (chrome://extensions), or use tab capture.';
  }
  if (/gallery|cannot be scripted|chrome:\/\//i.test(message)) return "Chrome doesn't allow extensions on this page.";
  if (/cannot access|permission/i.test(message)) {
    return "Chrome didn't give access to this page. Reopen this popup on the page and try again, or use tab capture.";
  }
  return `Can't run on this page: ${message}`;
}

function describeCaptureError(message: string): string {
  if (/active stream/i.test(message)) {
    return 'This tab is already being captured (by Chrome or another extension). Stop that first.';
  }
  if (/invoked|activeTab|permission/i.test(message)) {
    return 'Open this popup on the tab, then start tab capture again.';
  }
  return `Tab capture failed: ${message}`;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}
