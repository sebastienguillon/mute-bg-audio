#!/usr/bin/env node
// Writes public/THIRD_PARTY_NOTICES.txt from the inputs listed in scripts/notices.mjs. Run it after
// changing a bundled dependency, the DeepFilterNet build or the version; the unit tests fail while
// the committed file is stale.
//
// Usage: node scripts/make-notices.mjs [--fetch] [--crates <DeepFilterNet checkout>]
//   --fetch            first download the ONNX Runtime and WXT license texts of the installed
//                      versions into vendor/ (after upgrading onnxruntime-web or wxt)
//   --crates <dir>     first rewrite vendor/deepfilternet/crates.json and notices/ from a
//                      DeepFilterNet checkout with libdf-wasm.patch applied (the WORK directory of
//                      scripts/build-dfn-wasm.sh); needs cargo and the crates' sources (cargo fetch)
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fetchVendorTexts, NOTICES, refreshCrates, renderNotices, ROOT } from './notices.mjs';

const args = process.argv.slice(2);
const cratesAt = args.indexOf('--crates');
try {
  if (args.includes('--fetch')) await fetchVendorTexts();
  if (cratesAt >= 0) {
    const checkout = args[cratesAt + 1];
    if (!checkout) throw new Error('--crates needs the path of a DeepFilterNet checkout');
    refreshCrates(resolve(checkout));
  }
  writeFileSync(join(ROOT, NOTICES), renderNotices());
  console.log(`Wrote ${NOTICES}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
