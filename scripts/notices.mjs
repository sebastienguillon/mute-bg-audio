// The third-party notices shipped in the package (public/THIRD_PARTY_NOTICES.txt): what they list
// and where each part comes from. scripts/make-notices.mjs writes the file; a unit test checks that
// the committed file is what renderNotices() gives, and that the npm packages it covers are the
// ones a build bundles.
//
// Inputs (all in the repository, or installed):
//   package.json                the extension's version
//   node_modules                versions of the bundled npm packages (bundledPackages())
//   vendor/onnxruntime-web/     LICENSE and ThirdPartyNotices.txt of the tag of the version in VERSION
//   vendor/wxt/                 LICENSE of the WXT repository at the tag of the version in VERSION
//   vendor/deepfilternet/       LICENSE-MIT, LICENSE-APACHE, crates.json (the Rust crates compiled into
//                               df_bg.wasm with their licenses and copyright lines) and notices/
//   scripts/build-dfn-wasm.sh   the DeepFilterNet commit
//   scripts/models.mjs          the packaged model and its SHA-256
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODELS } from './models.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES = 'public/THIRD_PARTY_NOTICES.txt';
const ORT_DIR = 'vendor/onnxruntime-web';
const WXT_DIR = 'vendor/wxt';
const DFN_DIR = 'vendor/deepfilternet';
const CRATES = `${DFN_DIR}/crates.json`;
const CRATE_NOTICES = `${DFN_DIR}/notices`;
const UNICODE_LICENSE = `${CRATE_NOTICES}/LICENSE-UNICODE`;

const RULE = '='.repeat(80);
const THIN = '-'.repeat(80);
const COPYRIGHT = /^\s*copyright\s*(\(c\)|©|\d)/i;
const TEMPLATE = /\[yyyy\]|\{yyyy\}|<year>|\[name of copyright owner\]/i;
/** License files of crates that carry notices beyond the crate's own license (code taken from elsewhere). */
const EXTRA_NOTICES = { 'minimal-lexical': ['LICENSE.md'] };

const read = (path) => readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').replace(/^﻿/, '').trimEnd();
const heading = (title) => `${RULE}\n${title}\n${RULE}`;
/** A table-of-contents line, dotted up to column 62. */
const toc = (title, value) => `  ${title} ${'.'.repeat(Math.max(3, 62 - title.length - 3))} ${value}`;

// ───────────── npm packages ─────────────

/** The npm packages whose code is in the package: { name, version, dir (real path) }. */
export function bundledPackages(root = ROOT) {
  const wxt = installed('wxt', root);
  // A dependency of wxt (the `browser` object), not of the project.
  return [installed('onnxruntime-web', root), wxt, installed('@wxt-dev/browser', wxt.dir)];
}

/** An installed package, found from `from` the way Node resolves packages. */
function installed(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const path = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(path)) return { name, version: JSON.parse(readFileSync(path, 'utf8')).version, dir: dirname(realpathSync(path)) };
    if (dirname(dir) === dir) throw new Error(`${name} is not installed. Run \`pnpm install\`.`);
  }
}

/** A text of `dir` (vendor/…), which must be the one of the installed version of `pkg`. */
function vendored(root, dir, file, pkg) {
  const recorded = read(join(root, dir, 'VERSION'));
  if (recorded !== pkg.version) {
    throw new Error(
      `${dir} has the texts of ${pkg.name} ${recorded}, but ${pkg.version} is installed. ` +
        'Run `node scripts/make-notices.mjs --fetch`.',
    );
  }
  return read(join(root, dir, file));
}

/** Downloads the texts of vendor/onnxruntime-web and vendor/wxt for the installed versions. */
export async function fetchVendorTexts(root = ROOT) {
  const [ort, wxt] = bundledPackages(root);
  const ortTag = `https://raw.githubusercontent.com/microsoft/onnxruntime/v${ort.version}`;
  const sources = [
    { dir: ORT_DIR, version: ort.version, files: { LICENSE: `${ortTag}/LICENSE`, 'ThirdPartyNotices.txt': `${ortTag}/ThirdPartyNotices.txt` } },
    { dir: WXT_DIR, version: wxt.version, files: { LICENSE: `https://raw.githubusercontent.com/wxt-dev/wxt/wxt-v${wxt.version}/LICENSE` } },
  ];
  for (const { dir, version, files } of sources) {
    const texts = [];
    for (const [file, url] of Object.entries(files)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      texts.push([file, await res.text()]);
    }
    mkdirSync(join(root, dir), { recursive: true });
    for (const [file, text] of texts) writeFileSync(join(root, dir, file), text);
    writeFileSync(join(root, dir, 'VERSION'), `${version}\n`);
  }
}

// ───────────── Rust crates ─────────────

/**
 * Rewrites vendor/deepfilternet/crates.json and notices/ from a DeepFilterNet checkout with
 * libdf-wasm.patch applied (as scripts/build-dfn-wasm.sh leaves it): the crates `cargo tree` lists
 * for the WebAssembly build, with the license, authors and copyright lines of their sources.
 */
export function refreshCrates(checkout, root = ROOT) {
  const cargo = (...args) => execFileSync('cargo', args, { cwd: checkout, encoding: 'utf8', maxBuffer: 256 << 20 });
  const tree = cargo(
    'tree', '--locked', '-e', 'normal,no-proc-macro', '--target', 'wasm32-unknown-unknown',
    '-p', 'deep_filter', '--no-default-features', '--features', 'wasm', '--prefix', 'none', '--format', '{p}',
  );
  const wanted = new Set(tree.split('\n').map((line) => /^(\S+) v(\S+)/.exec(line)?.slice(1).join('@')).filter(Boolean));
  const { packages } = JSON.parse(cargo('metadata', '--locked', '--all-features', '--format-version', '1'));
  // Registry crates only: the workspace's own crates are DeepFilterNet (section 2).
  const used = packages.filter((p) => p.source && wanted.has(`${p.name}@${p.version}`));
  if (used.length === 0) throw new Error(`${checkout}: cargo tree lists no crates`);

  rmSync(join(root, CRATE_NOTICES), { recursive: true, force: true });
  mkdirSync(join(root, CRATE_NOTICES), { recursive: true });
  const crates = used
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .map((p) => {
      const dir = dirname(p.manifest_path);
      const files = readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile()).sort();
      const license = p.license.replace(/\//g, ' OR '); // Old crates write "MIT/Apache-2.0".
      // Copyright lines of the license files that apply (not those of the alternative licenses).
      const ownLicenses = files.filter((f) => /^(licen[cs]e|copying|copyright)/i.test(f) && !/apache|unlicense|unicode|zlib|0bsd|third-party/i.test(f));
      const copyrights = new Set();
      for (const f of ownLicenses) {
        for (const line of read(join(dir, f)).split('\n')) {
          if (COPYRIGHT.test(line) && !TEMPLATE.test(line)) copyrights.add(line.trim().replace(/,$/, ''));
        }
      }
      const notices = files.filter((f) => /third-party/i.test(f) || EXTRA_NOTICES[p.name]?.includes(f));
      for (const f of notices) {
        mkdirSync(join(root, CRATE_NOTICES, `${p.name}-${p.version}`), { recursive: true });
        writeFileSync(join(root, CRATE_NOTICES, `${p.name}-${p.version}`, f), `${read(join(dir, f))}\n`);
      }
      if (/Unicode-DFS-2016/.test(license)) writeFileSync(join(root, UNICODE_LICENSE), `${read(join(dir, 'LICENSE-UNICODE'))}\n`);
      return {
        name: p.name,
        version: p.version,
        license,
        repository: p.repository,
        authors: p.authors.map((a) => a.replace(/\s*<[^>]*>?/g, '').trim()),
        copyrights: [...copyrights],
        notices,
      };
    });
  writeFileSync(join(root, CRATES), `${JSON.stringify(crates, null, 2)}\n`);
}

/** The license a crate is used under: MIT when it offers MIT, else its first choice. */
function usedLicense(license) {
  if (!/\bMIT\b/.test(license)) return license.split(' OR ')[0];
  return /Unicode-DFS-2016/.test(license) ? 'MIT AND Unicode-DFS-2016' : 'MIT';
}

function crateEntry(c, unicodeCopyright) {
  const used = usedLicense(c.license);
  const copyrights = /Unicode-DFS-2016/.test(used) ? [...c.copyrights, unicodeCopyright] : c.copyrights;
  const owners = c.copyrights.length
    ? copyrights
    : [`Copyright (c) the ${c.name} authors${c.authors.length ? `: ${c.authors.join(', ')}` : ''}`, ...copyrights];
  return [
    `${c.name} ${c.version}`,
    `  License: ${c.license}${used !== c.license ? ` (used under ${used})` : ''}`,
    `  ${c.repository}`,
    ...owners.map((line) => `  ${line}`),
  ].join('\n');
}

// ───────────── the notices ─────────────

/** The notices file (with the UTF-8 BOM Chrome needs to show extension .txt files as UTF-8). */
export function renderNotices(root = ROOT) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const [ort, wxt, wxtBrowser] = bundledPackages(root);
  const ortLicense = vendored(root, ORT_DIR, 'LICENSE', ort);
  const ortNotices = vendored(root, ORT_DIR, 'ThirdPartyNotices.txt', ort);
  const wxtLicense = vendored(root, WXT_DIR, 'LICENSE', wxt);

  const dfnCommit = /^COMMIT=([0-9a-f]{40})$/m.exec(read(join(root, 'scripts/build-dfn-wasm.sh')))?.[1];
  if (!dfnCommit) throw new Error('scripts/build-dfn-wasm.sh: no COMMIT=<sha>');
  const dfnMit = read(join(root, DFN_DIR, 'LICENSE-MIT'));
  const apache = read(join(root, DFN_DIR, 'LICENSE-APACHE'));
  const mitTemplate = dfnMit
    .split('\n')
    .filter((l) => !COPYRIGHT.test(l) && !/^The MIT License/i.test(l))
    .join('\n')
    .trim();

  /** @type {{ name: string, version: string, license: string, repository: string, authors: string[], copyrights: string[], notices: string[] }[]} */
  const crates = JSON.parse(readFileSync(join(root, CRATES), 'utf8'));
  const unicode = read(join(root, UNICODE_LICENSE));
  const unicodeOwner = /^Copyright .*Unicode, Inc\./m.exec(unicode)?.[0];
  if (!unicodeOwner) throw new Error(`${UNICODE_LICENSE}: no copyright line`);
  const unicodeCopyright = `${unicodeOwner} (Unicode data, license in Appendix B)`;
  const unicodeCrates = crates.filter((c) => /Unicode-DFS-2016/.test(c.license)).map((c) => c.name);
  const nonMit = crates.filter((c) => !usedLicense(c.license).startsWith('MIT'));
  const extras = crates.flatMap((c) =>
    c.notices.map((file) => ({ crate: c, file, text: read(join(root, CRATE_NOTICES, `${c.name}-${c.version}`, file)) })),
  );

  const [modelFile, model] = Object.entries(MODELS).find(([, m]) => m.packaged);
  const modelRelease = model.url.replace(/\/download\/([^/]+)\/[^/]+$/, '/tag/$1');

  const out = [
    'THIRD-PARTY SOFTWARE NOTICES',
    `Mute BG Audio ${version}`,
    '',
    'This extension includes the third-party components listed below, with their copyright',
    'notices and licenses. The extension itself downloads nothing at runtime.',
    '',
    toc(`1. ONNX Runtime Web ${ort.version}`, 'MIT'),
    toc('2. DeepFilterNet3', 'MIT OR Apache-2.0'),
    toc('3. Rust crates compiled into dfn/df_bg.wasm', 'MIT and others'),
    toc('4. WXT runtime', 'MIT'),
    toc(`5. UVR MDX-Net vocal model ${modelFile.replace(/\.onnx$/, '')}`, 'see section 5'),
    '  Appendix A. Apache License 2.0',
    `  Appendix B. Unicode License (${unicodeCrates.join(', ')})`,
    `  Appendix C. Third-party notices of ONNX Runtime ${ort.version}`,
    '',
    '',
    heading(`1. ONNX Runtime Web ${ort.version}`),
    '',
    `https://github.com/microsoft/onnxruntime (npm package onnxruntime-web ${ort.version})`,
    'Used in: the look-ahead engine scripts (assets/) and assets/ort-wasm-simd-threaded.jspi-*.wasm',
    '',
    ortLicense,
    '',
    'ONNX Runtime includes third-party libraries, some of them compiled into its WebAssembly binary.',
    `Their notices (ThirdPartyNotices.txt of the v${ort.version} tag) are reproduced in Appendix C.`,
    '',
    '',
    heading('2. DeepFilterNet3'),
    '',
    `https://github.com/Rikorose/DeepFilterNet, commit ${dfnCommit}`,
    'Used in: dfn/df_bg.wasm (libDF compiled to WebAssembly, DeepFilterNet3 model embedded) and its',
    'JavaScript bindings in the real-time engine script.',
    'License: MIT OR Apache-2.0 (Apache-2.0 text in Appendix A).',
    '',
    dfnMit,
    '',
    '',
    heading('3. Rust crates compiled into dfn/df_bg.wasm'),
    '',
    'The WebAssembly build of DeepFilterNet statically links the Rust standard library and the',
    'crates below. List: `cargo tree -e normal,no-proc-macro --target wasm32-unknown-unknown',
    '-p deep_filter --no-default-features --features wasm` with the Cargo.lock of',
    'vendor/deepfilternet/libdf-wasm.patch. Crates that offer a choice of licenses are used under',
    'the MIT license, whose text follows the list; the other license texts are referenced.',
    '',
    'Rust standard library (core, alloc, std and their dependencies)',
    '  License: MIT OR Apache-2.0 (used under MIT)',
    '  https://github.com/rust-lang/rust',
    '  Copyright (c) The Rust Project Developers',
    '',
    crates.map((c) => crateEntry(c, unicodeCopyright)).join('\n\n'),
    '',
    THIN,
    'MIT License (applies to the Rust standard library and every crate above used under MIT,',
    'each with its copyright notice listed above)',
    THIN,
    '',
    mitTemplate,
    '',
    ...(nonMit.length
      ? [THIN, `Crates used under Apache-2.0 (text in Appendix A): ${nonMit.map((c) => `${c.name} ${c.version}`).join(', ')}`, THIN, '']
      : []),
    ...extras.flatMap((e) => [THIN, `${e.crate.name} ${e.crate.version}: ${e.file}`, THIN, '', e.text, '']),
    '',
    heading('4. WXT runtime'),
    '',
    `https://github.com/wxt-dev/wxt (npm packages wxt ${wxt.version} and ${wxtBrowser.name} ${wxtBrowser.version})`,
    'Used in: background.js, the content scripts, worklet.js and chunks/browser-*.js (entrypoint',
    'wrappers, the content-script context and location watcher, and the `browser` API object).',
    '',
    wxtLicense,
    '',
    '',
    heading(`5. UVR MDX-Net vocal model ${modelFile.replace(/\.onnx$/, '')}`),
    '',
    `File: models/${modelFile} (SHA-256 ${model.sha256})`,
    `Source: ${modelRelease}`,
    '',
    'Credit: Ultimate Vocal Remover (UVR) and its developers (core developers Anjok07 and aufr33;',
    'https://github.com/Anjok07/ultimatevocalremovergui). Model by Kimberley Jensen (KimberleyJSN).',
    'MDX-Net architecture by KUIELab and Woosung Choi.',
    '',
    'License: the publisher does not state a license for the model weights (the model repository',
    'has no license file). The UVR GUI code is MIT-licensed according to its README, which asks',
    'third-party applications that use the UVR models to credit UVR and its developers. The',
    "model parameters used by this extension come from UVR's model_data.json.",
    '',
    '',
    heading('Appendix A. Apache License 2.0'),
    '',
    apache,
    '',
    '',
    heading(`Appendix B. Unicode License (${unicodeCrates.join(', ')})`),
    '',
    unicode,
    '',
    '',
    heading(`Appendix C. Third-party notices of ONNX Runtime ${ort.version}`),
    '',
    `From https://github.com/microsoft/onnxruntime/blob/v${ort.version}/ThirdPartyNotices.txt`,
    '',
    ortNotices,
    '',
  ].join('\n');
  return `﻿${out}`;
}
