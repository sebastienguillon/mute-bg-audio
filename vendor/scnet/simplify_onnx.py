"""Constant-folds the traced shape arithmetic of a static-shape export (onnx-simplifier, then the
onnxscript optimizer), then checks the result against the input model with onnxruntime (CPU EP) on
a random tensor.

Usage (see README.md): python -I simplify_onnx.py raw.onnx fp32.onnx
"""
import collections
import sys

import numpy as np
import onnx
import onnxruntime as ort
import onnxscript.optimizer
import onnxsim

src, dst = sys.argv[1], sys.argv[2]
model = onnx.load(src)
before = len(model.graph.node)
opt, ok = onnxsim.simplify(model)
assert ok, 'onnxsim check failed'
opt = onnxscript.optimizer.optimize(opt, num_iterations=4)
onnx.checker.check_model(opt, full_check=True)
opt = onnx.shape_inference.infer_shapes(opt, strict_mode=True)
# name the (static) output dims
out = opt.graph.output[0]
inp = opt.graph.input[0]
for d_out, d_in in zip(out.type.tensor_type.shape.dim, inp.type.tensor_type.shape.dim):
    if d_in.HasField('dim_value'):
        d_out.Clear()
        d_out.dim_value = d_in.dim_value
onnx.save(opt, dst)
print(f'{src}: {before} nodes -> {dst}: {len(opt.graph.node)} nodes')
print(sorted(collections.Counter(n.op_type for n in opt.graph.node).items()))

shape = [d.dim_value for d in inp.type.tensor_type.shape.dim]
x = np.random.default_rng(1).standard_normal(shape).astype(np.float32)
a = ort.InferenceSession(src, providers=['CPUExecutionProvider']).run(None, {'spec': x})[0]
b = ort.InferenceSession(dst, providers=['CPUExecutionProvider']).run(None, {'spec': x})[0]
print('simplified vs original graph (ORT CPU): max abs', float(np.abs(a - b).max()), 'peak', float(np.abs(a).max()), 'shape', b.shape)
