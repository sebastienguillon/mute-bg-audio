import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'wxt';
import { lookaheadBuild, MODELS, sha256File } from './scripts/models.mjs';

/**
 * The look-ahead model of this build: LOOKAHEAD_MODEL=kim (default, Kim_Vocal_2) or scnet. The code
 * gets its name as import.meta.env.LOOKAHEAD_MODEL; other builds than the default one go to their
 * own output directory and zip (.output/chrome-mv3-scnet, mute-bg-audio-<version>-chrome-scnet.zip).
 */
const BUILD = lookaheadBuild();
/** Its model file, the only file of public/models that is packaged. */
const MODEL = BUILD.file;
/** Packaged as THIRD_PARTY_NOTICES.txt: the notices of this build (scripts/notices.mjs). */
const NOTICES = `THIRD_PARTY_NOTICES${BUILD.suffix}.txt`;

// Chrome-only (Manifest V3). See README.md for the architecture.
export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  targetBrowsers: ['chrome'],
  outDirTemplate: `{{browser}}-mv{{manifestVersion}}{{modeSuffix}}${BUILD.suffix}`,
  zip: { artifactTemplate: `{{name}}-{{packageVersion}}-{{browser}}{{modeSuffix}}${BUILD.suffix}.zip` },
  manifest: {
    name: 'Mute BG Audio',
    description: 'Turns down or removes background music in videos while keeping the voices. Runs entirely on your device.',
    // 137: WebAssembly JSPI (ONNX Runtime Web JSPI build).
    minimum_chrome_version: '137',
    permissions: ['storage', 'activeTab', 'scripting', 'tabCapture', 'offscreen'],
    host_permissions: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
    optional_host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    // Lets the engine iframe start its workers inside pages that are cross-origin isolated
    // (COEP: require-corp). Extension pages only load their own resources, so nothing else changes.
    cross_origin_embedder_policy: { value: 'require-corp' },
    web_accessible_resources: [
      {
        // The engine iframe and the AudioWorklet module are loaded by web pages.
        resources: ['engine.html', 'worklet.js'],
        matches: ['<all_urls>'],
      },
    ],
    action: { default_title: 'Mute BG Audio' },
  },
  // `pnpm dev` only (builds use neither): the extension pages load their scripts and styles from
  // the dev server. Scripts are CORS requests, but stylesheets are not, so under the pages' COEP
  // the server must allow them to be embedded cross-origin. ONNX Runtime imports its WASM loader
  // next to its own module, which Vite's dependency pre-bundling would move away from it.
  vite: () => ({
    define: { 'import.meta.env.LOOKAHEAD_MODEL': JSON.stringify(BUILD.name) },
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    server: { headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' } },
  }),
  hooks: {
    // Every build packages exactly its verified look-ahead model: never none (look-ahead would
    // fail for every user), never another build's model or the comparison model the tests use,
    // and the notices of what it contains.
    'build:before': (wxt) => verifyModel(join(wxt.config.publicDir, 'models', MODEL)),
    'build:publicAssets': (wxt, files) => {
      for (let i = files.length - 1; i >= 0; i--) {
        const file = files[i]!;
        const path = file.relativeDest.replaceAll('\\', '/');
        if (/^THIRD_PARTY_NOTICES(-[a-z]+)?\.txt$/.test(path)) {
          if (path === NOTICES) file.relativeDest = 'THIRD_PARTY_NOTICES.txt';
          else files.splice(i, 1);
          continue;
        }
        if (!path.startsWith('models/') || path === `models/${MODEL}`) continue;
        // The other builds' models are expected there (scnet_vocals.onnx is committed): no warning.
        const other = MODELS[path.slice('models/'.length) as keyof typeof MODELS]?.build;
        if (!other) wxt.logger.warn(`Not packaging public/${path}: only public/models/${MODEL} is shipped.`);
        files.splice(i, 1);
      }
    },
  },
});

/** Fails the build (before bundling) unless `path` is the expected model file. */
async function verifyModel(path: string): Promise<void> {
  const fix = MODELS[MODEL].url
    ? 'Run `pnpm fetch-models`.'
    : `It is committed to the repository: restore it with \`git checkout public/models/${MODEL}\` (see vendor/scnet/README.md).`;
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`public/models/${MODEL} is missing. ${fix}`);
  const hash = await sha256File(path);
  if (hash !== MODELS[MODEL].sha256) {
    throw new Error(`public/models/${MODEL} is not the expected file (SHA-256 ${hash}). ${fix}`);
  }
}
