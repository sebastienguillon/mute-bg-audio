// Pure helpers for the tab status reported by the page controller.
import { SAMPLE_RATE } from '@/lib/constants';
import type { MixerStats, TabStatus } from '@/lib/protocol';

/**
 * Change key of a status: the fast-changing look-ahead figures are bucketed (aheadSeconds to 5 s,
 * rtf to 0.05), so a playing tab does not report every 250 ms. The report itself keeps the exact
 * values.
 */
export function statusKey(status: TabStatus): string {
  const la = status.lookahead;
  if (!la) return JSON.stringify(status);
  return JSON.stringify({
    ...status,
    lookahead: {
      ...la,
      aheadSeconds: la.aheadSeconds === undefined ? undefined : Math.round(la.aheadSeconds / 5) * 5,
      rtf: la.rtf === undefined ? undefined : Math.round(la.rtf * 20) / 20,
    },
  });
}

/** Tab mode, latency and detail for what the mixer reports about the current element. */
export function mixerStatus(
  stats: MixerStats,
  paused: boolean,
  realtimeError: string | null,
): Pick<TabStatus, 'mode' | 'detail' | 'latencyMs'> {
  const latencyMs = Math.round((stats.latency / SAMPLE_RATE) * 1000);
  switch (stats.mode) {
    case 'lookahead':
    case 'realtime':
      return { mode: stats.mode, latencyMs };
    case 'idle':
      return { mode: 'waiting', detail: paused ? 'Paused.' : 'No sound.' };
    case 'passthrough':
      return realtimeError ? { mode: 'passthrough', latencyMs, detail: realtimeError } : { mode: 'passthrough', latencyMs };
    case 'bypass':
      // Enabled, but the mixer has not left bypass yet.
      return { mode: 'starting' };
  }
}
