// The repository scripts and the dev-server setup: third-party notices (reproducible, not stale,
// covering what a build bundles), fetch-models through a symlinked path, the test-media generator
// and the race-free fixture cache.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'wxt';
import config from '../../wxt.config';
import { bundledPackages, NOTICES, renderNotices } from '../../scripts/notices.mjs';
import { cached } from './helpers/fixtures';

const ROOT = join(import.meta.dirname, '../..');
const HAS_MODEL = existsSync(join(ROOT, 'public/models/Kim_Vocal_2.onnx'));
const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bgmr-scripts-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('third-party notices', () => {
  it('are up to date (run `pnpm make-notices`)', () => {
    expect(readFileSync(join(ROOT, NOTICES), 'utf8') === renderNotices()).toBe(true);
  });

  it('name the versions of the extension and of the bundled packages', () => {
    const notices = readFileSync(join(ROOT, NOTICES), 'utf8');
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(notices.startsWith(`﻿THIRD-PARTY SOFTWARE NOTICES\nRemove Background Music ${version}\n`)).toBe(true);
    const [ort, wxt, wxtBrowser] = bundledPackages();
    expect(notices).toContain(`npm package onnxruntime-web ${ort!.version}`);
    expect(notices).toContain(`ThirdPartyNotices.txt of the v${ort!.version} tag`);
    expect(notices).toContain(`npm packages wxt ${wxt!.version} and @wxt-dev/browser ${wxtBrowser!.version}`);
  });

  it('refuse vendored license texts of another version than the installed one', () => {
    const root = tempDir();
    for (const path of ['package.json', 'scripts', 'vendor']) cpSync(join(ROOT, path), join(root, path), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
    expect(renderNotices(root)).toBe(renderNotices());
    writeFileSync(join(root, 'vendor/onnxruntime-web/VERSION'), '1.29.0\n');
    expect(() => renderNotices(root)).toThrow(
      /vendor\/onnxruntime-web has the texts of onnxruntime-web 1\.29\.0, but \d+\.\d+\.\d+ is installed\. Run `node scripts\/make-notices\.mjs --fetch`\./,
    );
  });

  it.skipIf(!HAS_MODEL)('cover every npm package a build bundles', async () => {
    const outDir = tempDir();
    await build({ root: ROOT, outDir, logger: quietLogger(), vite: () => ({ build: { sourcemap: true } }) });
    const bundled = new Set<string>();
    for (const map of files(outDir).filter((f) => f.endsWith('.map'))) {
      const { sources } = JSON.parse(readFileSync(map, 'utf8')) as { sources: string[] };
      for (const source of sources) {
        // Relative to where the bundler wrote the map, which is not always where it ends up.
        const at = source.indexOf('node_modules/');
        if (at >= 0) bundled.add(packageOf(join(ROOT, source.slice(at))));
      }
    }
    expect([...bundled].sort()).toEqual(bundledPackages().map((p) => `${p.name}@${p.version}`).sort());
  });
});

describe('fetch-models', () => {
  it.skipIf(!HAS_MODEL)('runs when started through a symlinked path', () => {
    const link = join(tempDir(), 'repo');
    symlinkSync(ROOT, link);
    const out = execFileSync(process.execPath, [join(link, 'scripts/fetch-models.mjs')], { cwd: tmpdir(), encoding: 'utf8' });
    expect(out).toContain('✓ Kim_Vocal_2.onnx (cached)');
  });
});

describe('make-test-media', () => {
  const OUTPUTS = ['speech.wav', 'music.wav', 'mix.wav', 'mix.webm', 'mix-aac.mp4', 'video.webm', 'video-only.webm', 'audio-only.webm', 'timeline.json'];

  /** A copy of the script in an empty repository layout; returns [root, run(args, PATH)]. */
  function scratch() {
    const root = tempDir();
    mkdirSync(join(root, 'scripts'));
    cpSync(join(ROOT, 'scripts/make-test-media.mjs'), join(root, 'scripts/make-test-media.mjs'));
    const run = (args: string[], path = process.env.PATH) =>
      spawnSync(process.execPath, [join(root, 'scripts/make-test-media.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, PATH: path } });
    return { root, generated: join(root, 'test/fixtures/generated'), run };
  }

  it('does nothing with --if-missing when every output exists', () => {
    const { generated, run } = scratch();
    mkdirSync(join(generated, 'demux'), { recursive: true });
    for (const f of OUTPUTS) writeFileSync(join(generated, f), 'kept');
    const result = run(['--if-missing'], '');
    expect(result.status).toBe(0);
    expect(OUTPUTS.map((f) => readFileSync(join(generated, f), 'utf8'))).toEqual(OUTPUTS.map(() => 'kept'));
    expect(existsSync(join(generated, 'demux'))).toBe(true);
  });

  it('explains what is missing when it cannot generate', () => {
    const { generated, run } = scratch();
    // No `say` (nor anything else) on the PATH, like on Linux.
    const result = run(['--if-missing'], '');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Generating the test media needs the macOS speech synthesizer (`say`), which is not installed.');
    expect(existsSync(generated)).toBe(false);
  });
});

describe('fixture cache', () => {
  it('moves what `make` wrote into place and leaves no temporary files', () => {
    const dir = tempDir();
    const path = join(dir, 'derived/out.wav');
    let made = 0;
    const make = (tmp: string) => {
      made++;
      expect(tmp).not.toBe(path);
      expect(tmp.endsWith('/out.wav')).toBe(true); // Same name: ffmpeg picks the format from it.
      writeFileSync(tmp, 'data');
    };
    expect(cached(path, make)).toBe(path);
    expect(cached(path, make)).toBe(path);
    expect(made).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe('data');
    expect(readdirSync(join(dir, 'derived'))).toEqual(['out.wav']);
  });

  it('leaves nothing at the path when `make` fails', () => {
    const dir = tempDir();
    const path = join(dir, 'out.wav');
    expect(() =>
      cached(path, (tmp) => {
        writeFileSync(tmp, 'partial');
        throw new Error('ffmpeg failed');
      }),
    ).toThrow('ffmpeg failed');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps the directory another test file made meanwhile', () => {
    const dir = tempDir();
    const path = join(dir, 'dash');
    cached(path, (tmp) => {
      mkdirSync(tmp);
      writeFileSync(join(tmp, 'seg-001.m4s'), 'mine');
      // Another worker finishes first.
      mkdirSync(path);
      writeFileSync(join(path, 'seg-001.m4s'), 'theirs');
    });
    expect(readFileSync(join(path, 'seg-001.m4s'), 'utf8')).toBe('theirs');
    expect(readdirSync(dir)).toEqual(['dash']);
  });
});

describe('dev server', () => {
  it('lets the extension pages embed its stylesheets under COEP, which builds keep', async () => {
    expect(config.manifest).toMatchObject({ cross_origin_embedder_policy: { value: 'require-corp' } });
    const vite = await config.vite!({ mode: 'development', command: 'serve', browser: 'chrome', manifestVersion: 3 });
    expect(vite.server?.headers).toEqual({ 'Cross-Origin-Resource-Policy': 'cross-origin' });
  });

  it('serves ONNX Runtime from its package, next to the WASM loader it imports', async () => {
    const vite = await config.vite!({ mode: 'development', command: 'serve', browser: 'chrome', manifestVersion: 3 });
    expect(vite.optimizeDeps?.exclude).toContain('onnxruntime-web');
  });
});

/** Every file under `dir`. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** name@version of the npm package a bundled source file belongs to. */
function packageOf(source: string): string {
  for (let dir = dirname(source); dir !== dirname(dir); dir = dirname(dir)) {
    const path = join(dir, 'package.json');
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { name?: string; version?: string };
    if (pkg.name) return `${pkg.name}@${pkg.version}`;
  }
  throw new Error(`${source}: no package.json`);
}

function quietLogger() {
  const silent = () => {};
  return { debug: silent, log: silent, info: silent, warn: silent, error: console.error, fatal: console.error, success: silent, level: 0 };
}
