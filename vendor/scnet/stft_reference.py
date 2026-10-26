"""Writes test/fixtures/torch-stft-rect.json: torch.stft / torch.istft with SCNet's settings
(rectangular window, normalized=True, center=True, reflect) on small float32 signals, computed in
float64 (12 significant digits), for the TorchStft unit test.

Usage (see README.md): python -I stft_reference.py test/fixtures/torch-stft-rect.json
"""
import json
import sys

import numpy as np
import torch


def f32(values):
    """float32 values, written with the fewest digits that read back as the same float32."""
    return [float(np.format_float_positional(v, unique=True)) for v in np.asarray(values, np.float32)]


def f64(values):
    return [float(f'{v:.12g}') for v in np.asarray(values, np.float64).ravel()]


def case(n_fft, hop, length, seed, bins=None):
    rng = np.random.default_rng(seed)
    x = rng.uniform(-1, 1, length).astype(np.float32)
    xt = torch.from_numpy(x.astype(np.float64))
    # window=None in SCNet: torch then uses a rectangular window (ones).
    kw = dict(n_fft=n_fft, hop_length=hop, window=torch.ones(n_fft, dtype=torch.float64), center=True, normalized=True)
    spec = torch.stft(xt, pad_mode='reflect', return_complex=True, **kw)  # [bins, frames]
    # The inverse of a spectrogram that is not the STFT of any signal (random, Hermitian bins real),
    # so that the overlap-add envelope and the scaling matter.
    z = rng.standard_normal(spec.shape) + 1j * rng.standard_normal(spec.shape)
    z[0] = z[0].real
    z[-1] = z[-1].real
    zt = torch.from_numpy(z)
    y = torch.istft(zt, length=length, **kw)
    keep = list(range(spec.shape[0])) if bins is None else bins
    sub = spec[keep]
    return {
        'nFft': n_fft, 'hop': hop, 'length': length, 'frames': spec.shape[1], 'bins': keep,
        'x': f32(x),
        're': f64(sub.real), 'im': f64(sub.imag),
        'inverseRe': f64(z.real), 'inverseIm': f64(z.imag), 'inverse': f64(y.numpy()),
    }


cases = [case(8, 2, 37, 1), case(16, 4, 50, 2)]
# SCNet's geometry, the forward output of some bins only.
big = case(4096, 1024, 2100, 3, bins=[0, 1, 2, 100, 1000, 2047, 2048])
del big['inverseRe'], big['inverseIm'], big['inverse']
cases.append(big)
with open(sys.argv[1], 'w') as f:
    json.dump({'source': 'vendor/scnet/stft_reference.py', 'torch': torch.__version__, 'cases': cases}, f, separators=(',', ':'))
    f.write('\n')
