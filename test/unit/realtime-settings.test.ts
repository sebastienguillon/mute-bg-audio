// Compares DeepFilterNet settings on the generated speech-over-music fixture (informational,
// with loose quality floors). Run with --reporter=verbose to see the table.
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE } from '../../src/lib/constants';
import type { DfnOptions } from '../../src/lib/realtime/dfn';
import { complement, energyRatioDb, interferenceArtifacts, loadFixtures, siSdr } from './helpers/realtime-audio';
import { Recorder, reassemble } from './helpers/realtime-harness';

const CONFIGS: Array<{ name: string; opts: Required<DfnOptions> }> = [
  { name: 'beta 0, lim 100 (default)', opts: { postFilterBeta: 0, attenLimDb: 100 } },
  { name: 'beta 0.02, lim 100', opts: { postFilterBeta: 0.02, attenLimDb: 100 } },
  { name: 'beta 0.05, lim 100', opts: { postFilterBeta: 0.05, attenLimDb: 100 } },
  { name: 'beta 0, lim 30', opts: { postFilterBeta: 0, attenLimDb: 30 } },
  { name: 'beta 0, lim 18', opts: { postFilterBeta: 0, attenLimDb: 18 } },
];

describe('DeepFilterNet settings on speech over music', () => {
  it('keeps SI-SDR ≥ 11 dB without an attenuation limit, with or without post-filter', () => {
    const fx = loadFixtures();
    const length = fx.mix.length;
    const inSpeech = new Uint8Array(length);
    for (const [start, end] of fx.speechRegions) inSpeech.fill(1, start, end);
    const musicOnly = complement(fx.speechRegions, length, SAMPLE_RATE / 10);

    const rows: string[] = [];
    const scores = new Map<string, number>();
    for (const { name, opts } of CONFIGS) {
      const rec = Recorder.create(opts);
      rec.sendRange(fx.mix, 0, length);
      const { estimate, covered } = reassemble(rec.speech, length);
      const speechMask = covered.map((c, i) => c & inSpeech[i]!);
      const all = siSdr(estimate, fx.speech, covered);
      const { sir, sar } = interferenceArtifacts(estimate, fx.speech, fx.music, speechMask);
      const leakage = energyRatioDb(estimate, fx.mix, musicOnly);
      scores.set(name, all);
      rows.push(
        `${name.padEnd(26)} SI-SDR ${all.toFixed(2)} dB | during speech: SIR ${sir.toFixed(1)} dB, SAR ${sar.toFixed(1)} dB | ` +
          `music-only passages: ${Number.isFinite(leakage) ? `${leakage.toFixed(1)} dB` : 'exact silence'}`,
      );
    }
    console.info(`mixture SI-SDR ${siSdr(fx.mix, fx.speech).toFixed(2)} dB\n${rows.join('\n')}`);
    for (const { name, opts } of CONFIGS) {
      if (opts.attenLimDb === 100) expect(scores.get(name)).toBeGreaterThanOrEqual(11);
    }
  });
});
