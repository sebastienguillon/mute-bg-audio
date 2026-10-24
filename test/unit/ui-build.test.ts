// The build hooks of wxt.config.ts: the packaged look-ahead model is required and verified, and no
// other file of public/models is packaged.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedPublicFile, Wxt, WxtHooks } from 'wxt';
import config from '../../wxt.config';

const ROOT = join(import.meta.dirname, '../..');
// Declared flat ('build:before'), so the nested-hooks type of the config can be narrowed.
const hooks = config.hooks as Partial<WxtHooks>;
const dirs: string[] = [];

function fakeWxt(publicDir: string) {
  const warn = vi.fn();
  return { wxt: { config: { publicDir }, logger: { warn } } as unknown as Wxt, warn };
}

function publicDir(model?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgmr-public-'));
  dirs.push(dir);
  if (model !== undefined) {
    mkdirSync(join(dir, 'models'));
    writeFileSync(join(dir, 'models/Kim_Vocal_2.onnx'), model);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('build:before', () => {
  it('fails when the look-ahead model is missing', async () => {
    await expect(hooks['build:before']!(fakeWxt(publicDir()).wxt)).rejects.toThrow(
      'public/models/Kim_Vocal_2.onnx is missing. Run `pnpm fetch-models`.',
    );
  });

  it('fails when the model is not the expected file', async () => {
    await expect(hooks['build:before']!(fakeWxt(publicDir('truncated download')).wxt)).rejects.toThrow(
      /Kim_Vocal_2\.onnx is not the expected file \(SHA-256 [0-9a-f]{64}\)/,
    );
  });

  it.skipIf(!existsSync(join(ROOT, 'public/models/Kim_Vocal_2.onnx')))('accepts the fetched model', async () => {
    await expect(hooks['build:before']!(fakeWxt(join(ROOT, 'public')).wxt)).resolves.toBeUndefined();
  });
});

describe('build:publicAssets', () => {
  it('packages no other file of public/models', async () => {
    const { wxt, warn } = fakeWxt('/p');
    const file = (relativeDest: string): ResolvedPublicFile => ({ absoluteSrc: `/p/${relativeDest}`, relativeDest });
    const files = ['icon/16.png', 'models/Kim_Vocal_2.onnx', 'models/UVR-MDX-NET-Voc_FT.onnx', 'dfn/df_bg.wasm', 'models/x.part'].map(file);
    await hooks['build:publicAssets']!(wxt, files);
    expect(files.map((f) => f.relativeDest)).toEqual(['icon/16.png', 'models/Kim_Vocal_2.onnx', 'dfn/df_bg.wasm']);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      'Not packaging public/models/x.part: only public/models/Kim_Vocal_2.onnx is shipped.',
      'Not packaging public/models/UVR-MDX-NET-Voc_FT.onnx: only public/models/Kim_Vocal_2.onnx is shipped.',
    ]);
  });
});
