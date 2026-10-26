// Pure helpers shared by the background and the popup: per-tab status aggregation, the toolbar
// icon and badge, page classification and the human-readable status strings shown in the popup.
import { REMOVE_DB } from './constants';
import type { TabMode, TabStatus } from './protocol';
import { REDUCTION_STEPS } from './settings';

/** Ranking of modes when several frames of one tab report a status (higher wins). */
export const MODE_PRIORITY: Readonly<Record<TabMode, number>> = {
  off: 0,
  unsupported: 1,
  passthrough: 2,
  waiting: 3,
  starting: 4,
  tabcapture: 5,
  realtime: 6,
  lookahead: 7,
};

/** Modes in which the user hears processed audio. */
export function isProcessing(mode: TabMode): boolean {
  return mode === 'realtime' || mode === 'lookahead' || mode === 'tabcapture';
}

/** Modes that let a subframe take precedence over the top frame. */
function isActive(mode: TabMode): boolean {
  return isProcessing(mode) || mode === 'starting';
}

/** True while a tab-capture session is running (or starting) for the tab. */
export function isCapturing(status: TabStatus | null | undefined): boolean {
  return status?.site === 'tabcapture' && status.enabled;
}

/**
 * Combines the statuses reported by the frames of one tab (keyed by frameId; 0 is the top frame)
 * and the tab-capture session status into the tab's status.
 *
 * - A running capture session wins: it is what the user hears.
 * - Otherwise the top frame wins, unless a subframe has an active mode (lookahead > realtime >
 *   tabcapture > starting) that outranks it, or the top frame merely waits while a subframe found
 *   media that needs tab capture.
 * - A stopped capture record that carries a detail (e.g. a capture error) replaces the detail.
 */
export function aggregateTabStatus(
  frames: Iterable<readonly [frameId: number, status: TabStatus]>,
  capture?: TabStatus | null,
): TabStatus | null {
  if (capture && capture.enabled) return capture;

  let top: TabStatus | undefined;
  let active: TabStatus | undefined;
  let needsCapture: TabStatus | undefined;
  let fallback: TabStatus | undefined;
  for (const [frameId, status] of frames) {
    if (frameId === 0) {
      top = status;
      continue;
    }
    const rank = MODE_PRIORITY[status.mode];
    if (isActive(status.mode) && (!active || rank > MODE_PRIORITY[active.mode])) active = status;
    if (status.needsTabCapture && !needsCapture) needsCapture = status;
    if (!fallback || rank > MODE_PRIORITY[fallback.mode]) fallback = status;
  }

  let winner: TabStatus | undefined;
  if (active && (!top || MODE_PRIORITY[active.mode] > MODE_PRIORITY[top.mode])) winner = active;
  else if (top) winner = needsCapture && !isActive(top.mode) && !top.needsTabCapture && top.mode !== 'off' ? needsCapture : top;
  else winner = needsCapture ?? fallback;

  if (capture?.detail) return winner ? { ...winner, detail: capture.detail } : capture;
  return winner ?? null;
}

/**
 * The status without the numbers that change with every report (look-ahead progress and speed).
 * Two reports with equal stable statuses differ only in what the popup shows as live progress.
 */
export function stableStatus(status: TabStatus): TabStatus {
  if (!status.lookahead) return status;
  const { aheadSeconds: _ahead, rtf: _rtf, ...lookahead } = status.lookahead;
  return { ...status, lookahead };
}

// ───────────── toolbar action ─────────────

export type ActionIcon = 'on' | 'off';

/**
 * Toolbar icon images per state (rendered from assets/icon.svg by scripts/make-icons.mjs). 'off'
 * is also the manifest's default_icon (wxt.config.ts): what a tab shows until it is switched on.
 */
export const ACTION_ICON_PATHS: Readonly<Record<ActionIcon, Readonly<Record<number, string>>>> = {
  on: { 16: '/icon/16.png', 32: '/icon/32.png' },
  off: { 16: '/icon/off/16.png', 32: '/icon/off/32.png' },
};

/** The icon is in colour while the extension is on in the tab (whatever it does there), grey otherwise. */
export function iconFor(status: TabStatus | null): ActionIcon {
  return status?.enabled ? 'on' : 'off';
}

export const BADGE_WARNING_COLOR = '#d97706';

export interface Badge {
  text: string;
  /** Background colour (CSS hex). */
  color: string;
}

/** Badge shown on the toolbar action for a tab: only a warning (the icon shows on and off). */
export function badgeFor(status: TabStatus | null): Badge {
  if (status && (status.needsTabCapture || status.mode === 'unsupported') && !isProcessing(status.mode)) {
    return { text: '!', color: BADGE_WARNING_COLOR };
  }
  return { text: '', color: BADGE_WARNING_COLOR };
}

export const EXTENSION_NAME = 'Mute BG Audio';

const SHORT_LABELS: Readonly<Record<TabMode, string>> = {
  off: 'Off',
  waiting: 'Waiting for the video to play',
  starting: 'Starting',
  realtime: 'Real-time (CPU)',
  lookahead: 'Look-ahead',
  passthrough: 'Audio unchanged',
  tabcapture: 'Tab capture',
  unsupported: "Can't process this video directly",
};

/** Tooltip of the toolbar action. Coarse on purpose so it does not change every second. */
export function actionTitle(status: TabStatus | null): string {
  if (!status) return EXTENSION_NAME;
  let label = (status.mode === 'waiting' && idleHeadline(status.detail)) || SHORT_LABELS[status.mode];
  if (status.mode === 'lookahead') label += ` (${backendLabel(status)})`;
  if (status.needsTabCapture && !isProcessing(status.mode)) label += ' – tab capture available';
  return `${EXTENSION_NAME}: ${label}`;
}

// ───────────── pages ─────────────

/**
 * - youtube: the YouTube controller runs (off until the tab is switched on).
 * - web: http(s) page; the generic script can be injected and the origin can be auto-enabled.
 * - file: local file; injection needs "Allow access to file URLs", no auto-run.
 * - restricted: Chrome does not let extensions script or capture it.
 */
export type PageKind = 'youtube' | 'web' | 'file' | 'restricted';

export interface PageInfo {
  kind: PageKind;
  /** Origin of http(s) pages (e.g. "https://vimeo.com"), otherwise null. */
  origin: string | null;
}

const YOUTUBE_HOST = /(^|\.)(youtube|youtube-nocookie)\.com$/;

/** Classifies the active tab's URL (undefined when the extension cannot see it). */
export function classifyPage(url: string | undefined): PageInfo {
  let parsed: URL;
  try {
    parsed = new URL(url ?? '');
  } catch {
    return { kind: 'restricted', origin: null };
  }
  if (parsed.protocol === 'file:') return { kind: 'file', origin: null };
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'restricted', origin: null };
  const host = parsed.hostname;
  const webStore =
    host === 'chromewebstore.google.com' || (host === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'));
  if (webStore) return { kind: 'restricted', origin: null };
  return { kind: YOUTUBE_HOST.test(host) ? 'youtube' : 'web', origin: parsed.origin };
}

/** Match pattern covering every page of an http(s) origin, or null for anything else. */
export function originMatchPattern(origin: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== origin) return null;
  return `${parsed.origin}/*`;
}

/** Whether the popup should offer "Use tab capture instead" (false while capturing). */
export function canOfferTabCapture(status: TabStatus | null, page: PageInfo): boolean {
  if (page.kind === 'restricted' || isCapturing(status)) return false;
  if (status?.needsTabCapture) return true;
  // Media that became unreadable after it was routed: the tab plays its silence, so capture would
  // record silence too. Only a reload helps, which the detail says.
  if (status?.mode === 'unsupported') return false;
  // Outside YouTube there may be no tappable media at all; capture is the universal fallback.
  return page.kind !== 'youtube' && !(status && isProcessing(status.mode));
}

// ───────────── popup strings ─────────────

export type StatusTone = 'active' | 'pending' | 'warning' | 'idle';

export interface StatusText {
  headline: string;
  /** Fast-changing part of the headline (e.g. "24 s ready"); kept apart so it is not announced. */
  progress?: string;
  detail?: string;
  /** e.g. "Latency 60 ms" when known and processing. */
  latency?: string;
  tone: StatusTone;
}

const UNSUPPORTED_HEADLINE = "Can't process this video directly";

/** Text of the popup's status block. `masterEnabled` is settings.enabled. */
export function describeStatus(status: TabStatus | null, page: PageInfo, masterEnabled: boolean): StatusText {
  if (!masterEnabled) {
    return { headline: 'Turned off on all sites', detail: 'Switch it back on below.', tone: 'idle' };
  }
  if (page.kind === 'restricted') {
    return { headline: "Chrome doesn't allow extensions on this page", tone: 'idle' };
  }
  if (!status) {
    if (page.kind === 'youtube') {
      return { headline: 'Not running on this tab yet', detail: 'Reload the page to start.', tone: 'idle' };
    }
    return { headline: 'Off on this page', detail: 'Turn it on to process the audio playing here.', tone: 'idle' };
  }

  const text = describeMode(status);
  if (status.latencyMs !== undefined && Number.isFinite(status.latencyMs) && isProcessing(status.mode)) {
    text.latency = `Latency ${Math.round(status.latencyMs)} ms`;
  }
  return text;
}

function describeMode(status: TabStatus): StatusText {
  const detail = status.detail || undefined;
  switch (status.mode) {
    case 'lookahead': {
      const text: StatusText = { headline: `Look-ahead · ${backendLabel(status)}`, tone: 'active' };
      const ahead = aheadLabel(status.lookahead?.aheadSeconds);
      if (ahead) text.progress = ahead;
      return withDetail(text, detail);
    }
    case 'realtime':
      return withDetail({ headline: 'Real-time · CPU', tone: 'active' }, detail ?? lookaheadNote(status));
    case 'tabcapture':
      return withDetail({ headline: 'Tab capture · Real-time · CPU', tone: 'active' }, detail);
    case 'starting':
      return withDetail({ headline: status.site === 'tabcapture' ? 'Starting tab capture…' : 'Starting…', tone: 'pending' }, detail);
    case 'waiting': {
      // The processing is idle because the video is paused or silent: the detail is the headline.
      const idle = idleHeadline(detail);
      if (idle) return { headline: idle, tone: 'pending' };
      // Skip a detail that only repeats the headline ("Waiting for a video to play.").
      return withDetail(
        { headline: 'Waiting for the video to play', tone: 'pending' },
        detail && !/^waiting for (a|the) video/i.test(detail) ? detail : undefined,
      );
    }
    case 'passthrough':
      return withDetail({ headline: 'Audio passes through unchanged', tone: 'pending' }, detail);
    case 'unsupported':
      return detail
        ? { headline: UNSUPPORTED_HEADLINE, detail, tone: 'warning' }
        : { headline: `${UNSUPPORTED_HEADLINE} (protected or cross-origin media)`, tone: 'warning' };
    case 'off':
      if (status.site === 'tabcapture') return withDetail({ headline: 'Tab capture stopped', tone: 'warning' }, detail);
      return withDetail({ headline: 'Off on this tab', tone: 'idle' }, detail);
  }
}

/** Full status line, e.g. "Look-ahead · GPU · 24 s ready". */
export function statusLine(text: StatusText): string {
  return text.progress ? `${text.headline} · ${text.progress}` : text.headline;
}

function withDetail(text: StatusText, detail: string | undefined): StatusText {
  return detail ? { ...text, detail } : text;
}

/** Headline for the details the controller reports while its mixer idles ('Paused.', 'No sound.'). */
function idleHeadline(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (/^paused\.?$/i.test(detail)) return 'Paused';
  if (/^no sound\.?$/i.test(detail)) return 'Waiting for sound';
  return undefined;
}

function backendLabel(status: TabStatus): 'GPU' | 'CPU' {
  return status.lookahead?.backend === 'wasm' ? 'CPU' : 'GPU';
}

function aheadLabel(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 1) return null;
  return `${Math.floor(seconds)} s ready`;
}

/** Why a YouTube tab is still on the real-time model. */
function lookaheadNote(status: TabStatus): string | undefined {
  const la = status.lookahead;
  if (!la) return undefined;
  switch (la.state) {
    case 'loading':
      return 'Preparing the GPU look-ahead model…';
    case 'ready':
      return 'Look-ahead is syncing with the video…';
    case 'unavailable':
      return la.reason ? `Look-ahead unavailable: ${la.reason}` : 'Look-ahead is unavailable on this device.';
    case 'error':
      return la.reason ? `Look-ahead failed: ${la.reason}` : 'Look-ahead failed.';
    case 'off':
      return undefined;
  }
}

// ───────────── reduction slider ─────────────

/** Label of a reduction value: "18 dB" … "Remove". */
export function reductionLabel(reductionDb: number): string {
  return reductionDb >= REMOVE_DB ? 'Remove' : `${Math.round(reductionDb)} dB`;
}

/** Index of the REDUCTION_STEPS entry closest to `reductionDb`. */
export function reductionStepIndex(reductionDb: number): number {
  let best = 0;
  for (let i = 1; i < REDUCTION_STEPS.length; i++) {
    const step = REDUCTION_STEPS[i]!;
    if (Math.abs(step - reductionDb) < Math.abs(REDUCTION_STEPS[best]! - reductionDb)) best = i;
  }
  return best;
}

// ───────────── background replies ─────────────

/** Reply of the background to 'enable-on-tab', 'start-tab-capture' and 'stop-tab-capture'. */
export interface CommandResult {
  status: TabStatus | null;
  /** User-facing error when the command failed. */
  error?: string;
}
