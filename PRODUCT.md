# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Everyday viewers who install the extension from the Chrome Web Store, on desktop Chrome. They watch
YouTube videos (and sometimes videos on other sites) where the background music gets in the way of
the voices. They are not technical, never read the README, and expect the extension to just work
once they switch it on; the popup must explain what is happening in plain words.

## Product Purpose

Mute BG Audio turns down or removes the background music in videos while keeping the voices, as the
video plays. Success means the speech stays clear and natural, stays in sync with the picture, and
the viewer does not have to think about the extension after switching it on.

## Positioning

The separation runs entirely on the viewer's computer, and it is free, open source and needs no
account. On YouTube it processes the audio the player has already buffered ahead, so a high-quality
vocal model's output plays in sync with the picture instead of lagging behind like a real-time
filter.

## Operating Context

- Every tab starts off, on YouTube too (decided 2026-10-26): the user switches a tab on from the
  popup, also mid-video. On YouTube (embedded players included) and on sites chosen with "Always run
  on <site>", a tab stays on through reloads and navigation until switched off or closed; elsewhere
  a reload switches it off. Outside YouTube, "Always run on <site>" is an explicit opt-in.
- The toolbar popup is the only interface. Its controls: the per-tab switch ("Remove music on this
  tab"), a status line, "Music reduction" (0 dB to "Remove"), "Extra reduction between sentences",
  "Quality" (best available or CPU only), "Always run on <site>", the "Extension enabled" master
  switch, "Reload page" and "Use tab capture instead" when they apply, and a Licenses link. The
  toolbar icon is in colour in a tab where it is on and greyed out elsewhere; a "!" badge flags a
  video it can't process directly; the tooltip names the current mode.
- Mode names users see: Look-ahead (GPU), Real-time (CPU), Tab capture. Tab capture makes Chrome
  show its "sharing this tab" indicator.

## Capabilities and Constraints

- Chrome 137 or newer on desktop. Chrome is the only browser currently supported (Firefox was
  dropped on 2026-10-23).
- Look-ahead needs WebGPU; without it, and at playback speeds other than 1×, the real-time model is
  used. The package is about 103 MB, mostly the two models.
- A second build uses SCNet (MIT-licensed weights) instead of Kim_Vocal_2 for look-ahead: package
  about 58 MB, speech slightly less clean (about 0.4–1 dB SI-SDR), about twice the GPU time.
- Host access is requested only for YouTube; other sites go through the popup (activeTab or an
  optional per-site permission). It never asks for access to all sites up front.
- Known limits: sung lyrics are kept as voice; sound effects, laughter and ambience are reduced
  with the music; DRM-protected video and players in frames from another site can't be processed
  directly.
- The project's own code is MIT-licensed (LICENSE); bundled third-party components keep their own
  licences.
- Must be settled before Chrome Web Store publication: the publisher of the Kim_Vocal_2 model
  weights states no licence.

## Brand Commitments

- Name: **Mute BG Audio** (decided 2026-10-24). The repository and package are `mute-bg-audio`.
- Logo (assets/icon.svg, 2026-10-27): a green speech bubble with three white voice bars, in front of
  a faded music note: the voices stay in front, the music goes to the background. Its green
  (#16a34a) is the popup's accent colour. It has no text, so it reads at 16 px in the toolbar.
- On-device only: no audio, video IDs or browsing data leave the browser; no servers are involved.
- No account and no tracking: no sign-in, analytics or telemetry of any kind.
- Free and open source (MIT): public repository, no paid tier or premium features.

## Evidence on Hand

- Quality measured on synthetic test media (computer-generated speech over generated music), on one
  Mac: speech clarity gain (SI-SDR) +17 dB in look-ahead, +8 dB in real-time; music level at
  "Remove" −45 to −56 dB in look-ahead, −23 dB in real-time. Not yet measured on real-world videos
  or on Windows, Linux or slower GPUs.
- Docs: README.md, docs/ARCHITECTURE.md, public/THIRD_PARTY_NOTICES.txt.
- Assets: assets/icon.svg (the logo) and the PNG icons rendered from it by scripts/make-icons.mjs
  into public/icon.
- There are no users, reviews, ratings, store listing, store screenshots, testimonials or press
  yet. Do not invent any.

## Product Principles

1. **Works without being understood.** One switch per tab turns it on; the icon shows at a glance
   whether a tab is on, and the popup explains its state in plain words; technical detail is
   available but never required.
2. **Privacy is structural.** Nothing leaves the device, not even crash reports or usage counts.
3. **Honest about limits.** When a video can't be processed, say so plainly and offer the one thing
   that helps (tab capture, reloading the page), never a vague error.
4. **Ask for the least.** Minimal permissions, off until the user switches a tab on, nothing
   running while a video is paused, silent or muted.
5. **Free means free.** No upsell, premium badge or donation nag inside the product.
