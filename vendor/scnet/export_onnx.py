"""Exports the vocals stem of SCNet (base) to ONNX, with the STFT and inverse STFT outside the graph.

Graph:  spec    float32 [1, 4, 2049, T]  torch.stft(normalized=True, rectangular window) of the
                                         end-padded chunk, channels [L.re, L.im, R.re, R.im]
     -> vocals  float32 [1, 4, 2049, T]  vocals spectrogram, same layout (de-normalised)
T is fixed by the chunk length (--samples at 44.1 kHz; 441000 -> T = 432).

Changes from SCNet.forward (exact rewrites; --check compares them with the original module):
  * the STFT, the inverse STFT and the end padding are removed (src/lib/mdx/scnet.ts does them);
  * FeatureConversion's torch.fft.rfft / irfft along T (norm='ortho') are MatMuls with constant
    DFT matrices (computed in float64, stored as float32), so the graph has no DFT op;
  * only the vocals stem is computed: the last decoder ConvTranspose2d layers keep output
    channels 12..15.

Usage (see README.md):
  python -I export_onnx.py --scnet <SCNet checkout> --checkpoint <checkpoint.th> --out raw.onnx [--check]
"""
import argparse
import os
import sys

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import yaml

NFFT = 4096
HOP = 1024
BINS = NFFT // 2 + 1
SR = 44100
VOCALS = 3  # index in ['drums', 'bass', 'other', 'vocals']


def model_padding(length, hop=HOP):
    """SCNet.forward's end padding: a multiple of hop with an odd hop count (even frame count)."""
    padding = hop - length % hop
    if (length + padding) // hop % 2 == 0:
        padding += hop
    return padding


def frames_for(length):
    return (length + model_padding(length)) // HOP + 1


def load_scnet(scnet_dir, checkpoint):
    from ml_collections import ConfigDict
    from scnet.SCNet import SCNet
    from scnet.utils import load_model
    with open(os.path.join(scnet_dir, 'conf/config.yaml')) as f:
        config = ConfigDict(yaml.load(f, Loader=yaml.FullLoader))
    model = SCNet(**config.model)
    load_model(model, checkpoint)
    return model.eval()


def dft_matrices(T):
    """Real rfft/irfft (norm='ortho') along the last axis as matrices (float64)."""
    K = T // 2 + 1
    n = np.arange(T)
    k = np.arange(K)
    ang = 2 * np.pi * ((np.outer(n, k)) % T) / T  # exact angle reduction
    s = 1 / np.sqrt(T)
    fwd = np.concatenate([np.cos(ang) * s, -np.sin(ang) * s], axis=1)  # [T, 2K]: x @ fwd = [re | im]
    w = np.full(K, 2.0)
    w[0] = 1.0
    w[-1] = 1.0  # T even: Nyquist bin
    ci = (w[:, None] * np.cos(ang.T)) * s  # [K, T]
    si = -(w[:, None] * np.sin(ang.T)) * s
    si[0] = 0.0  # irfft ignores the imaginary parts of the DC and Nyquist bins
    si[-1] = 0.0
    inv = np.concatenate([ci, si], axis=0)  # [2K, T]: [re | im] @ inv = x
    return fwd, inv


class NormIn(nn.Module):
    def forward(self, x):
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        return (x - mean) / (1e-5 + std), mean, std


class NormOut(nn.Module):
    def forward(self, x, mean, std):
        return x * std + mean


class SCNetVocalsCore(nn.Module):
    def __init__(self, model, T, vocals_only=True):
        super().__init__()
        assert T % 2 == 0
        self.T = T
        self.K = T // 2 + 1
        self.encoder = model.encoder
        self.decoder = model.decoder
        self.dp_modules = model.separation_net.dp_modules
        self.num_layers = model.separation_net.num_layers
        self.channels = model.dims[-1]
        self.n = model.dims[0]
        self.nsrc = len(model.sources)
        self.norm_in = NormIn()
        self.norm_out = NormOut()
        fwd, inv = dft_matrices(T)
        self.register_buffer('dft_fwd', torch.from_numpy(fwd).float())
        self.register_buffer('dft_inv', torch.from_numpy(inv).float())
        self.vocals_only = vocals_only
        if vocals_only:
            # last decoder SUlayer: keep the 4 output channels of the vocals stem
            su = self.decoder[-1][1]
            lo, hi = VOCALS * self.n, (VOCALS + 1) * self.n
            for i, ct in enumerate(su.convtrs):
                new = nn.ConvTranspose2d(ct.in_channels, hi - lo, ct.kernel_size, ct.stride)
                new.weight.data = ct.weight.data[:, lo:hi].clone()
                new.bias.data = ct.bias.data[lo:hi].clone()
                su.convtrs[i] = new

    def feature_conversion(self, x, inverse):
        if inverse:
            # [B, 2C', F, K] -> [B, C', F, T]: torch.fft.irfft(complex(re, im), dim=3, norm='ortho')
            c = x.shape[1] // 2
            x = torch.cat([x[:, :c], x[:, c:]], dim=3)  # [B, C', F, 2K]
            return torch.matmul(x, self.dft_inv)
        y = torch.matmul(x, self.dft_fwd)  # [B, C, F, 2K]
        return torch.cat([y[..., :self.K], y[..., self.K:]], dim=1)

    def forward(self, spec):
        x, mean, std = self.norm_in(spec)
        save_skip, save_lengths, save_original_lengths = [], [], []
        for sd_layer in self.encoder:
            x, skip, lengths, original_lengths = sd_layer(x)
            save_skip.append(skip)
            save_lengths.append(lengths)
            save_original_lengths.append(original_lengths)
        for i in range(self.num_layers):
            x = self.dp_modules[i](x)
            x = self.feature_conversion(x, inverse=(i % 2 == 1))
        for fusion_layer, su_layer in self.decoder:
            x = fusion_layer(x, save_skip.pop())
            x = su_layer(x, save_lengths.pop(), save_original_lengths.pop())
        if not self.vocals_only:
            x = x[:, VOCALS * self.n:(VOCALS + 1) * self.n]
        return self.norm_out(x, mean, std)


def original_vocals_spec(model, spec):
    """Original SCNet.forward between STFT and iSTFT, vocals channels (reference for the core)."""
    from collections import deque
    x = spec
    B, C, Fr, T = x.shape
    mean = x.mean(dim=(1, 2, 3), keepdim=True)
    std = x.std(dim=(1, 2, 3), keepdim=True)
    x = (x - mean) / (1e-5 + std)
    save_skip, save_lengths, save_original_lengths = deque(), deque(), deque()
    for sd_layer in model.encoder:
        x, skip, lengths, original_lengths = sd_layer(x)
        save_skip.append(skip)
        save_lengths.append(lengths)
        save_original_lengths.append(original_lengths)
    x = model.separation_net(x)
    for fusion_layer, su_layer in model.decoder:
        x = fusion_layer(x, save_skip.pop())
        x = su_layer(x, save_lengths.pop(), save_original_lengths.pop())
    n = model.dims[0]
    x = x.view(B, n, -1, Fr, T)
    x = x * std[:, None] + mean[:, None]
    x = x.reshape(B, -1, Fr, T)
    return x[:, VOCALS * n:(VOCALS + 1) * n]


def check(model, core, L):
    """The core against SCNet.forward on a test chunk (seeded noise with a decaying envelope)."""
    rng = np.random.default_rng(0)
    t = np.arange(L) / SR
    chunk = (rng.standard_normal((2, L)) * (0.2 + 0.8 * np.exp(-t))).astype(np.float32)
    with torch.no_grad():
        wav = torch.from_numpy(chunk)[None]
        full = model(wav)[0, VOCALS].numpy()  # original forward incl. torch.stft / istft
        x = F.pad(wav, (0, model_padding(L)))
        s = torch.view_as_real(torch.stft(x.reshape(-1, x.shape[-1]), **model.stft_config, return_complex=True))
        spec = s.permute(0, 3, 1, 2).reshape(1, 4, s.shape[1], s.shape[2])
        ref_spec = original_vocals_spec(model, spec)
        core_spec = core(spec)
        print('core vs SCNet.forward (spectrogram): max abs', (core_spec - ref_spec).abs().max().item(), 'peak', ref_spec.abs().max().item())
        v = core_spec.reshape(2, 2, BINS, -1)
        y = torch.istft(torch.complex(v[:, 0], v[:, 1]), **model.stft_config)[:, :L].numpy()
        err = np.sum((y.astype(np.float64) - full) ** 2)
        print('torch.stft + core + istft vs SCNet.forward (waveform): SNR', 10 * np.log10(np.sum(full.astype(np.float64) ** 2) / err), 'dB')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--scnet', required=True, help='checkout of https://github.com/starrytong/SCNet')
    ap.add_argument('--checkpoint', required=True, help='the SCNet (base) checkpoint.th')
    ap.add_argument('--samples', type=int, default=441000, help='chunk length in samples at 44.1 kHz')
    ap.add_argument('--out', required=True)
    ap.add_argument('--opset', type=int, default=17)
    ap.add_argument('--check', action='store_true', help='compare the core with SCNet.forward first')
    args = ap.parse_args()
    sys.path.insert(0, os.path.abspath(args.scnet))
    torch.set_num_threads(os.cpu_count())
    torch.manual_seed(0)
    L = args.samples
    T = frames_for(L)
    print(f'chunk {L} samples -> padding {model_padding(L)} -> T = {T} frames')

    # DFT-matrix rfft/irfft vs numpy / torch.fft (incl. non-zero imag at DC/Nyquist, which irfft ignores)
    fwd, inv = dft_matrices(T)
    rng = np.random.default_rng(0)
    xr = rng.standard_normal((3, T))
    ref = np.fft.rfft(xr, axis=-1, norm='ortho')
    got = xr @ fwd
    print('rfft matrix max err', np.abs(got[:, :T // 2 + 1] - ref.real).max(), np.abs(got[:, T // 2 + 1:] - ref.imag).max())
    zc = rng.standard_normal((3, T // 2 + 1)) + 1j * rng.standard_normal((3, T // 2 + 1))
    ref_i = torch.fft.irfft(torch.from_numpy(zc), dim=-1, norm='ortho').numpy()
    got_i = np.concatenate([zc.real, zc.imag], axis=1) @ inv
    print('irfft matrix max err', np.abs(got_i - ref_i).max())

    core = SCNetVocalsCore(load_scnet(args.scnet, args.checkpoint), T).eval()
    if args.check:
        check(load_scnet(args.scnet, args.checkpoint), core, L)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    dummy = torch.randn(1, 4, BINS, T)
    with torch.no_grad():
        torch.onnx.export(core, (dummy,), args.out, dynamo=False, opset_version=args.opset,
                          input_names=['spec'], output_names=['vocals'], do_constant_folding=True)
    print('wrote', args.out, os.path.getsize(args.out))


if __name__ == '__main__':
    main()
