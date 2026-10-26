<img src="assets/icon.svg" width="64" height="64" alt="">

# Mute BG Audio

A Chrome extension that turns down or removes the background music in videos while keeping the
voices. YouTube gets the best results; other sites work when their media can be processed. All
processing runs on your computer: no audio, video IDs or browsing data leave the browser.

## How it works

| Mode | Used for | Model | Runs on |
|---|---|---|---|
| **Look-ahead** | YouTube | UVR MDX-Net vocal model (Kim_Vocal_2), or SCNet in the SCNet build | GPU (WebGPU) |
| **Real-time** | YouTube fallback, other sites | DeepFilterNet3 | CPU (WebAssembly) |
| **Tab capture** | Media that can't be processed directly | DeepFilterNet3 | CPU |

* **Look-ahead (YouTube).** YouTube downloads audio 10–40 s before it plays. The extension reads
  those bytes as the player hands them to the browser (it never downloads anything itself),
  decodes them and separates the speech with a high-quality model *before* they play. The result
  plays in sync with the picture, including the audio output delay that Chrome does not
  compensate when a page processes video sound.
* **Real-time.** A small speech-enhancement model processes the audio as it plays, with about
  60 ms delay. It is the fallback right after a seek or a pause, while the look-ahead model warms
  up, and on sites other than YouTube. The switch to look-ahead waits for a pause in the speech
  (for up to 1.5 s), to avoid cutting words.
* **Only while needed.** Nothing is processed while a video is paused, silent or muted (muted
  previews never start the models), and a tab that is switched off gets its original audio path
  back. While *tab capture* processes a tab, the in-page processing of that tab stands down.
* **Mixing, not muting.** The output is `speech + reduction × (everything else)`. The popup's
  *Music reduction* slider goes from 0 dB to *Remove*. Partial reduction sounds more natural and
  hides model artifacts. *Extra reduction between sentences* lowers the music further while
  nobody speaks.

Every tab starts off. Switch it on from the popup (*Remove music on this tab*), also in the
middle of a video. On YouTube the tab then stays on through reloads and while you browse in it,
until you switch it off or close it, and so do YouTube players embedded in other sites. Other
videos are switched off again by a reload, unless you tick *Always run on* for the site. The
toolbar icon is in colour in a tab where it is on and greyed out elsewhere.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the components, message flow and timing.

## Limitations

* Sung lyrics in the background music are treated as voice and stay.
* Sound effects, laughter and ambience are reduced together with the music.
* DRM-protected video (Netflix, Prime Video, YouTube movies), media served by another site
  without CORS and players inside a frame from another site (e.g. a Vimeo player on a news page)
  cannot be processed directly. *Tab capture* can handle some of these, but Chrome then shows its
  “sharing this tab” indicator and the delay cannot be compensated.
* Look-ahead needs WebGPU. Without it, YouTube uses the real-time model.
* At a playback speed other than 1×, YouTube uses the real-time model; look-ahead resumes at
  normal speed.

## Development

Requirements: Node 24+, pnpm, Chrome/Chromium 137+ (WebAssembly JSPI). The tests also need
Playwright's Chromium, ffmpeg, and macOS for the test media (its speech comes from `say`).

```sh
pnpm install
pnpm fetch-models      # downloads the look-ahead model (66 MB, SHA-256 checked) into public/models
pnpm dev               # dev server, writes .output/chrome-mv3-dev
pnpm build             # production build in .output/chrome-mv3
pnpm zip               # store package
pnpm build:scnet       # the SCNet build in .output/chrome-mv3-scnet (needs no fetch-models)
pnpm zip:scnet         # its store package (…-chrome-scnet.zip)
```

Load a build with *Load unpacked* in `chrome://extensions` (Developer mode). With `pnpm dev`,
load `.output/chrome-mv3-dev` once while the server runs: the extension updates itself when a
file changes. (WXT opens a browser by itself only when `web-ext` is installed, which this project
does not depend on.)

Every build checks that its look-ahead model (`public/models/Kim_Vocal_2.onnx`, or
`public/models/scnet_vocals.onnx` for the SCNet build) is present with the expected SHA-256 and
fails otherwise; other files in `public/models/` are left out of the package.

### Choosing the look-ahead model

The look-ahead model is chosen when building, with `LOOKAHEAD_MODEL`: `kim` (the default,
Kim_Vocal_2) or `scnet` (SCNet base). Each build contains one model, its code and its notices. The
SCNet build exists because the publisher of the Kim_Vocal_2 weights states no license, while the
SCNet weights are MIT-licensed (see Third-party components). Its commands have a `:scnet` suffix
(`pnpm build:scnet`, `pnpm zip:scnet`, `pnpm build:e2e:scnet`, `pnpm test:e2e:scnet`), and its
output does too (`.output/chrome-mv3-scnet`, `.output/chrome-mv3-e2e-scnet`,
`mute-bg-audio-<version>-chrome-scnet.zip`; `LOOKAHEAD_MODEL=scnet pnpm dev` writes
`.output/chrome-mv3-dev-scnet`). The `:scnet` scripts set the variable with
`scripts/with-model.mjs`, so they also work where pnpm runs scripts with cmd.exe (Windows);
`node scripts/with-model.mjs scnet <command>` does the same for any other command, e.g.
`node scripts/with-model.mjs scnet pnpm dev`.

Compared with Kim_Vocal_2, measured on the test media and an Apple M4 Max:

* Quality: speech SI-SDR about 0.4 dB lower on the test mix (22.0 against 22.4 dB) and about 1 dB
  lower on another excerpt; music at *Remove* −39 dB against −42 dB.
* Speed: about twice the GPU time (real-time factor of the whole pipeline about 0.17 against
  0.09), so less headroom on slower GPUs (look-ahead stops above 0.7).
* Latency: a chunk is 10 s of audio instead of 5.9 s, so a full first chunk needs about 10 s
  buffered after the playhead; with less, the first chunk is processed with silence after the
  buffered audio. The first model run takes about 1.2 s.
* Size: the model file is 22 MB instead of 66 MB (package 58 MB instead of 103 MB); about 0.9 GiB
  of GPU memory at the peak of a run instead of 1.35 GiB.

`vendor/scnet/README.md` documents where the SCNet file comes from and how to make it again.

Tests:

```sh
pnpm exec playwright install chromium   # once: the browser the unit and end-to-end tests drive
pnpm fetch-models --all # also the comparison model (into .cache/models, never packaged)
pnpm test              # unit tests (Vitest; some use the real models through onnxruntime-node)
pnpm make-test-media   # makes the test clips again (the test commands make them when missing)
pnpm test:e2e          # test media if missing, pnpm build:e2e, then Chromium against a local YouTube-like player
pnpm test:e2e:scnet    # the same with the SCNet build
LIVE_YOUTUBE=1 pnpm exec playwright test youtube-live   # optional smoke test on youtube.com
LIVE_YOUTUBE=1 LOOKAHEAD_MODEL=scnet pnpm exec playwright test youtube-live   # the same with the SCNet e2e build
```

The test media are synthetic speech-over-music clips with known stems, in
`test/fixtures/generated/`. `pnpm test` and `pnpm test:e2e` generate them first when any is
missing; `pnpm make-test-media` replaces them and deletes the media the tests derived from the old
ones. Without macOS, copy that directory from a Mac.

The end-to-end tests load `.output/chrome-mv3-e2e`, built by `pnpm build:e2e` (`wxt build --mode
e2e`), or with `LOOKAHEAD_MODEL=scnet` `.output/chrome-mv3-e2e-scnet` (`pnpm build:e2e:scnet`).
These builds and the dev build contain the debug bridge the tests use to read the status and
record the audio; production builds do not. `BGMR_EXTENSION=.output/chrome-mv3-dev pnpm exec
playwright test` runs them against `pnpm dev`. The tests map `www.youtube.com` to a local server with
Chromium's host-resolver rules, so the YouTube content scripts run against a test page whose
speech and music stems are known, and the output quality is measured (SI-SDR).

## Third-party components

| Component | License | Notes |
|---|---|---|
| [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) | MIT or Apache-2.0 | Built from source to WebAssembly with about 85 Rust crates (MIT, Apache-2.0 and similar), see `vendor/deepfilternet/` |
| [UVR MDX-Net Kim_Vocal_2](https://github.com/Anjok07/ultimatevocalremovergui) | Not stated by the publisher ([TRvlvr/model_repo](https://github.com/TRvlvr/model_repo)); the UVR GUI code is MIT. Credit: UVR and its developers, model by Kimberley Jensen | Default build. Downloaded by `pnpm fetch-models` |
| [SCNet](https://github.com/starrytong/SCNet) (base) | MIT, code and weights: the author confirmed the license of the weights and the redistribution of ONNX conversions with attribution ([starrytong/SCNet#35](https://github.com/starrytong/SCNet/issues/35#issuecomment-4999873539)) | SCNet build. Trained on [MUSDB18-HQ](https://zenodo.org/records/3338373), which its publishers provide "for educational purposes only" and not for commercial use without the copyright holders' permission. Converted to ONNX (vocals only, fp16 weights) by `vendor/scnet/`; the file is committed |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | MIT | Includes the third-party libraries listed in its notices |
| [WXT](https://github.com/wxt-dev/wxt) | MIT | Extension framework; its runtime helpers and `browser` object are bundled |

The package ships the license texts and copyright notices of the components it contains in
`THIRD_PARTY_NOTICES.txt`, linked from the popup (*Licenses*): `public/THIRD_PARTY_NOTICES.txt`
in the default build, `public/THIRD_PARTY_NOTICES-scnet.txt` in the SCNet build (each names only
its own look-ahead model). `pnpm make-notices` writes both from `vendor/` and the installed
packages (see `scripts/notices.mjs`); the unit tests fail when one is out of date or a build
bundles a package it does not cover.

The MDX-Net models were trained by the UVR community on data whose provenance is not fully
documented, SCNet on MUSDB18-HQ (terms above). Check the model licensing before any commercial
distribution.

## License

MIT, see [LICENSE](LICENSE). The third-party components above keep their own licenses.
