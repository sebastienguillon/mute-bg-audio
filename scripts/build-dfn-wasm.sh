#!/bin/sh
# Rebuilds vendor/deepfilternet/df.js and public/dfn/df_bg.wasm from DeepFilterNet sources.
# Needs a Rust toolchain with the wasm32-unknown-unknown target and wasm-bindgen-cli 0.2.129.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$(mktemp -d)}
COMMIT=d375b2d8309e0935d165700c91da9de862a99c31
git clone https://github.com/Rikorose/DeepFilterNet.git "$WORK/DeepFilterNet"
cd "$WORK/DeepFilterNet"
git checkout "$COMMIT"
git apply "$ROOT/vendor/deepfilternet/libdf-wasm.patch"
RUSTFLAGS="-C target-feature=+simd128" cargo build --profile release-lto --locked \
  --target wasm32-unknown-unknown -p deep_filter --lib --no-default-features --features wasm
wasm-bindgen --target web --remove-name-section --remove-producers-section \
  --out-dir "$WORK/pkg" --out-name df target/wasm32-unknown-unknown/release-lto/df.wasm
cp "$WORK/pkg/df.js" "$WORK/pkg/df.d.ts" "$ROOT/vendor/deepfilternet/"
cp "$WORK/pkg/df_bg.wasm" "$ROOT/public/dfn/df_bg.wasm"
echo "Done. Built from $COMMIT in $WORK"
echo "If the crates changed: node scripts/make-notices.mjs --crates $WORK/DeepFilterNet"
