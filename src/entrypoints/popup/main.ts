// Toolbar popup: per-tab on/off, tab capture, "always run on this site" and the global settings.
import type { RuntimeMessage, TabStatus } from '@/lib/protocol';
import { normalizeSettings, REDUCTION_STEPS, type Settings } from '@/lib/settings';
import {
  canOfferTabCapture,
  classifyPage,
  describeStatus,
  isCapturing,
  originMatchPattern,
  reductionLabel,
  reductionStepIndex,
  type CommandResult,
  type PageInfo,
  type StatusText,
} from '@/lib/tab-status';

const POLL_MS = 1000;
const SAVE_DEBOUNCE_MS = 150;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

const ui = {
  tabToggle: byId<HTMLInputElement>('tab-toggle'),
  dot: byId('status-dot'),
  headline: byId('status-headline'),
  progress: byId('status-progress'),
  detail: byId('status-detail'),
  latency: byId('status-latency'),
  capture: byId('capture'),
  captureButton: byId<HTMLButtonElement>('capture-button'),
  reload: byId<HTMLDivElement>('reload'),
  reloadButton: byId<HTMLButtonElement>('reload-button'),
  autoRow: byId('auto-row'),
  autoSite: byId<HTMLInputElement>('auto-site'),
  autoOrigin: byId('auto-origin'),
  reduction: byId<HTMLInputElement>('reduction'),
  reductionValue: byId<HTMLOutputElement>('reduction-value'),
  gap: byId<HTMLInputElement>('gap'),
  quality: byId<HTMLSelectElement>('quality'),
  master: byId<HTMLInputElement>('master'),
};

let settings: Settings = normalizeSettings(undefined);
let tabId: number | null = null;
let page: PageInfo = { kind: 'restricted', origin: null };
let status: TabStatus | null = null;
/** Result of the last user action (e.g. an error), shown instead of the status detail. */
let notice: string | null = null;
let checked = false;
let busy = 0;
let autoSiteGranted = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

// ───────────── messaging ─────────────

function send<T>(message: RuntimeMessage): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}

/**
 * Sends a command to the tab's content scripts (all frames, or only `frameId`). Resolves with the
 * status of the frame that answered first; undefined when none runs there.
 */
function sendTabCommand(command: 'enable' | 'disable', frameId?: number): Promise<TabStatus | undefined> {
  if (tabId === null) return Promise.resolve(undefined);
  const message: RuntimeMessage = { type: 'tab-command', command };
  const sent =
    frameId === undefined ? browser.tabs.sendMessage(tabId, message) : browser.tabs.sendMessage(tabId, message, { frameId });
  return (sent as Promise<TabStatus | undefined>).catch(() => undefined);
}

async function refreshStatus(): Promise<void> {
  if (tabId === null) return;
  const next = await send<TabStatus | null>({ type: 'get-tab-status', tabId }).catch(() => null);
  if (busy > 0) return; // An action in flight owns the status until it completes.
  status = next ?? null;
  checked = true;
  render();
}

function applyResult(result: CommandResult | undefined): void {
  status = result?.status ?? null;
  if (result?.error) notice = result.error;
}

/** Runs a user action with the controls locked; its reply replaces the status until the next poll. */
async function runAction(task: () => Promise<void>): Promise<void> {
  busy++;
  notice = null;
  render();
  try {
    await task();
  } catch (e) {
    notice = e instanceof Error ? e.message : String(e);
  } finally {
    busy--;
    render();
  }
}

// ───────────── tab actions ─────────────

/** Remembers the switch for the tab: frames and pages it loads afterwards start that way. */
async function setTabSwitch(enabled: boolean): Promise<void> {
  if (tabId !== null) await send({ type: 'set-tab-enabled', tabId, enabled });
}

async function enableHere(): Promise<void> {
  if (tabId === null) return;
  await setTabSwitch(true);
  // Ask the top frame itself: on a page with a YouTube embed, the embed's controller answers a
  // broadcast although the page has no controller of its own yet.
  const top = await sendTabCommand('enable', 0);
  if (top) {
    status = top;
    // Frames switched off together with the page (embeds) follow it back on. The top frame gets
    // the command again, which changes nothing there.
    await sendTabCommand('enable');
    return;
  }
  if (page.kind === 'youtube') {
    // The YouTube controller is injected on page load only.
    notice = 'Reload the page to start.';
    return;
  }
  // Injects the generic script into every frame Chrome lets us access, then enables all frames.
  applyResult(await send<CommandResult>({ type: 'enable-on-tab', tabId }));
  // Nothing could start here: the switch shows off, so the tab must not stay on either.
  if (!status?.enabled) await setTabSwitch(false);
}

async function disableHere(): Promise<void> {
  if (tabId === null) return;
  await setTabSwitch(false);
  if (isCapturing(status)) applyResult(await send<CommandResult>({ type: 'stop-tab-capture', tabId }));
  const reply = await sendTabCommand('disable');
  if (reply) status = reply;
}

function onTabToggle(): void {
  const on = ui.tabToggle.checked;
  void runAction(on ? enableHere : disableHere);
}

function onCaptureClick(): void {
  if (tabId === null) return;
  const id = tabId;
  const capturing = isCapturing(status);
  void runAction(async () => {
    applyResult(await send<CommandResult>({ type: capturing ? 'stop-tab-capture' : 'start-tab-capture', tabId: id }));
  });
}

function onAutoSiteChange(): void {
  const origin = page.origin;
  const pattern = origin && originMatchPattern(origin);
  if (!origin || !pattern) return;
  const others = settings.autoSites.filter((o) => o !== origin);
  if (!ui.autoSite.checked) {
    autoSiteGranted = false;
    void saveSettings({ autoSites: others });
    void browser.permissions.remove({ origins: [pattern] }).catch(() => {});
    return;
  }
  // Ask first, while the click still counts as a user gesture.
  const request = browser.permissions.request({ origins: [pattern] });
  void runAction(async () => {
    // Save right away: the popup may close while Chrome shows the prompt, and the background
    // registers the site as soon as the permission is granted.
    await saveSettings({ autoSites: [...others, origin] });
    autoSiteGranted = await request;
    if (!autoSiteGranted) {
      await saveSettings({ autoSites: others });
      return;
    }
    if (!status?.enabled) await enableHere();
  });
}

// ───────────── settings ─────────────

function saveSettings(patch: Partial<Settings>): Promise<void> {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  settings = normalizeSettings({ ...settings, ...patch });
  render();
  return browser.storage.local.set({ settings });
}

function saveSettingsSoon(patch: Partial<Settings>): void {
  settings = normalizeSettings({ ...settings, ...patch });
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveSettings({}), SAVE_DEBOUNCE_MS);
}

function onReductionInput(): void {
  const step = REDUCTION_STEPS[Number(ui.reduction.value)];
  if (step !== undefined) saveSettingsSoon({ reductionDb: step });
}

// ───────────── rendering ─────────────

function setText(el: HTMLElement, text: string | undefined): void {
  // Only touch the DOM on change, so the live region does not repeat itself.
  const value = text ?? '';
  if (el.textContent !== value) el.textContent = value;
  el.hidden = value === '';
}

function render(): void {
  const capturing = isCapturing(status);
  const text: StatusText = checked
    ? describeStatus(status, page, settings.enabled)
    : { headline: 'Checking this tab…', tone: 'idle' };
  ui.dot.dataset.tone = notice ? 'warning' : text.tone;
  setText(ui.headline, text.headline);
  setText(ui.progress, text.progress && ` · ${text.progress}`);
  setText(ui.detail, notice ?? text.detail);
  setText(ui.latency, text.latency);

  const usable = tabId !== null && page.kind !== 'restricted' && settings.enabled;
  // While an action runs, the switches keep the state the user just gave them.
  if (busy === 0) ui.tabToggle.checked = !!status?.enabled;
  ui.tabToggle.disabled = !usable || !checked || busy > 0;

  // Routed media that went silent: only a reload brings its sound back.
  ui.reload.hidden = !(usable && checked && status?.needsReload);
  ui.reloadButton.disabled = busy > 0;

  const offerCapture = usable && checked && (capturing || canOfferTabCapture(status, page));
  ui.capture.hidden = !offerCapture;
  setText(ui.captureButton, capturing ? 'Stop tab capture' : 'Use tab capture instead');
  ui.captureButton.classList.toggle('primary', !capturing && !!status?.needsTabCapture);
  ui.captureButton.disabled = busy > 0;

  const origin = page.kind === 'web' ? page.origin : null;
  ui.autoRow.hidden = !origin;
  if (origin) {
    setText(ui.autoOrigin, new URL(origin).host);
    ui.autoRow.title = origin;
    if (busy === 0) ui.autoSite.checked = autoSiteGranted && settings.autoSites.includes(origin);
    ui.autoSite.disabled = !settings.enabled || busy > 0;
  }

  const index = reductionStepIndex(settings.reductionDb);
  const label = reductionLabel(REDUCTION_STEPS[index] ?? settings.reductionDb);
  ui.reduction.value = String(index);
  ui.reduction.style.setProperty('--ratio', String(index / (REDUCTION_STEPS.length - 1)));
  ui.reduction.setAttribute('aria-valuetext', label);
  ui.reductionValue.value = label;
  ui.gap.checked = settings.gapReduction;
  ui.quality.value = settings.quality;
  ui.master.checked = settings.enabled;
}

// ───────────── start-up ─────────────

async function init(): Promise<void> {
  ui.reduction.max = String(REDUCTION_STEPS.length - 1);
  ui.tabToggle.addEventListener('change', onTabToggle);
  ui.captureButton.addEventListener('click', onCaptureClick);
  ui.reloadButton.addEventListener('click', () => {
    if (tabId === null) return;
    void browser.tabs.reload(tabId).then(() => window.close());
  });
  ui.autoSite.addEventListener('change', onAutoSiteChange);
  ui.reduction.addEventListener('input', onReductionInput);
  ui.gap.addEventListener('change', () => void saveSettings({ gapReduction: ui.gap.checked }));
  ui.quality.addEventListener('change', () => void saveSettings({ quality: ui.quality.value === 'realtime' ? 'realtime' : 'auto' }));
  ui.master.addEventListener('change', () => void saveSettings({ enabled: ui.master.checked }));
  // Do not lose a debounced slider change when the popup closes.
  window.addEventListener('pagehide', () => {
    if (saveTimer !== undefined) void saveSettings({});
  });

  const [tabs, stored] = await Promise.all([
    browser.tabs.query({ active: true, currentWindow: true }),
    browser.storage.local.get('settings'),
  ]);
  settings = normalizeSettings(stored.settings);
  const tab = tabs[0];
  tabId = tab?.id ?? null;
  page = classifyPage(tab?.url);
  render();

  const pattern = page.kind === 'web' && page.origin ? originMatchPattern(page.origin) : null;
  await Promise.all([
    refreshStatus(),
    pattern
      ? browser.permissions.contains({ origins: [pattern] }).then((granted) => {
          autoSiteGranted = granted;
        })
      : undefined,
  ]);
  render();
  setInterval(() => void refreshStatus(), POLL_MS);
}

void init();
