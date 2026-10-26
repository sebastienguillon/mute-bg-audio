"""Stores the float weights of an ONNX model as float16 and casts them back to float32 in the graph:
half the file size, float32 compute and float32 inputs and outputs (onnxruntime folds the Casts
when it creates the session).

Usage (see README.md): python -I fp16_weights.py fp32.onnx scnet_vocals.onnx
"""
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

src, dst = sys.argv[1], sys.argv[2]
model = onnx.load(src)
g = model.graph
casts, new_inits, n_conv = [], [], 0
for t in list(g.initializer):
    # Small tensors (shapes, scalars) stay float32.
    if t.data_type == TensorProto.FLOAT and np.prod(t.dims) >= 16:
        arr = numpy_helper.to_array(t)
        h = numpy_helper.from_array(arr.astype(np.float16), t.name + '__fp16')
        new_inits.append(h)
        casts.append(helper.make_node('Cast', [h.name], [t.name], name=t.name + '__cast', to=TensorProto.FLOAT))
        g.initializer.remove(t)
        n_conv += 1
g.initializer.extend(new_inits)
nodes = casts + list(g.node)
del g.node[:]
g.node.extend(nodes)
onnx.checker.check_model(model, full_check=True)
onnx.save(model, dst)
print(f'{dst}: {n_conv} float initializers stored as float16 (Cast to float32 in the graph)')
