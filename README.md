<img src="assets/icon.svg" width="64" height="64" alt="">

# Remove Background Music

A Chrome extension that turns down or removes the background music in videos while keeping the
voices. YouTube gets the best results; other sites work when their media can be processed. All
processing runs on your computer: no audio, video IDs or browsing data leave the browser.

## How it works

| Mode | Used for | Model | Runs on |
|---|---|---|---|
| **Look-ahead** | YouTube | UVR MDX-Net vocal model (Kim_Vocal_2) | GPU (WebGPU) |
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

It starts by itself on youtube.com, www.youtube.com and m.youtube.com, and in YouTube players
embedded in other sites (also from youtube-nocookie.com). Elsewhere, including YouTube Music,
Studio and TV, switch it on from the popup, or tick *Always run on* for a site.

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
```

Load a build with *Load unpacked* in `chrome://extensions` (Developer mode). With `pnpm dev`,
load `.output/chrome-mv3-dev` once while the server runs: the extension updates itself when a
file changes. (WXT opens a browser by itself only when `web-ext` is installed, which this project
does not depend on.)

Every build checks that `public/models/Kim_Vocal_2.onnx` is present with the expected SHA-256 and
fails otherwise; other files in `public/models/` are left out of the package.

Tests:

```sh
pnpm exec playwright install chromium   # once: the browser the unit and end-to-end tests drive
pnpm fetch-models --all # also the comparison model (into .cache/models, never packaged)
pnpm test              # unit tests (Vitest; some use the real models through onnxruntime-node)
pnpm make-test-media   # makes the test clips again (the test commands make them when missing)
pnpm test:e2e          # test media if missing, pnpm build:e2e, then Chromium against a local YouTube-like player
LIVE_YOUTUBE=1 pnpm exec playwright test youtube-live   # optional smoke test on youtube.com
```

The test media are synthetic speech-over-music clips with known stems, in
`test/fixtures/generated/`. `pnpm test` and `pnpm test:e2e` generate them first when any is
missing; `pnpm make-test-media` replaces them and deletes the media the tests derived from the old
ones. Without macOS, copy that directory from a Mac.

The end-to-end tests load `.output/chrome-mv3-e2e`, built by `pnpm build:e2e` (`wxt build --mode
e2e`). That build and the dev build contain the debug bridge the tests use to read the status and
record the audio; production builds do not. `BGMR_EXTENSION=.output/chrome-mv3-dev pnpm exec
playwright test` runs them against `pnpm dev`. The tests map `www.youtube.com` to a local server with
Chromium's host-resolver rules, so the YouTube content scripts run against a test page whose
speech and music stems are known, and the output quality is measured (SI-SDR).

## Third-party components

| Component | License | Notes |
|---|---|---|
| [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet) | MIT or Apache-2.0 | Built from source to WebAssembly with about 85 Rust crates (MIT, Apache-2.0 and similar), see `vendor/deepfilternet/` |
| [UVR MDX-Net Kim_Vocal_2](https://github.com/Anjok07/ultimatevocalremovergui) | Not stated by the publisher ([TRvlvr/model_repo](https://github.com/TRvlvr/model_repo)); the UVR GUI code is MIT. Credit: UVR and its developers, model by Kimberley Jensen | Downloaded by `pnpm fetch-models` |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | MIT | Includes the third-party libraries listed in its notices |
| [WXT](https://github.com/wxt-dev/wxt) | MIT | Extension framework; its runtime helpers and `browser` object are bundled |

The package ships the license texts and copyright notices of all of these in
`public/THIRD_PARTY_NOTICES.txt`, linked from the popup (*Licenses*). `pnpm make-notices` writes
that file from `vendor/` and the installed packages (see `scripts/notices.mjs`); the unit tests fail
when it is out of date or a build bundles a package it does not cover.

The MDX-Net models were trained by the UVR community on data whose provenance is not fully
documented. Check the model licensing before any commercial distribution.
