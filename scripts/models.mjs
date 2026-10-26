// The separation models: where each file comes from, its SHA-256 and the build that packages it.
// scripts/fetch-models.mjs downloads the ones with a URL; wxt.config.ts checks the packaged one at
// build time.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// UVR MDX-Net vocal models (Ultimate Vocal Remover) and SCNet (vendor/scnet/); see the
// THIRD_PARTY_NOTICES files. MDX-Net parameters from UVR's model_data.json (keyed by the MD5 of the
// last 10 MB of the file).
export const MODELS = {
  'Kim_Vocal_2.onnx': {
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
    sha256: 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
    build: 'kim',
  },
  'UVR-MDX-NET-Voc_FT.onnx': {
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx',
    sha256: '534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111',
    build: null,
  },
  // Committed (public/models/scnet_vocals.onnx), made by vendor/scnet/.
  'scnet_vocals.onnx': {
    url: null,
    sha256: '8ce631f3fdee6727f304b74654f4993b6d626dba9fc07a58f1ebc9a5efce5a00',
    build: 'scnet',
  },
};

/** Values of LOOKAHEAD_MODEL, the look-ahead model a build packages (the first is the default). */
export const LOOKAHEAD_MODELS = ['kim', 'scnet'];

/**
 * The build LOOKAHEAD_MODEL selects (the default when unset or empty): its name, model file and
 * the suffix of its output directory and zip ('' for the default build).
 */
export function lookaheadBuild(value = process.env.LOOKAHEAD_MODEL) {
  const name = value || LOOKAHEAD_MODELS[0];
  const file = LOOKAHEAD_MODELS.includes(name) ? Object.keys(MODELS).find((f) => MODELS[f].build === name) : undefined;
  if (!file) throw new Error(`LOOKAHEAD_MODEL must be ${LOOKAHEAD_MODELS.join(' or ')}, not "${value}".`);
  return { name, file, suffix: name === LOOKAHEAD_MODELS[0] ? '' : `-${name}` };
}

/** SHA-256 (hex) of a file, streamed. */
export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}
