# DeepFilterNet3 (WebAssembly build)

* Source: https://github.com/Rikorose/DeepFilterNet at commit `d375b2d8309e0935d165700c91da9de862a99c31`
* License: MIT or Apache-2.0 (see `LICENSE-MIT`, `LICENSE-APACHE`), © Hendrik Schröter
* Model: DeepFilterNet3 (`models/DeepFilterNet3_onnx.tar.gz`), embedded in the WASM binary
* Patch (`libdf-wasm.patch`): `df_create` accepts empty model bytes to use the embedded model;
  `Cargo.lock` updated to wasm-bindgen 0.2.129.
* Build: `scripts/build-dfn-wasm.sh` (`cargo build --profile release-lto`, `+simd128`,
  `wasm-bindgen --target web`). Output: `vendor/deepfilternet/df.js`, `public/dfn/df_bg.wasm`.
* `crates.json`, `notices/`: the Rust crates compiled into the WASM binary, with their licenses
  and copyright lines, for `public/THIRD_PARTY_NOTICES.txt`. After a rebuild with other crates:
  `node scripts/make-notices.mjs --crates <WORK>/DeepFilterNet`.

Measured on an Apple M4 Max (Node 24, one thread): 0.79 ms per 480-sample frame (RTF 0.08),
algorithmic delay 1440 samples (30 ms) at 48 kHz.
