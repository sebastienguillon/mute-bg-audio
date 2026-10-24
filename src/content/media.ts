// Media element helpers for content scripts.

export type TapVerdict =
  | { ok: true }
  | { ok: false; reason: 'drm' | 'cross-origin' | 'no-source' | 'unverified' };

const OK: TapVerdict = { ok: true };
const fail = (reason: Exclude<TapVerdict, { ok: true }>['reason']): TapVerdict => ({ ok: false, reason });

export interface TapProbeTimeouts {
  /** Fetch probe timeout; no answer in time gives 'unverified'. */
  fetchMs: number;
  /** How long to wait for a first video frame for the canvas check. */
  frameMs: number;
  /** Delay before the canvas check: Chrome marks a frame tainted only a few hundred ms after it is shown. */
  taintSettleMs: number;
}

const DEFAULT_TIMEOUTS: TapProbeTimeouts = { fetchMs: 5000, frameMs: 3000, taintSettleMs: 500 };

/**
 * Whether routing the element through Web Audio would give real samples. Routing an element whose
 * media is cross-origin without CORS (or DRM-protected) silences it permanently, so we must not;
 * on any doubt the verdict is negative.
 *
 * The URL alone is not enough: Chrome taints media by the origin of the final response, so a
 * same-origin URL that redirects to another site without CORS is tainted. For http(s) sources the
 * response is checked with a fetch of the URL that fails for anything the page could not read:
 * 'same-origin' mode rejects a redirect to another origin, 'cors' mode (crossorigin attribute
 * set) a response without CORS approval. The crossorigin attribute only helps if it was set
 * before the load started; for videos with it, a frame is also drawn onto a canvas, which a
 * tainted frame makes unreadable. (Audio set up that way is left to the controller's silence
 * watchdog.)
 */
export async function canTap(el: HTMLMediaElement, timeouts: TapProbeTimeouts = DEFAULT_TIMEOUTS): Promise<TapVerdict> {
  const fast = urlVerdict(el);
  if (fast !== 'probe') return fast;
  const src = el.currentSrc || el.src;
  const fetched = await fetchProbe(src, el.crossOrigin, timeouts.fetchMs);
  if (!fetched.ok || el.crossOrigin === null || !(el instanceof HTMLVideoElement)) return fetched;
  if (await waitForFrame(el, timeouts.frameMs)) {
    await new Promise((resolve) => setTimeout(resolve, timeouts.taintSettleMs));
    // The element may have switched to another source meanwhile: that one gets its own check.
    if ((el.currentSrc || el.src) !== src) return fail('unverified');
    if (frameTaint(el) === 'tainted') return fail('cross-origin');
  }
  return OK;
}

/** Verdict from the element's state and URL alone, or 'probe' when the response must be checked. */
export function urlVerdict(el: HTMLMediaElement): TapVerdict | 'probe' {
  if (el.mediaKeys) return fail('drm');
  // MediaStream, MediaSource handle or Blob objects: produced in this page, readable.
  if (el.srcObject) return OK;
  const src = el.currentSrc || el.src;
  if (!src) return fail('no-source');
  let url: URL;
  try {
    url = new URL(src, location.href);
  } catch {
    return fail('no-source');
  }
  if (url.protocol === 'blob:' || url.protocol === 'data:') return OK;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file: and other local schemes cannot be fetched or redirected elsewhere: the origin decides.
    return url.origin === location.origin ? OK : fail('cross-origin');
  }
  // Without the crossorigin attribute, a cross-origin response is always tainted.
  if (url.origin !== location.origin && el.crossOrigin === null) return fail('cross-origin');
  return 'probe';
}

const HAVE_CURRENT_DATA = 2;
const HAVE_FUTURE_DATA = 3;

/** Resolves true once the video shows a frame, false if it gets none in time (or has no video track). */
function waitForFrame(el: HTMLVideoElement, timeoutMs: number): Promise<boolean> {
  const hasFrame = () => el.readyState >= HAVE_CURRENT_DATA && el.videoWidth > 0;
  if (hasFrame()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const events = ['loadeddata', 'playing', 'timeupdate', 'emptied', 'error'] as const;
    const done = (v: boolean) => {
      clearTimeout(timer);
      for (const t of events) el.removeEventListener(t, onEvent);
      resolve(v);
    };
    const onEvent = (e: Event) => {
      if (hasFrame()) done(true);
      else if (e.type === 'emptied' || e.type === 'error' || el.readyState >= HAVE_CURRENT_DATA) done(false);
    };
    const timer = setTimeout(() => done(hasFrame()), timeoutMs);
    for (const t of events) el.addEventListener(t, onEvent);
  });
}

/** Draws the current frame onto a 1×1 canvas: reading it back fails if the frame is tainted. */
function frameTaint(el: HTMLVideoElement): 'clean' | 'tainted' | 'unknown' {
  let g: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  try {
    if (typeof OffscreenCanvas === 'function') {
      g = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      g = canvas.getContext('2d', { willReadFrequently: true });
    }
  } catch {
    return 'unknown';
  }
  if (!g) return 'unknown';
  try {
    g.drawImage(el, 0, 0, 1, 1);
  } catch {
    return 'unknown';
  }
  try {
    g.getImageData(0, 0, 1, 1);
    return 'clean';
  } catch (e) {
    return e instanceof DOMException && e.name === 'SecurityError' ? 'tainted' : 'unknown';
  }
}

/** Streaming playlists: the segments may come from anywhere, so the playlist's origin proves nothing. */
const PLAYLIST_TYPE = /mpegurl|dash\+xml/i;
const PLAYLIST_PATH = /\.(m3u8|mpd)$/i;

/**
 * Requests the first byte of `src` the way the element did (same credentials), in a mode that
 * rejects a response the page could not read: 'same-origin' rejects any redirect to another
 * origin (and opaque service-worker responses); 'cors' (crossorigin attribute set) rejects
 * responses without CORS approval.
 */
async function fetchProbe(src: string, crossOrigin: string | null, timeoutMs: number): Promise<TapVerdict> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const credentials: RequestCredentials = crossOrigin === null || crossOrigin === 'use-credentials' ? 'include' : 'same-origin';
  const probe = () =>
    fetch(src, {
      mode: crossOrigin === null ? 'same-origin' : 'cors',
      credentials,
      headers: { Range: 'bytes=0-0' },
      signal: abort.signal,
    });
  try {
    let res: Response;
    try {
      res = await probe();
    } catch {
      // Refused by policy, or a network failure (connection reset, offline), which also fails a
      // 'no-cors' request. That is 'unverified' (checked again at the next play), not remembered
      // for the source; with the network back, a second refusal is the policy's.
      if (abort.signal.aborted || !(await reachable(src, credentials, abort.signal))) return fail('unverified');
      try {
        res = await probe();
      } catch {
        return fail(abort.signal.aborted ? 'unverified' : 'cross-origin');
      }
    }
    if (res.type === 'opaque' || res.type === 'opaqueredirect') return fail('cross-origin');
    if (PLAYLIST_TYPE.test(res.headers.get('content-type') ?? '') || PLAYLIST_PATH.test(new URL(res.url || src).pathname)) {
      return fail('unverified');
    }
    return OK;
  } finally {
    clearTimeout(timer);
    // Ends the body downloads: only the responses' headers were needed.
    abort.abort();
  }
}

/** Whether a 'no-cors' request for `src` gets a response (such requests cannot carry a Range header). */
async function reachable(src: string, credentials: RequestCredentials, signal: AbortSignal): Promise<boolean> {
  try {
    await fetch(src, { mode: 'no-cors', credentials, signal });
    return true;
  } catch {
    return false;
  }
}

/**
 * Plays at normal speed with data to play: not paused, seeking, ended or waiting for data, and
 * playbackRate 1 (ToMixer 'playback': only then may look-ahead output continue).
 */
export function isPlayingNormally(el: HTMLMediaElement): boolean {
  return !el.paused && !el.seeking && !el.ended && el.readyState >= HAVE_FUTURE_DATA && el.playbackRate === 1;
}

/** Bytes of audio the element decoded so far (Chrome's webkitAudioDecodedByteCount), or null elsewhere. */
export function decodedAudioBytes(el: HTMLMediaElement): number | null {
  const bytes: unknown = (el as { webkitAudioDecodedByteCount?: unknown }).webkitAudioDecodedByteCount;
  return typeof bytes === 'number' ? bytes : null;
}

/** Whether the media has an audio track (Firefox's mozHasAudio, or audioTracks where supported), or null when unknown. */
export function hasAudioTrack(el: HTMLMediaElement): boolean | null {
  const media = el as { mozHasAudio?: unknown; audioTracks?: { length?: unknown } };
  if (typeof media.mozHasAudio === 'boolean') return media.mozHasAudio;
  const count = media.audioTracks?.length;
  return typeof count === 'number' ? count > 0 : null;
}

/** False when the element is muted or at volume 0: its audio cannot be heard, so it is not processed. */
export function isAudible(el: HTMLMediaElement): boolean {
  return !el.muted && el.volume > 0;
}

/** Started (or about to start) playing audibly: the elements the controller processes. */
export function wantsProcessing(el: HTMLMediaElement): boolean {
  return !el.paused && !el.ended && isAudible(el);
}

/** YouTube's main player (watch page, miniplayer, embeds), as opposed to inline previews and Shorts. */
export function isMainPlayer(el: HTMLMediaElement): boolean {
  return el.closest('#movie_player') !== null;
}

/** On-screen area of a video in CSS pixels (0 for audio elements). */
export function area(el: HTMLMediaElement): number {
  if (!(el instanceof HTMLVideoElement)) return 0;
  const r = el.getBoundingClientRect();
  return Math.max(0, r.width) * Math.max(0, r.height);
}

/** Open shadow roots in the document, including nested ones. Walks every element: call rarely. */
export function findShadowRoots(root: Document | ShadowRoot = document): ShadowRoot[] {
  const out: ShadowRoot[] = [];
  const walk = (node: Document | ShadowRoot) => {
    for (const el of node.querySelectorAll('*')) {
      if (el.shadowRoot) {
        out.push(el.shadowRoot);
        walk(el.shadowRoot);
      }
    }
  };
  walk(root);
  return out;
}

/** Minimum size of a cross-origin frame that may hold a video player (CSS pixels). */
const MIN_PLAYER_WIDTH = 200;
const MIN_PLAYER_HEIGHT = 120;

/**
 * Host of the most likely cross-origin video player frame in the document, or null. Frames are
 * ranked by size; frames that allow fullscreen/autoplay (as embedded players do) rank higher than
 * others such as ads. YouTube frames are skipped: the extension runs in them itself.
 */
export function playerFrameHost(doc: Document = document): string | null {
  let best: { host: string; score: number } | null = null;
  for (const frame of doc.querySelectorAll('iframe')) {
    let url: URL;
    try {
      url = new URL(frame.src);
    } catch {
      continue;
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin === location.origin) continue;
    if (isYouTubeHost(url.hostname)) continue;
    const r = frame.getBoundingClientRect();
    if (r.width < MIN_PLAYER_WIDTH || r.height < MIN_PLAYER_HEIGHT) continue;
    const player = frame.allowFullscreen || /fullscreen|autoplay|encrypted-media/.test(frame.allow);
    const score = r.width * r.height * (player ? 4 : 1);
    if (!best || score > best.score) best = { host: url.hostname, score };
  }
  return best?.host ?? null;
}

/** youtube.com, youtube-nocookie.com and their subdomains (where the YouTube content scripts run). */
export function isYouTubeHost(hostname: string): boolean {
  return /(^|\.)(youtube|youtube-nocookie)\.com$/.test(hostname);
}

/**
 * YouTube hosts where the controller starts by itself (settings.youtubeAuto): the main site,
 * the mobile site and privacy-enhanced embeds. Elsewhere (music., studio., tv.youtube.com) the
 * music is part of the content; the popup's per-tab switch can still turn it on.
 */
export function isYouTubeAutoStartHost(hostname: string): boolean {
  return /^((www|m)\.)?youtube\.com$/.test(hostname) || /(^|\.)youtube-nocookie\.com$/.test(hostname);
}
