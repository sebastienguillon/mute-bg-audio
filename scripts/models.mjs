// The separation models: download sources and SHA-256 of each file. scripts/fetch-models.mjs
// downloads them; wxt.config.ts checks the packaged one at build time.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

// UVR MDX-Net vocal models (Ultimate Vocal Remover; see public/THIRD_PARTY_NOTICES.txt).
// Parameters from UVR's model_data.json (keyed by the MD5 of the last 10 MB of the file).
export const MODELS = {
  'Kim_Vocal_2.onnx': {
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
    sha256: 'ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b',
    packaged: true,
  },
  'UVR-MDX-NET-Voc_FT.onnx': {
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Voc_FT.onnx',
    sha256: '534b2070fcc7df514b13ef660dc8cbb328679c2374d04354a5c42bb14ecce111',
    packaged: false,
  },
};

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
