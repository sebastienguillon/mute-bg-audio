# Architecture

Chrome-only Manifest V3 extension (WXT + TypeScript, pnpm). It removes or reduces background
music in web video while keeping speech. Everything runs on the user's device.

## Processing modes

| Mode | Where | Model | Added latency | When |
|---|---|---|---|---|
| **Look-ahead** | YouTube | UVR MDX-Net vocal model Kim_Vocal_2, or SCNet (one per build, see "Look-ahead models"; ONNX Runtime Web, WebGPU) | none: output leads by the sink latency, in sync with the picture | YouTube, WebGPU available, the element plays at 1×, audio already buffered ahead |
| **Real-time** | YouTube + any tappable `<video>`/`<audio>` | DeepFilterNet3 (WASM, CPU) | L = 60 ms (more on devices with large audio buffers) | The fallback and standby while sound plays |
| **Tab capture** | Any site (Chrome `tabCapture`) | DeepFilterNet3 | L + capture | Media that cannot be tapped (cross-origin without CORS, some DRM, players in cross-origin frames); needs an action click. In-page processing of the tab stands down meanwhile |
| **Pass-through** | – | none | L | Enabled, but no model output for these frames (the real-time worker is still loading its model, or skipped a hop) |
| **Bypass** | – | none | 0 | Disabled, or the real-time worker stopped answering (and no look-ahead output) |
| **Idle** | – | none | – | 0.5 s of digital silence (paused, ended, a silent passage): no hops and no probes until sound returns |

Both model paths produce a *speech estimate* `s` and the output is a remix:

```
out = s + g · (x − s)        (real-time; x = original input, s = mono speech estimate)
out = v · (s + g · r)        (look-ahead; s = compensate · model vocals, r = residual = mix − s, v = measured element gain)
g   = 10^(−reductionDb/20)    (reductionDb = 60 means "remove": g = 0)
```

An optional gate lowers `g` further (default −12 dB extra) when no speech is present, which hides
separation artifacts in music-only passages.

Nothing runs without sound: muted or volume-0 elements do not start the engine
(`PlayheadInfo.audible`), the look-ahead model does not run while the element is inaudible or
plays at another speed than 1×, and after 0.5 s of digital silence the mixer reports `idle` and
stops sending hops and probes until sound returns. The look-ahead worker releases its model
session after a minute without a model run, and the controller releases the whole engine after
five minutes without audible playback. A tab switched off (popup or master switch) gets its
direct element → speakers path back, without the worklet; its engine is released after a minute
and recreated on demand.

## Components and data flow (YouTube)

```
YouTube page (renderer)
├─ MAIN world: src/entrypoints/youtube-hook.content.ts (document_start, all YouTube frames)
│    wraps MediaSource.addSourceBuffer / SourceBuffer.appendBuffer|abort|remove|changeType,
│    URL.createObjectURL and HTMLMediaElement.srcObject; posts copies of *audio* appends to the
│    ISOLATED world over a private MessagePort (see "The MSE hook" below)
├─ ISOLATED world: src/content/controller.ts (MediaController, "the controller"), started by
│  youtube.content.ts (generic.content.ts on other sites) through src/content/start.ts, one per frame
│    • owns the page AudioContext (48 kHz) and the AudioWorkletNode (worklet.js)
│    • createMediaElementSource(video) once per element, only when ctx.state === 'running'
│    • injects the hidden engine iframe (chrome-extension://…/engine.html)
│    • forwards audio appends + playhead/state to the engine; relays settings/status
│    • tells the mixer whether the element plays normally (`playback`, see below)
│    • AudioWorkletNode ── port ──► MixerCore (src/lib/mixer/mixer-core.ts)
└─ engine iframe (extension origin, OOPIF): src/entrypoints/engine/
     ├─ realtime.worker.ts   DeepFilterNet3 WASM, 480-sample hops (10 ms) of the mid channel
     └─ lookahead.worker.ts  demux (WebM/fMP4) → WebCodecs AudioDecoder → PcmStore (48 kHz)
                             → MdxStream (resample 44.1 kHz, chunk codec: STFT, ONNX WebGPU,
                               iSTFT; OLA) with the build's model (src/lib/lookahead/models.ts)
                             → blocks {speech, residual} sent to the worklet; answers alignment probes
```

The worklet talks **directly** to both workers through transferred MessagePorts (no main-thread hop).
SharedArrayBuffer is not available in the YouTube page (not cross-origin isolated), so all
audio crosses threads as transferred `Float32Array`s.

### The MSE hook

The hook keeps, per audio SourceBuffer, the latest init segment and the most recent media appends
(up to 4 MiB each, 24 MiB in all). The controller connects with `window.postMessage({
__bgmr_hook_connect__: true }, '*', [port])` (`HookBridge.connect`) every time it starts an engine,
and again when look-ahead is switched back on after its worker dropped its audio. The hook accepts
every handshake from its own window: the new port replaces the previous one, and the hook replays
the MediaSource URLs, SourceBuffers, init segments and recent appends to it. That is how a new
engine gets the audio the player appended before it existed. Because of this, a page script that
posts a handshake of its own takes the hook over. The controller's port then stays silent and
look-ahead has nothing to process on that page, which falls back to real-time processing. The
hook's listener is registered before any page script runs and stops the event, so page scripts
do not see the controller's handshake or its port.

### The engine connection

The page sees the engine iframe and could answer its HELLO itself, so the engine only accepts a
CONNECT that carries a one-time token: the controller registers a random token with the
background (`engine-token`, reply `{ ok }`), then posts `{ type: 'bgmr-engine-connect', token }`;
the engine asks the background (`engine-verify`, reply `{ ok }`), which accepts a token once,
within 60 s, from an engine iframe embedded in the tab the token was issued for. Tokens are kept
in memory and in `storage.session`, so a service-worker restart in between does not matter.

### Timelines and synchronisation

* **Frame index `f`**: the worklet's running count of input frames (48 kHz). It stays below
  2^29 (3.1 h): there the mixer moves its whole frame domain back by a multiple of 2^28 (lock
  offsets forward by the same amount), so that frame numbers remain small integers and
  `process()` does not start allocating in long sessions.
* **Output latency `L`** (real-time and pass-through): the worklet outputs, at frame `f`, the
  processed version of input frame `f − L`. `L = DFN_DELAY (1440) + jitter`. The initial jitter is
  `max(1440, baseLatency · 48000 + 960)` (passed as `processorOptions.jitter`, so it covers the
  audio callback), giving 60 ms on most devices. Repeated underruns grow it by 10 ms steps; a
  minute without underruns shrinks it again.
* **Sink latency `D`** (`MixerConfig.outputLatency`): `(ctx.baseLatency + ctx.outputLatency) ·
  48000`, refreshed by the controller. Chrome delays the picture by the audio latency only for
  media it plays itself, not for media routed through Web Audio.
* **Media index `m`**: `round(pts · 48000)` within one MediaSource *timeline* (`timelineId` = the
  MediaSource id; ads use separate MediaSources so they get separate timelines).
* **Lock**: look-ahead output requires knowing `m = f + offset` for the current input. The
  worklet sends a *probe* (last 4096 mono input samples + `frameEnd`, every 250 ms while
  unlocked) to the look-ahead worker, which cross-correlates it against decoded PCM near the
  playhead and returns `{ timelineId, mediaEnd, gain }`. The worklet then verifies the lock
  continuously by comparing its input against `gain · (speech + residual)` at `f + offset`; a
  mismatch for about 20 ms (8 quanta: a seek, an ad switch, a glitch) drops the lock, and
  look-ahead output stops as soon as the newest input quantum does not match. When the output
  device runs at another rate than the AudioContext (44.1 kHz, e.g. MacBook speakers), Chrome
  resamples the element's audio, and the input lies a fraction of a frame from the decoded media,
  a fraction that changes with every start of playback (steps of 128 frames at the device rate)
  and drifts slowly (about one frame per 28 minutes in the recordings measured). Verification
  therefore reads the media at `f + offset + δ` through a 9-tap windowed-sinc interpolator, with
  the lock's sub-frame delay δ refined from the good quanta; when δ passes ±0.75 the integer
  offset moves by one frame instead. Compared at whole frames, treble transients (cymbals,
  sibilants) fail as δ approaches half a frame, and each failed quantum interrupts look-ahead
  output (a hold, or bypass for up to 1.5 s while the real-time worker is unhealthy). Look-ahead
  output stays at whole frames (δ is below 21 µs).
* **Playback state**: the controller sends `{ type: 'playback', playing }` for the current
  element whenever it changes (and after every worklet or worker connection); `playing` means
  not paused, not seeking, not ended, `readyState` ≥ HAVE_FUTURE_DATA and `playbackRate` 1.
  `playing: false` drops the lock at once and stops probing, so a pause cannot let look-ahead
  output run on into content the element has not played. While the element plays, silence in
  the content keeps the lock (the mixer idles, and look-ahead output continues in sync after
  the gap). Exact digital silence in the input while the media at that position is not silent
  counts as a mismatch, which catches a pause whose message is late.
* **A/V sync**: while locked, the output at frame `f` is the processed media sample
  `m = f + offset + D`: what the element presents now plus the sink latency, so look-ahead audio
  is heard with the picture (no added delay at all). Look-ahead therefore needs blocks up to `D`
  ahead of the input. Real-time output stays `L + D` behind. Every switch is crossfaded over
  10 ms, and a switch that moves back in the content (look-ahead → real-time, bypass → a
  delayed source) holds silence until the new source reaches content not heard yet.
* **Planned switches**: entering look-ahead output skips `L + D` of content; leaving it after
  look-ahead was turned off, or a change of `D` by more than 50 ms, skips or holds content too.
  These switches wait for a moment where what is skipped or held contains no speech: the mixer
  scans the speech of the stored blocks ahead (32-frame cells, bounded work per quantum) for up
  to 1.5 s, and otherwise takes the quietest candidate. Urgent switches (the input stopped
  matching, no blocks, `playing: false`, disabled) happen at once.
* **Health**: hops go to a real-time worker only after it said `ready` on the current
  connection (its model is loaded). A connected worker that has not said `ready` within 10 s, or
  one that gets hops but sends no speech back for 1 s, is unhealthy: `MixerStats.rtHealthy`
  turns false, the output bypasses (zero latency) unless look-ahead output plays, and only one
  hop per 250 ms is sent until the worker answers again. Idle does not reset this state.

### Look-ahead models

A build contains one look-ahead model, chosen when building with `LOOKAHEAD_MODEL`: `kim`
(default, UVR MDX-Net Kim_Vocal_2) or `scnet` (SCNet base, vocals; `vendor/scnet/`).
`wxt.config.ts` verifies and packages only that model's file, packages that build's notices as
`THIRD_PARTY_NOTICES.txt`, writes to its own output directory and zip (suffix `-scnet`), and
defines `import.meta.env.LOOKAHEAD_MODEL`, from which `lookahead.worker.ts` takes the model at
compile time (the other model's code is not in the bundle).

Everything model-specific is in the model's entry in `src/lib/lookahead/models.ts`
(`LookaheadModel`): the file, the sample rate (44.1 kHz for both), the chunk size and tensor shape,
a factory for its `ChunkCodec` (stereo chunk ↔ model tensors), the stream settings and
`compensate`. `LookaheadCore` builds its `MdxStream` from it; the worker takes the tensor shape for
ONNX Runtime and the chunk duration for the run timeout (5 × the audio of a chunk) from it.

| | Kim_Vocal_2 | SCNet |
|---|---|---|
| Codec | `MdxChunkCodec`: periodic Hann STFT (nFft 7680, hop 1024), bins 0..3071 with 0..2 zeroed, `[1, 4, 3072, 256]` | `ScnetChunkCodec`: chunk zero-padded to 441,344 samples, rectangular normalized STFT (nFft 4096, hop 1024), all 2049 bins, `[1, 4, 2049, 432]` |
| Chunk | 261,120 samples (5.9 s) | 441,000 samples (10 s) |
| Overlap-add | 25 % overlap, `np.hanning` weights (demix()) | 25 % overlap, triangle weights (demucs apply_model()) |
| Chunk level | peak-normalised before the model, vocals scaled back | as is (the graph normalises each chunk) |
| Context before the origin (`trim`) | 3840 samples (nFft / 2) | 2048 samples (nFft / 2) |
| `compensate` | 1.009 | 1 |

`MdxStream` itself is model-agnostic: it schedules chunks on a grid anchored at the origin,
resamples 48 ↔ 44.1 kHz, skips the model for silent chunks and overlap-adds with a divider, so the
seams between blocks are exact whatever the weights. With SCNet a block is 7.5 s (one chunk step),
and the input of the next chunk reaches 2.5 s beyond what it finalises (Kim_Vocal_2: 4.4 s and
1.5 s). For both, when less audio is decoded than a chunk needs and the processed audio left
ahead of the playhead is less than 3 s plus one model run (a chunk step times the measured
real-time factor: 4.5 s for SCNet at 0.6, 2.7 s for Kim_Vocal_2; 3 s alone until the speed is
measured), the chunk runs with silence after the decoded audio, so that its run ends before the
processed audio does, unless the decoder still owes audio the page has appended
(`MseAudioIngest.decoding`, e.g. the hook's replay when the engine starts): then the chunk waits
for it, so that the first block is a whole chunk's and not the few seconds decoded so far. Chunks
run cut at the end of every video, and often when the page buffers little ahead (live streams,
limited bandwidth). A cut chunk adds less new audio than a whole one, so a short page buffer
costs more model runs (SCNet at 0.6 with 9 s buffered: a third more), and the margin cannot close
every gap: with less than about two runs plus the 3 s buffered ahead, the runs follow each other
with less than 3 s to spare, and with less than about two runs (9 s for SCNet at 0.6) the blocks
run out before each run ends.

### Engine lifecycle (controller)

* **Start**: on the first audible playback of a routed element while the tab is enabled. The
  controller creates the iframe, waits for the token handshake (above), sends `init`, gives the
  worklet fresh ports to both workers (`connect-rt`, `connect-la`, `connect-worklet`), sends the
  playback state and, on YouTube, connects the hook. The engine answers `ready` once it has
  started its workers; the real-time worker loads DeepFilterNet right away and reports
  `realtime.ready` in the engine's `status` when it accepted the worklet's port.
* **Real-time worker restart** (`restart-realtime`): only while real-time output is what is heard
  (hops flow, no look-ahead lock). When a worker that was ready has been unhealthy for 3 s, or
  one has not got ready (and reported no error) within 20 s, the controller gives the worklet a
  new `connect-rt` port and sends the other end with `restart-realtime`. The engine terminates
  the real-time worker and starts a new one on that port; the look-ahead worker and its work
  stay. At most once per minute.
* **Engine replacement**: the whole engine is replaced when it has not said `ready` within 20 s,
  when its iframe is gone, or when it sent nothing for 10 s while hops flow to a real-time worker
  that was ready. At most once per minute; an engine that failed to start is retried after a
  minute.
* **Release**: after a minute with the tab disabled or five minutes without audible playback;
  the next audible playback starts a new one. Look-ahead switched off for more than a minute
  (quality 'realtime', tab off) makes the look-ahead worker drop its decoded audio; switched on
  again, the controller reconnects the hook so that the worker gets the replay.

## Module map

| Path | Responsibility |
|---|---|
| `src/lib/constants.ts` | Shared numeric constants |
| `src/lib/settings.ts` | Settings schema, defaults, storage helpers |
| `src/lib/protocol.ts` | All cross-context message types |
| `src/lib/tab-status.ts` | Status aggregation over frames, toolbar icon and badge, page classification, popup strings |
| `src/lib/dsp/fft.ts` | Mixed-radix complex FFT (radix 2/3/4/5 + generic), real FFT helpers |
| `src/lib/dsp/stft.ts` | `torch.stft`/`torch.istft`-compatible STFT (center, reflect pad, periodic Hann or rectangular window, optionally normalized) |
| `src/lib/dsp/resample.ts` | Windowed-sinc resampler (48 kHz ↔ 44.1 kHz), zero-phase, block API with margins |
| `src/lib/dsp/align.ts` | FFT cross-correlation alignment of a probe against reference PCM |
| `src/lib/demux/index.ts`, `types.ts` | Demuxer selection by SourceBuffer mime type; shared types and byte queue |
| `src/lib/demux/webm.ts`, `mp4.ts` | Incremental demuxers producing codec config + timestamped frames |
| `src/lib/demux/opus.ts` | Opus packet durations (TOC byte) and the OpusHead header |
| `src/lib/lookahead/lookahead-core.ts` | Look-ahead worker logic: ingest, model scheduling ahead of the playhead, blocks, probes, status |
| `src/lib/lookahead/models.ts` | The look-ahead models (`LookaheadModel`): file, codec, tensor shape, stream settings, compensate |
| `src/lib/lookahead/ingest.ts` | Hook messages → demuxer → decoder runs → PCM per timeline (MediaSource) |
| `src/lib/lookahead/frame-store.ts` | Encoded frames kept per SourceBuffer, to decode evicted audio again |
| `src/lib/lookahead/pcm-writer.ts` | Writes one decoder's output into a PcmStore, seamlessly |
| `src/lib/lookahead/pcm-store.ts` | Media-indexed stereo PCM ranges with eviction |
| `src/lib/lookahead/stream-resampler.ts` | Block-wise resampling of a continuous stream with exact seams |
| `src/lib/mdx/mdx.ts` | Model contract (`MdxBackend`, `ChunkCodec`, backend errors); MDX-Net pre/post-processing (`MdxChunkCodec`) |
| `src/lib/mdx/scnet.ts` | SCNet pre/post-processing (`ScnetChunkCodec`: end padding, rectangular normalized STFT) |
| `src/lib/mdx/mdx-stream.ts` | Streaming chunk scheduler with overlap-add (Hann or triangle weights), 48 kHz in/out |
| `src/lib/mdx/session-backend.ts` | Model session lifecycle: lazy creation, timeouts, release after failures |
| `src/lib/realtime/dfn.ts` | DeepFilterNet3 WASM wrapper (vendor/deepfilternet) |
| `src/lib/realtime/rt-processor.ts` | Real-time worker logic: worklet hops in, delay-compensated speech out |
| `src/lib/mixer/mixer-core.ts` | Pure, testable AudioWorklet core: timeline, remix, gating, lock, crossfades, idle, health |
| `src/lib/mixer/block-store.ts` | Look-ahead blocks per timeline, as the mixer reads them |
| `src/content/controller.ts` | The page controller (see above): routing, audio graph, engine lifecycle, status |
| `src/content/start.ts` | One controller per frame; a script injected again takes the running one over |
| `src/content/engine-client.ts` | Engine iframe and its HELLO/CONNECT token handshake |
| `src/content/hook-bridge.ts` | ISOLATED-world end of the MSE hook |
| `src/content/media.ts` | Media element helpers: tappability probe, audibility, shadow roots, hosts |
| `src/content/runtime.ts` | Extension messaging that survives the extension being reloaded or removed |
| `src/content/status.ts` | Status helpers: change keys, the mixer's state as a tab status |
| `src/content/debug-bridge.ts` | Debug bridge for the end-to-end tests (non-production builds only) |
| `src/entrypoints/youtube-hook.content.ts` | MAIN-world MSE hook (YouTube frames) |
| `src/entrypoints/youtube.content.ts`, `generic.content.ts` | Content scripts starting the controller |
| `src/entrypoints/engine/` | Engine iframe: `main.ts` (connect gate, workers), `realtime.worker.ts`, `lookahead.worker.ts` |
| `src/entrypoints/worklet.ts` | AudioWorkletProcessor around MixerCore |
| `src/entrypoints/background.ts` | Service worker: tab status, switches, icon and badge, generic script injection, auto sites, tab capture, engine tokens |
| `src/entrypoints/popup/`, `offscreen/` | Toolbar popup; tab-capture document |
| `scripts/` | `fetch-models.mjs` + `models.mjs` (model download, hashes, the build of each look-ahead model), `with-model.mjs` (runs a command with `LOOKAHEAD_MODEL` set, in any shell), `make-test-media.mjs`, `make-notices.mjs` + `notices.mjs` (third-party notices of each build), `build-dfn-wasm.sh`, `bench-mdx.mjs`, `make-icons.mjs` |
| `vendor/scnet/` | SCNet license, provenance and the scripts that make `public/models/scnet_vocals.onnx` |

## Pages, tabs and the background

* **Where it runs.** Every tab starts off. The YouTube scripts (`*.youtube.com`,
  `*.youtube-nocookie.com`, all frames) run on every YouTube page but route nothing until the
  tab is switched on; the MAIN-world hook keeps what the player buffers meanwhile, so switching
  on in the middle of a video still gets look-ahead. Elsewhere the popup injects `generic.js`
  into every frame Chrome lets it access (`enable-on-tab`, `scripting.executeScript` with
  `allFrames`; when the page itself refuses it, the frames that run a script of their own,
  YouTube embeds, still get the command), or registers it for the sites chosen under *Always
  run on*, where it starts on. A frame that already runs the YouTube controller gets no second
  controller. The popup asks the top frame first (`tab-command` with `frameId: 0`), so a YouTube
  embed answering does not hide that the page itself needs the generic script; *disable* goes to
  every frame. Media in a cross-origin frame that cannot be scripted is reported as
  `unsupported` / `needsTabCapture` ("The video plays in a frame from …"), and the popup makes
  tab capture its primary action. Routed media that became unreadable (its source turned
  cross-origin or protected, or it only delivers silence) is `unsupported` without
  `needsTabCapture`: the tab plays that silence, so capture would record it too, and the popup
  offers no capture; the detail asks for a reload.
* **The tab's switch.** Before its commands, the popup tells the background (`set-tab-enabled`),
  which keeps the switch per tab in `storage.session` until the tab closes. Controllers ask for it
  when they start (`get-tab-state`, reply `{ capture, enabled }`; `enabled` is null in a tab the
  user never switched). Where a controller starts by itself (YouTube pages and embeds, *Always run
  on* sites), a reload, a page the tab navigates to or a frame added later therefore starts the way
  the user left the tab: a generic script on an *Always run on* site starts on unless the tab was
  switched off, the YouTube scripts start off unless it was switched on. On other sites the popup
  injected the generic script once; nothing injects it again after a reload, so the frames that ran
  it stay off until the tab is switched on again (YouTube embeds there start as above). When nothing
  could start, the popup sets the switch back off, as its toggle shows.
* **Status.** Every controller reports `tab-status` when its status changes (look-ahead progress
  is rounded for this) and every 30 s while not off. The background keeps the latest status per
  frame, aggregates them (`aggregateTabStatus`), sets the toolbar icon (in colour while the
  aggregate is enabled, the manifest's greyed-out `default_icon` otherwise; both are rendered
  from `assets/icon.svg` by `scripts/make-icons.mjs`), a "!" badge when the media needs tab
  capture or cannot be processed, and the tooltip, and answers the popup's
  `get-tab-status` (polled every second). State lives in `storage.session`, written only when the
  status changes beyond the look-ahead progress. A report from a new top-frame document drops
  the subframe statuses of the previous one; the top frame's first report keeps them (embeds
  start at document_start and often report first). After a load completes the background probes
  each known frame's document and drops the frames that no longer run a script.
* **Tab capture.** The offscreen document captures the tab (`tabCapture.getMediaStreamId` +
  `getUserMedia`), runs the same worklet with DeepFilterNet and plays the result. The background
  sends `{ type: 'capture-state', active }` to all frames of the tab when a session starts and
  ends; the controllers then behave as switched off (direct path) and report `off` with "Tab
  capture is processing this tab." Scripts that start later learn it from `get-tab-state` (also
  right after a service-worker restart).

## Security and builds

* The engine CONNECT token (above) keeps pages from driving the extension's engine. The pages
  can still load the web-accessible `engine.html` and `worklet.js` (so detect the extension);
  `use_dynamic_url` would prevent that, but needs the content script to expect the engine at the
  static extension origin (Chrome redirects the dynamic URL there).
* The debug bridge (`window.postMessage({ __bgmr_debug: 'status' | 'record' })`, used by the
  end-to-end tests on pages that set `<html data-bgmr-debug="1">`) exists only in builds whose
  `import.meta.env.MODE` is not `production`: `pnpm build:e2e` (`wxt build --mode e2e`, output
  `.output/chrome-mv3-e2e`) and `pnpm dev` (`.output/chrome-mv3-dev`).
* Extension pages are served with `Cross-Origin-Embedder-Policy: require-corp`
  (`cross_origin_embedder_policy` in the manifest), so the engine iframe and its workers also
  start inside cross-origin-isolated pages. In `pnpm dev` the pages load their modules and
  stylesheets from the dev server, which therefore sends `Cross-Origin-Resource-Policy:
  cross-origin` (stylesheets are no-cors requests; `vite.server.headers` in `wxt.config.ts`).
* Dev server: a `chrome-extension://` page cannot start a worker from the dev server's origin, so
  the engine and the capture document start their module workers from a same-origin blob that
  imports the dev-server script (`src/entrypoints/engine/worker-url.ts`; builds use the worker
  chunk directly). ONNX Runtime is left out of Vite's dependency pre-bundling, because it imports
  its WASM loader from next to its own module.
* Every build checks its look-ahead model (`public/models/Kim_Vocal_2.onnx`, downloaded by
  `pnpm fetch-models`, or the committed `public/models/scnet_vocals.onnx`) against its SHA-256
  (from `scripts/models.mjs`) and leaves any other file in `public/models/` out of the package.
* Third-party notices ship as `THIRD_PARTY_NOTICES.txt`, linked from the popup: the build's own
  file (`public/THIRD_PARTY_NOTICES.txt`, or `public/THIRD_PARTY_NOTICES-scnet.txt` for SCNet), so
  that they name the look-ahead model the package contains. `scripts/make-notices.mjs` writes them
  from `vendor/` (license texts of the installed ONNX Runtime and WXT versions, DeepFilterNet and
  the Rust crates in its WASM build, SCNet) and the installed packages. A unit test fails when a
  committed file differs from what the script writes, or when a build (with source maps) bundles
  an npm package the notices do not cover.

## Constraints every module must respect

* Chrome only. No Firefox shims.
* No network access at runtime: models, WASM and runtimes are bundled in the extension package.
* Nothing is stored or uploaded: audio stays in memory, in the tab.
* Library code under `src/lib` must be pure TypeScript usable in Node (Vitest) and in workers/worklets:
  no `chrome.*`/`browser.*`, no DOM, except in files that say otherwise.
* AudioWorklet code must not allocate in the steady-state `process()` path beyond what is noted.
