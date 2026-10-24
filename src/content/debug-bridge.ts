// Page-facing debug bridge used by the end-to-end tests. Only development and test builds include
// it (callers guard it with import.meta.env.MODE !== 'production'); a page opts in by setting
// <html data-bgmr-debug="1">.
//
//   window.postMessage({ __bgmr_debug: 'status' })            → { __bgmr_debug_reply: 'status', ...DebugSnapshot }
//   window.postMessage({ __bgmr_debug: 'record', seconds })   → { __bgmr_debug_reply: 'recording', input, output }
//                                                               or { __bgmr_debug_reply: 'recording', error }
import type { FromMixer } from '@/lib/protocol';

export type DebugRecording = Extract<FromMixer, { type: 'debug-recording' }>;

export interface DebugTarget {
  debugSnapshot(): Record<string, unknown>;
  /** Resolves with the mixer's recording, or rejects when the mixer is not in the audio path. */
  debugRecord(seconds: number): Promise<DebugRecording>;
}

const enabled = () => document.documentElement?.dataset.bgmrDebug === '1';

/** Answers the page's debug requests for the page's lifetime (also after the controller shut down). */
export function installDebugBridge(target: DebugTarget): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window || !enabled()) return;
    const d = e.data as { __bgmr_debug?: unknown; seconds?: unknown } | null;
    if (!d || typeof d.__bgmr_debug !== 'string') return;
    if (d.__bgmr_debug === 'record' && typeof d.seconds === 'number') {
      target.debugRecord(d.seconds).then(
        (m) => window.postMessage({ __bgmr_debug_reply: 'recording', input: m.input, output: m.output }, '*'),
        (err: unknown) => window.postMessage({ __bgmr_debug_reply: 'recording', error: String(err) }, '*'),
      );
    } else if (d.__bgmr_debug === 'status') {
      window.postMessage({ __bgmr_debug_reply: 'status', ...target.debugSnapshot() }, '*');
    }
  });
}

/** Mirrors the last published status into <html data-bgmr-status> for pages that opted in. */
export function mirrorDebugStatus(json: string): void {
  if (enabled()) document.documentElement.dataset.bgmrStatus = json;
}
