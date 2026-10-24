import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'wxt';
import { MODELS, sha256File } from './scripts/models.mjs';

/** The look-ahead model, the only file of public/models that is packaged. */
const MODEL = 'Kim_Vocal_2.onnx';

// Chrome-only (Manifest V3). See README.md for the architecture.
export default defineConfig({
  srcDir: 'src',
  manifestVersion: 3,
  targetBrowsers: ['chrome'],
  manifest: {
    name: 'Remove Background Music',
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
    action: { default_title: 'Remove Background Music' },
  },
  // `pnpm dev` only (builds use neither): the extension pages load their scripts and styles from
  // the dev server. Scripts are CORS requests, but stylesheets are not, so under the pages' COEP
  // the server must allow them to be embedded cross-origin. ONNX Runtime imports its WASM loader
  // next to its own module, which Vite's dependency pre-bundling would move away from it.
  vite: () => ({
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    server: { headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' } },
  }),
  hooks: {
    // Every build packages exactly the verified look-ahead model: never none (look-ahead would
    // fail for every user) and never the comparison model the tests use.
    'build:before': (wxt) => verifyModel(join(wxt.config.publicDir, 'models', MODEL)),
    'build:publicAssets': (wxt, files) => {
      for (let i = files.length - 1; i >= 0; i--) {
        const path = files[i]!.relativeDest.replaceAll('\\', '/');
        if (!path.startsWith('models/') || path === `models/${MODEL}`) continue;
        wxt.logger.warn(`Not packaging public/${path}: only public/models/${MODEL} is shipped.`);
        files.splice(i, 1);
      }
    },
  },
});

/** Fails the build (before bundling) unless `path` is the expected model file. */
async function verifyModel(path: string): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new Error(`public/models/${MODEL} is missing. Run \`pnpm fetch-models\`.`);
  const hash = await sha256File(path);
  if (hash !== MODELS[MODEL].sha256) {
    throw new Error(`public/models/${MODEL} is not the expected file (SHA-256 ${hash}). Run \`pnpm fetch-models\`.`);
  }
}
