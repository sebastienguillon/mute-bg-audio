// The build configuration of wxt.config.ts for each look-ahead model (LOOKAHEAD_MODEL): the build's
// model is required and verified (and no other), no other file of public/models is packaged, the
// build's notices are packaged as THIRD_PARTY_NOTICES.txt, and the output directory, zip name and
// the model constant of the code tell the builds apart.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedPublicFile, UserConfig, Wxt, WxtHooks } from 'wxt';
import { lookaheadBuild } from '../../scripts/models.mjs';

const ROOT = join(import.meta.dirname, '../..');
const dirs: string[] = [];

/** wxt.config.ts as it loads with LOOKAHEAD_MODEL=model. */
async function configFor(model: 'kim' | 'scnet'): Promise<UserConfig> {
  const saved = process.env.LOOKAHEAD_MODEL;
  process.env.LOOKAHEAD_MODEL = model;
  try {
    vi.resetModules();
    return (await import('../../wxt.config')).default;
  } finally {
    if (saved === undefined) delete process.env.LOOKAHEAD_MODEL;
    else process.env.LOOKAHEAD_MODEL = saved;
  }
}

// Declared flat ('build:before'), so the nested-hooks type of the config can be narrowed.
const hooksOf = (config: UserConfig) => config.hooks as Partial<WxtHooks>;

function fakeWxt(publicDir: string) {
  const warn = vi.fn();
  return { wxt: { config: { publicDir }, logger: { warn } } as unknown as Wxt, warn };
}

/** A public directory with `files` (name → content) in models/. */
function publicDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgmr-public-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'models'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, 'models', name), content);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FIX = {
  kim: 'Run `pnpm fetch-models`.',
  scnet: 'It is committed to the repository: restore it with `git checkout public/models/scnet_vocals.onnx` (see vendor/scnet/README.md).',
};

describe.each(['kim', 'scnet'] as const)('the %s build', (model) => {
  const { file, suffix } = lookaheadBuild(model);
  const other = model === 'kim' ? 'scnet_vocals.onnx' : 'Kim_Vocal_2.onnx';

  describe('build:before', () => {
    it('fails when its look-ahead model is missing, even with the other one present', async () => {
      const hooks = hooksOf(await configFor(model));
      await expect(hooks['build:before']!(fakeWxt(publicDir({ [other]: 'other model' })).wxt)).rejects.toThrow(
        `public/models/${file} is missing. ${FIX[model]}`,
      );
    });

    it('fails when the model is not the expected file', async () => {
      const hooks = hooksOf(await configFor(model));
      await expect(hooks['build:before']!(fakeWxt(publicDir({ [file]: 'truncated download' })).wxt)).rejects.toThrow(
        new RegExp(`${file.replace('.', '\\.')} is not the expected file \\(SHA-256 [0-9a-f]{64}\\)\\. `),
      );
    });

    it.skipIf(!existsSync(join(ROOT, 'public/models', file)))('accepts the model alone (without the other build\'s)', async () => {
      const hooks = hooksOf(await configFor(model));
      const dir = publicDir();
      copyFileSync(join(ROOT, 'public/models', file), join(dir, 'models', file));
      await expect(hooks['build:before']!(fakeWxt(dir).wxt)).resolves.toBeUndefined();
    });
  });

  describe('build:publicAssets', () => {
    it('packages only its model, and its notices as THIRD_PARTY_NOTICES.txt', async () => {
      const hooks = hooksOf(await configFor(model));
      const { wxt, warn } = fakeWxt('/p');
      const entry = (relativeDest: string): ResolvedPublicFile => ({ absoluteSrc: `/p/${relativeDest}`, relativeDest });
      const files = [
        'icon/16.png',
        'models/Kim_Vocal_2.onnx',
        'models/UVR-MDX-NET-Voc_FT.onnx',
        'THIRD_PARTY_NOTICES.txt',
        'models/scnet_vocals.onnx',
        'THIRD_PARTY_NOTICES-scnet.txt',
        'dfn/df_bg.wasm',
        'models/x.part',
      ].map(entry);
      await hooks['build:publicAssets']!(wxt, files);
      expect(files).toEqual([
        entry('icon/16.png'),
        entry(`models/${file}`),
        { absoluteSrc: `/p/THIRD_PARTY_NOTICES${suffix}.txt`, relativeDest: 'THIRD_PARTY_NOTICES.txt' },
        entry('dfn/df_bg.wasm'),
      ]);
      // The other build's model is left out silently; anything else with a warning.
      expect(warn.mock.calls.map((c) => c[0])).toEqual(
        ['models/x.part', 'models/UVR-MDX-NET-Voc_FT.onnx'].map((path) => `Not packaging public/${path}: only public/models/${file} is shipped.`),
      );
    });
  });

  it(`writes to .output/chrome-mv3${suffix} and <name>-<version>-chrome${suffix}.zip, and tells the code its model`, async () => {
    const config = await configFor(model);
    expect(config.outDirTemplate).toBe(`{{browser}}-mv{{manifestVersion}}{{modeSuffix}}${suffix}`);
    expect(config.zip?.artifactTemplate).toBe(`{{name}}-{{packageVersion}}-{{browser}}{{modeSuffix}}${suffix}.zip`);
    const vite = await config.vite!({ mode: 'production', command: 'build', browser: 'chrome', manifestVersion: 3 });
    expect(vite.define).toEqual({ 'import.meta.env.LOOKAHEAD_MODEL': JSON.stringify(model) });
  });
});

it('starts every tab with the off icon, and has the images of both toolbar icons', async () => {
  const { ACTION_ICON_PATHS } = await import('../../src/lib/tab-status');
  const manifest = (await configFor('kim')).manifest as { action: { default_icon: Record<number, string> } };
  expect(Object.fromEntries(Object.entries(manifest.action.default_icon).map(([size, path]) => [size, `/${path}`]))).toEqual(ACTION_ICON_PATHS.off);
  for (const path of Object.values(ACTION_ICON_PATHS).flatMap((paths) => Object.values(paths))) {
    expect(existsSync(join(ROOT, 'public', path)), path).toBe(true);
  }
});

it('LOOKAHEAD_MODEL must name a build', async () => {
  await expect(configFor('mdx' as 'kim')).rejects.toThrow('LOOKAHEAD_MODEL must be kim or scnet, not "mdx".');
});
