# Sidecar binaries

The app ships three external binaries and never depends on the user having them
installed:

| Binary   | Purpose                          | Source                              |
| -------- | -------------------------------- | ----------------------------------- |
| `yt-dlp` | extraction / stream resolution   | upstream standalone release binary  |
| `ffmpeg` | watermark filtering, trimming    | **must be an LGPL build** — see below |
| `ffprobe`| integrity + duration verification| same build as ffmpeg                |

They live at `resources/bin/<platform>-<arch>/` and are verified at startup
against `resources/bin/manifest.json`. Neither the binaries nor the manifest are
committed; run `npm run fetch:sidecars` to populate them.

## The ffmpeg licensing constraint

Section 3 of the brief requires an **LGPL** ffmpeg build, invoked as a separate
process, because a GPL build would extend GPL obligations to a closed-source
commercial product.

This is not a formality — it changes which filters exist. Verified against
ffmpeg's own `configure`:

```
boxblur_filter_deps="gpl"
delogo_filter_deps="gpl"
smartblur_filter_deps="gpl"
```

**An LGPL build does not contain `delogo` or `boxblur`.** The watermark pipeline
therefore uses the LGPL-clean equivalents, all confirmed to support the timeline
`enable=` flag that time-segmented watermark removal depends on:

| Role                            | GPL filter | LGPL replacement used here |
| ------------------------------- | ---------- | -------------------------- |
| Tier 1 — interpolate the region | `delogo`   | `removelogo`               |
| Tier 2 — blur the region        | `boxblur`  | `gblur`                    |
| Composite the region back       | —          | `overlay` (+ `crop`, `split`) |

Encoding for the re-encode fallback must use a hardware encoder
(`h264_nvenc`, `h264_qsv`, `h264_videotoolbox`, `h264_amf`) or `libopenh264`.
**Never `libx264`/`libx265`** — those are why the convenient prebuilds are GPL.

`src/main/media/capabilities.ts` probes for all of this at startup and reports
`isGplBuild` plus any missing filters, so a wrong build is caught at install
time rather than mid-batch.

## Configuring ffmpeg sources

**The app installs ffmpeg for you.** Settings shows an *Install ffmpeg* button
whenever it is missing, which fetches BtbN's **LGPL** build, verifies it runs,
and installs it under the user's app-data folder. Nothing below is needed for
normal use.

An earlier version of this page claimed every convenient prebuild was GPL and
that an LGPL build therefore had to be compiled by hand. That was wrong, and it
is why the sidecar had to be configured manually for so long. BtbN publishes an
explicit LGPL variant alongside the GPL one, and it was verified to carry
exactly what this pipeline needs:

| Checked | Result |
| ------- | ------ |
| `--enable-gpl` in the build configuration | absent |
| `removelogo`, `gblur`, `overlay`, `crop`, `split` | all present |
| `delogo`, `boxblur` (GPL-only) | absent, confirming it is genuinely the LGPL build |
| H.264 encoders | libopenh264, h264_nvenc, h264_qsv, h264_amf, h264_vaapi |

macOS is the exception: no LGPL prebuild is published for it, so the installer
reports that rather than silently fetching a GPL one.

## Configuring a different source by hand

Only needed to pin a specific build, or on a platform the installer does not
cover. Create `resources/sidecar-sources.json`:

```json
{
  "win32-x64":    { "ffmpeg": "https://…/ffmpeg.exe", "ffprobe": "https://…/ffprobe.exe" },
  "darwin-arm64": { "ffmpeg": "https://…/ffmpeg",     "ffprobe": "https://…/ffprobe" },
  "darwin-x64":   { "ffmpeg": "https://…/ffmpeg",     "ffprobe": "https://…/ffprobe" },
  "linux-x64":    { "ffmpeg": "https://…/ffmpeg",     "ffprobe": "https://…/ffprobe" }
}
```

Options for obtaining LGPL builds, in rough order of effort:

1. Build from source with `--disable-gpl --enable-libopenh264` plus the
   platform hardware encoder flags. Most control, reproducible, needs CI.
2. Use a vendor that publishes LGPL variants explicitly and check
   `ffmpeg -buildconf` for the absence of `--enable-gpl` before trusting it.

Whichever you pick, the startup probe is the backstop: if `isGplBuild` comes
back `true`, that build must not ship.

## Updating the extractor

Section 2 requires a one-click "Update extractor" that pulls the latest
`yt-dlp`, because a stale extractor is the most likely cause of a support
ticket. That action re-downloads only the `yt-dlp` binary for the current
platform and rewrites its manifest entry — it is the same code path as
`node scripts/fetch-sidecars.mjs --only=yt-dlp`.

## Packaging checklist

```bash
npm install          # rebuilds better-sqlite3 for Electron's ABI
npm run fetch:sidecars
npm run preflight    # refuses to package a build that would ship broken
npm run dist:win     # or dist:mac
```

`preflight` is wired into both `dist:*` scripts, so a packaging run cannot
skip it. It blocks on the things that produce a *working installer of a broken
app*:

- a missing `yt-dlp` (the app could not download anything)
- a sidecar whose checksum does not match the manifest
- **a GPL ffmpeg build**, which must never ship
- an ffmpeg missing `removelogo`, `gblur`, `overlay`, `crop`, `split`
- a preload that requires anything from `node_modules` (a sandboxed preload
  cannot resolve it, and the window would come up blank)

Icons in `build/` (`icon.ico`, `icon.icns`, `icon.png`) are warnings rather
than failures — electron-builder substitutes its own default if they are
absent, which is fine for a test build and not for a release.
