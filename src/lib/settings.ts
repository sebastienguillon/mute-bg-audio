import { REMOVE_DB } from './constants';

export type Quality = 'auto' | 'realtime';

export interface Settings {
  /** Master switch. */
  enabled: boolean;
  /** Start automatically on YouTube pages. */
  youtubeAuto: boolean;
  /** Music reduction in dB; REMOVE_DB (60) or more means "remove completely". */
  reductionDb: number;
  /** Lower the residual further while nobody is speaking. */
  gapReduction: boolean;
  /** 'auto' uses the look-ahead GPU model when possible; 'realtime' forces the CPU model. */
  quality: Quality;
  /** Origins (e.g. "https://vimeo.com") where the extension starts automatically. */
  autoSites: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  youtubeAuto: true,
  reductionDb: 18,
  gapReduction: true,
  quality: 'auto',
  autoSites: [],
};

/** Linear residual gain for a reduction in dB. */
export function reductionGain(reductionDb: number): number {
  if (!(reductionDb > 0)) return 1;
  if (reductionDb >= REMOVE_DB) return 0;
  return Math.pow(10, -reductionDb / 20);
}

/** Slider positions shown in the popup (dB). The last one means "remove". */
export const REDUCTION_STEPS = [0, 3, 6, 9, 12, 15, 18, 21, 24, 30, 36, REMOVE_DB];

export function normalizeSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : DEFAULT_SETTINGS.enabled,
    youtubeAuto: typeof r.youtubeAuto === 'boolean' ? r.youtubeAuto : DEFAULT_SETTINGS.youtubeAuto,
    reductionDb: Math.min(REMOVE_DB, Math.max(0, num(r.reductionDb, DEFAULT_SETTINGS.reductionDb))),
    gapReduction: typeof r.gapReduction === 'boolean' ? r.gapReduction : DEFAULT_SETTINGS.gapReduction,
    quality: r.quality === 'realtime' ? 'realtime' : 'auto',
    autoSites: Array.isArray(r.autoSites) ? r.autoSites.filter((s): s is string => typeof s === 'string') : [],
  };
}
