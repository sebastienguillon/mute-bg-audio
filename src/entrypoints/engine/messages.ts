// Messages between the engine page and its workers (internal to the engine iframe).
import type { EngineIn, LookaheadStatus } from '@/lib/protocol';
import type { Settings } from '@/lib/settings';

export type ToRealtimeWorker = { type: 'connect' }; // transfers [port]

export type FromRealtimeWorker = { type: 'rt-status'; ready: boolean; rtf?: number; error?: string };

export type ToLookaheadWorker =
  | { type: 'init'; settings: Settings }
  | { type: 'connect' } // transfers [port]
  | { type: 'settings'; settings: Settings }
  | Extract<EngineIn, { type: 'hook' | 'active-timeline' | 'playhead' }>;

export type FromLookaheadWorker = { type: 'la-status'; status: LookaheadStatus };
