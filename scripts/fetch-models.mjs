#!/usr/bin/env node
// Downloads the look-ahead separation model into public/models/ (verified by SHA-256). It is packaged
// with the extension; nothing is downloaded at runtime. --all also fetches the alternative model,
// used by the comparison tests only, into .cache/models/ (never packaged). The models and their
// hashes are in scripts/models.mjs.
//
// Usage: node scripts/fetch-models.mjs [--all]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS, sha256File } from './models.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED_MODELS_DIR = join(root, 'public/models');
const CACHED_MODELS_DIR = join(root, '.cache/models');

const verified = async (path, expected) => existsSync(path) && (await sha256File(path)) === expected;

/** Makes `name` available in .cache/models (downloading it if needed), then in `destDir`. */
async function fetchModel(name, { url, sha256: expected }, destDir) {
  const dest = join(destDir, name);
  if (await verified(dest, expected)) {
    console.log(`✓ ${name} (cached)`);
    return;
  }
  const cached = join(CACHED_MODELS_DIR, name);
  if (!(await verified(cached, expected))) {
    console.log(`↓ ${name}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== expected) throw new Error(`${name}: SHA-256 mismatch (got ${got})`);
    mkdirSync(CACHED_MODELS_DIR, { recursive: true });
    writeFileSync(cached + '.part', buf);
    renameSync(cached + '.part', cached);
  }
  if (dest !== cached) {
    mkdirSync(destDir, { recursive: true });
    await copyFile(cached, dest);
  }
  console.log(`✓ ${name}${dest === cached ? ' (in .cache/models, not packaged)' : ''}`);
}

async function main() {
  const all = process.argv.includes('--all');
  for (const [name, model] of Object.entries(MODELS)) {
    if (model.packaged) await fetchModel(name, model, PACKAGED_MODELS_DIR);
    else if (all) await fetchModel(name, model, CACHED_MODELS_DIR);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
