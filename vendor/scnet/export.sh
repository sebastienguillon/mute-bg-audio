#!/bin/sh
# Makes public/models/scnet_vocals.onnx from the SCNet checkpoint (see README.md): ONNX export,
# simplification, float16 weights. Run it with the Python of a venv that has requirements.txt.
#
# Usage: vendor/scnet/export.sh <SCNet checkout at the commit in README.md> <checkpoint.th> <work dir>
set -eu
here=$(cd "$(dirname "$0")" && pwd)
scnet=$1
checkpoint=$2
work=$3
mkdir -p "$work"
python -I "$here/export_onnx.py" --scnet "$scnet" --checkpoint "$checkpoint" --samples 441000 --out "$work/scnet_vocals_raw.onnx" --check
python -I "$here/simplify_onnx.py" "$work/scnet_vocals_raw.onnx" "$work/scnet_vocals_fp32.onnx"
python -I "$here/fp16_weights.py" "$work/scnet_vocals_fp32.onnx" "$work/scnet_vocals.onnx"
shasum -a 256 "$work/scnet_vocals.onnx"
