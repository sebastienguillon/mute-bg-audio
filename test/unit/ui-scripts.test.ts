// The repository scripts and the dev-server setup: third-party notices of each build (reproducible,
// not stale, describing the model the build contains and covering what it bundles), the model
// choice of the package.json scripts in any shell, fetch-models through a symlinked path, the
// test-media generator and the race-free fixture cache.
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'wxt';
import config from '../../wxt.config';
import { LOOKAHEAD_MODELS, lookaheadBuild, MODELS } from '../../scripts/models.mjs';
import { bundledPackages, NOTICES, noticesFile, renderNotices } from '../../scripts/notices.mjs';
import { cached } from './helpers/fixtures';

const ROOT = join(import.meta.dirname, '../..');
const HAS_MODEL = existsSync(join(ROOT, 'public/models/Kim_Vocal_2.onnx'));
const hasModel = (model: 'kim' | 'scnet') => existsSync(join(ROOT, 'public/models', lookaheadBuild(model).file));
const dirs: string[] = [];

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bgmr-scripts-')));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.each(LOOKAHEAD_MODELS)('third-party notices of the %s build', (model) => {
  const path = join(ROOT, noticesFile(model));

  it('are up to date (run `pnpm make-notices`)', () => {
    expect(readFileSync(path, 'utf8') === renderNotices(ROOT, model)).toBe(true);
  });

  it('name the versions of the extension and of the bundled packages', () => {
    const notices = readFileSync(path, 'utf8');
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(notices.startsWith(`﻿THIRD-PARTY SOFTWARE NOTICES\nMute BG Audio ${version}\n`)).toBe(true);
    const [ort, wxt, wxtBrowser] = bundledPackages();
    expect(notices).toContain(`npm package onnxruntime-web ${ort!.version}`);
    expect(notices).toContain(`ThirdPartyNotices.txt of the v${ort!.version} tag`);
    expect(notices).toContain(`npm packages wxt ${wxt!.version} and @wxt-dev/browser ${wxtBrowser!.version}`);
  });

  it('describe the look-ahead model the build contains, and no other', () => {
    const notices = readFileSync(path, 'utf8');
    const { file } = lookaheadBuild(model);
    expect(notices).toContain(`File: models/${file} (SHA-256 ${MODELS[file].sha256})`);
    if (model === 'kim') {
      expect(notices).toContain('5. UVR MDX-Net vocal model Kim_Vocal_2');
      expect(notices).not.toMatch(/scnet|starrytong/i);
    } else {
      const source = JSON.parse(readFileSync(join(ROOT, 'vendor/scnet/source.json'), 'utf8')) as { commit: string; licenseGrant: string };
      // SCNet's MIT license with its copyright line, and the attribution.
      const license = readFileSync(join(ROOT, 'vendor/scnet/LICENSE'), 'utf8').trimEnd();
      expect(license).toContain('Copyright (c) 2024 starrytong');
      expect(notices).toContain(`${license}\n`);
      expect(notices).toContain('  5. SCNet vocal model (SCNet base) .......................... MIT');
      expect(notices).toContain(`https://github.com/starrytong/SCNet, commit ${source.commit}`);
      expect(notices).toContain(source.licenseGrant);
      expect(notices).not.toMatch(/Kim_Vocal_2|MDX-Net|UVR/);
    }
  });
});

describe('third-party notices', () => {
  it('of the default build are public/THIRD_PARTY_NOTICES.txt', () => {
    expect(noticesFile()).toBe(NOTICES);
    expect(noticesFile('scnet')).toBe('public/THIRD_PARTY_NOTICES-scnet.txt');
  });

  it('refuse vendored license texts of another version than the installed one', () => {
    const root = tempDir();
    for (const path of ['package.json', 'scripts', 'vendor']) cpSync(join(ROOT, path), join(root, path), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
    expect(renderNotices(root)).toBe(renderNotices());
    expect(renderNotices(root, 'scnet')).toBe(renderNotices(ROOT, 'scnet'));
    writeFileSync(join(root, 'vendor/onnxruntime-web/VERSION'), '1.29.0\n');
    expect(() => renderNotices(root)).toThrow(
      /vendor\/onnxruntime-web has the texts of onnxruntime-web 1\.29\.0, but \d+\.\d+\.\d+ is installed\. Run `node scripts\/make-notices\.mjs --fetch`\./,
    );
  });

});

// A production build of each look-ahead model (with source maps).
describe.each(LOOKAHEAD_MODELS)('the %s build', (model) => {
  const { file, suffix } = lookaheadBuild(model);
  const other = LOOKAHEAD_MODELS.filter((m) => m !== model).map((m) => lookaheadBuild(m).file);
  /** WXT's outDir: the build goes into a directory of it named by outDirTemplate. */
  let outBase = '';
  let outDir = '';

  beforeAll(async () => {
    if (!hasModel(model)) return;
    outBase = realpathSync(mkdtempSync(join(tmpdir(), 'bgmr-build-')));
    outDir = join(outBase, `chrome-mv3${suffix}`);
    const saved = process.env.LOOKAHEAD_MODEL;
    // wxt.config.ts reads it each time a build loads it.
    process.env.LOOKAHEAD_MODEL = model;
    try {
      await build({ root: ROOT, outDir: outBase, logger: quietLogger(), vite: () => ({ build: { sourcemap: true } }) });
    } finally {
      if (saved === undefined) delete process.env.LOOKAHEAD_MODEL;
      else process.env.LOOKAHEAD_MODEL = saved;
    }
  }, 240_000);

  afterAll(() => {
    if (outBase) rmSync(outBase, { recursive: true, force: true });
  });

  it.skipIf(!hasModel(model))(`goes to chrome-mv3${suffix} and contains exactly its model and its notices`, () => {
    expect(readdirSync(outBase)).toEqual([`chrome-mv3${suffix}`]);
    expect(readdirSync(join(outDir, 'models'))).toEqual([file]);
    expect(readFileSync(join(outDir, 'THIRD_PARTY_NOTICES.txt'), 'utf8') === readFileSync(join(ROOT, noticesFile(model)), 'utf8')).toBe(true);
    expect(files(outDir).filter((f) => /THIRD_PARTY_NOTICES/.test(f)).map((f) => f.slice(outDir.length + 1))).toEqual(['THIRD_PARTY_NOTICES.txt']);
    // Only the selected model's code: the scripts do not name the other model's file.
    const scripts = files(outDir).filter((f) => f.endsWith('.js'));
    const mentions = (name: string) => scripts.filter((f) => readFileSync(f, 'utf8').includes(name)).map((f) => f.slice(outDir.length + 1));
    expect(mentions(file)).toEqual([expect.stringMatching(/lookahead\.worker/)]);
    for (const name of other) expect(mentions(name)).toEqual([]);
  });

  it.skipIf(!hasModel(model))('is covered by the notices for every npm package it bundles', () => {
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

describe('package.json scripts', () => {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const withModel = (...args: string[]) =>
    spawnSync(process.execPath, [join(ROOT, 'scripts/with-model.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, LOOKAHEAD_MODEL: 'kim' } });

  it('set no environment variables with shell syntax (pnpm runs them with cmd.exe on Windows)', () => {
    expect(Object.entries(scripts).filter(([, line]) => /(^|&&|\|\||;)\s*[A-Za-z_]\w*=/.test(line))).toEqual([]);
    for (const name of ['build:scnet', 'build:e2e:scnet', 'zip:scnet', 'test:e2e:scnet']) {
      expect(scripts[name]).toMatch(/(^|&& )node scripts\/with-model\.mjs scnet (wxt|playwright) /);
    }
  });

  it("choose the model through scripts/with-model.mjs: the command runs with LOOKAHEAD_MODEL set, its exit status is the script's", () => {
    const echo = withModel('scnet', process.execPath, '-e', 'process.stdout.write(`${process.env.LOOKAHEAD_MODEL} ${JSON.stringify(process.argv.slice(1))}`)', 'a b', 'c"d');
    expect(echo.status).toBe(0);
    expect(echo.stdout).toBe('scnet ["a b","c\\"d"]');
    expect(withModel('scnet', process.execPath, '-e', 'process.exit(3)').status).toBe(3);
    expect(withModel('scnet', 'bgmr-no-such-command').status).toBe(1);
    const usage = withModel('scnet');
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('Usage: node scripts/with-model.mjs <kim|scnet> <command> [args...]');
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
