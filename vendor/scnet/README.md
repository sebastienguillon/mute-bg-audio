# SCNet vocal model (the SCNet build's look-ahead model)

`public/models/scnet_vocals.onnx` is the vocals stem of SCNet (base), converted to ONNX by the
scripts in this directory. Builds with `LOOKAHEAD_MODEL=scnet` package it instead of Kim_Vocal_2
(see "Choosing the look-ahead model" in the top-level README).

* Upstream: https://github.com/starrytong/SCNet at commit
  `5d95bf96b19c3eede63248d171efeca8e3abb948`, the official implementation of "SCNet: Sparse
  Compression Network for Music Source Separation" (Weinan Tong, Jiaxu Zhu, Jun Chen, Shiyin Kang,
  Tao Jiang, Yang Li, Zhiyong Wu, Helen Meng; https://arxiv.org/abs/2401.13276).
* Checkpoint: SCNet (base), linked from the upstream README:
  https://drive.google.com/file/d/1CdEIIqsoRfHn1SJ7rccPfyYioW3BlXcW/view, 42,434,545 bytes,
  SHA-256 `f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5`. The upstream
  README says it was trained on the MUSDB dataset; the data path of its training configuration
  is `musdbhq` (MUSDB18-HQ).
* Output: `public/models/scnet_vocals.onnx`, 22,164,365 bytes, SHA-256
  `8ce631f3fdee6727f304b74654f4993b6d626dba9fc07a58f1ebc9a5efce5a00` (also in
  `scripts/models.mjs`, which every SCNet build checks).
* License: MIT, `LICENSE` (the upstream file, verbatim; Copyright (c) 2024 starrytong). For the
  weights, the repository owner (starrytong) wrote on 2026-07-17 in
  https://github.com/starrytong/SCNet/issues/35#issuecomment-4999873539:

  > I confirm that the released SCNet and SCNet-large pretrained weights are distributed under the
  > MIT License, consistent with the source code. You are welcome to redistribute the original
  > checkpoints and format-converted versions, including ONNX exports, as part of your MIT-licensed
  > tool, with appropriate attribution.

  The comment answers another project's request (an MIT-licensed stem-separation tool); its first
  sentence states the license of the released weights in general. `public/THIRD_PARTY_NOTICES-scnet.txt`
  carries the license and the attribution.

`source.json` holds the upstream commit, the checkpoint and the license grant for
`scripts/notices.mjs`.

## What the conversion changes

* `export_onnx.py`: only the vocals stem is computed (the last decoder layers keep their output
  channels 12–15); the STFT, the inverse STFT and SCNet's end padding are not in the graph (the
  extension does them, `src/lib/mdx/scnet.ts`); the rfft/irfft along time inside the model are
  MatMuls with constant DFT matrices, so the graph has no DFT op; the chunk length is fixed at
  441,000 samples (10 s at 44.1 kHz, 432 STFT frames). SCNet's own inference uses 20 s segments.
  `--check` compares the result with the original `SCNet.forward`.
* `simplify_onnx.py`: folds the traced shape arithmetic (onnx-simplifier, onnxscript optimizer)
  and checks the result against the exported graph with onnxruntime.
* `fp16_weights.py`: stores the float weights as float16, with Casts back to float32 in the
  graph. Compute, input and output stay float32.

The graph: input `spec`, float32 `[1, 4, 2049, 432]`: `torch.stft` (n_fft 4096, hop 1024,
rectangular window, `normalized=True`, center, reflect) of the chunk zero-padded to 441,344
samples, channels `[L.re, L.im, R.re, R.im]`; output `vocals`, the vocals spectrogram in the same
layout. The graph normalises each chunk itself (mean and standard deviation of the spectrogram).
The extension overlap-adds the chunks with the triangle weights of demucs' `apply_model()`, at 25 %
overlap (SCNet uses 50 %).

## Reproducing the file

With Python 3.11 (the file was made on macOS arm64):

```sh
python3.11 -m venv /tmp/scnet-venv
/tmp/scnet-venv/bin/pip install -r vendor/scnet/requirements.txt
git clone https://github.com/starrytong/SCNet.git /tmp/SCNet
git -C /tmp/SCNet checkout 5d95bf96b19c3eede63248d171efeca8e3abb948
# The checkpoint, from the Google Drive link above (any download tool, e.g. gdown):
#   gdown 1CdEIIqsoRfHn1SJ7rccPfyYioW3BlXcW -O /tmp/checkpoint.th
shasum -a 256 /tmp/checkpoint.th   # f8aff3bc…
PATH=/tmp/scnet-venv/bin:$PATH vendor/scnet/export.sh /tmp/SCNet /tmp/checkpoint.th /tmp/scnet-out
```

`export.sh` runs the three scripts and prints the SHA-256 of `/tmp/scnet-out/scnet_vocals.onnx`.
On 2026-10-24 this ran from a fresh venv, a fresh clone and a fresh download of the checkpoint,
and gave a file byte-identical to `public/models/scnet_vocals.onnx`. Other versions of the
packages, another Python or another platform may give a different file; compare its outputs then
(`simplify_onnx.py` shows how) and update the SHA-256 in `scripts/models.mjs` and here.

`stft_reference.py` writes `test/fixtures/torch-stft-rect.json`, the torch.stft / torch.istft
reference of the unit test of the STFT with these settings
(`python -I vendor/scnet/stft_reference.py test/fixtures/torch-stft-rect.json`).
