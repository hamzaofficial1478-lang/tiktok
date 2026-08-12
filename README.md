# TikTok Downloader

A cross-platform desktop app that takes one or many TikTok links, downloads them
in a strictly ordered queue, refuses to silently duplicate work, and saves clean
video files with metadata.

**Status: phases 1-7 complete, phase 8 configured.** The app is usable end to
end: paste links, watch them download in order, browse the library, change
settings, read logs. On first run it creates a download folder for itself, so
nothing has to be configured before the first paste.

Packaging is configured and gated behind `npm run preflight`, but no installer
has been produced here: building one requires rebuilding `better-sqlite3`
against Electron's ABI, and node-gyp's header endpoint is unreachable from this
environment. See docs/SIDECARS.md for the checklist.

The UI has never been run by its author — this environment has no display — so
`npm run dev` on a real machine is the outstanding verification. The engine
underneath it is covered by 403 offline tests.

## What it does not do, on purpose

No resolution picker: the video is downloaded exactly as TikTok serves it.
No thumbnails, no metadata tags, no JSON sidecar, no hashtags. Each of those
either asked a question with no good answer or cost a full extra pass over the
file, and everything they carried already lives in the library database.

The result is that a normal download spawns **no subprocess at all** — the
bytes stream to a `.part`, get verified, and are renamed into place.

| Needs ffmpeg / ffprobe | When |
| ---------------------- | ---- |
| `ffprobe` truncation check | every download; degrades to a size check if absent |
| Watermark filtering | only when TikTok offers no clean stream |
| Outro trimming | only on watermarked sources, and off by default |
| Perceptual hash | only with "Detect reposts" turned on |

The single biggest speed lever left is **Concurrent downloads** in Settings.
It defaults to 1 because that is what makes completion order match paste order
exactly; raising it to 3 or 4 trades that guarantee for throughput.

## Getting started

```bash
npm install
npm run fetch:sidecars     # downloads yt-dlp; see docs/SIDECARS.md for ffmpeg
npm run dev
```

**[docs/RUNNING.md](docs/RUNNING.md) is the step-by-step version** — clean
machine to a downloaded, watermark-free video, including how to read the
per-item watermark badge and what to do when a video comes back watermarked.

Worth knowing up front: the normal watermark-removal path needs **only yt-dlp**.
TikTok serves most videos from a clean URL as well as a watermarked one, and the
app asks for the clean one first, so the file arrives untouched with nothing to
filter. ffmpeg is the fallback for videos where no clean stream exists.

`npm run verify` runs the typecheck and the full test suite. Both must be clean
before a phase is considered done.

### Native module note

`better-sqlite3` is the only native module that runs inside Electron, and as of
v13 it is built against **Node-API**, whose ABI is stable across both Node and
Electron versions. The npm package ships a prebuilt binary for every platform
(`node_modules/better-sqlite3/prebuilds/`) and has no install script, so there
is **nothing to compile** — no Visual Studio, no Xcode, no Python, no node-gyp.

This is why there is no `postinstall` step. An earlier version of this file ran
`electron-builder install-app-deps`, which is what older, ABI-specific
better-sqlite3 releases needed. Against v13 it compiles nothing useful and
merely fails the install on any machine without a C++ toolchain. `npm run
rebuild` remains available as a manual escape hatch if a future dependency
genuinely needs an ABI-specific build.

## Architecture

The rule that shapes everything: **the renderer never touches the filesystem,
spawns a process, or makes a network request.** Every privileged action is an
IPC call with a zod-validated payload, and state changes flow main → renderer as
push events rather than polling.

```
src/
├─ shared/           contract shared by both processes — no side effects
│  ├─ ipc/channels   channel names only; dependency-free so the sandboxed
│  │                 preload can import it without pulling in zod
│  ├─ ipc/contract   zod request/response schema per channel
│  ├─ errors         the error taxonomy; every failure maps to one code
│  └─ config-schema  AppConfig shape, bounds and defaults — the only copy
├─ main/
│  ├─ index.ts       the ONLY file that imports electron
│  ├─ services.ts    assembles the engine; constructible without Electron
│  ├─ ipc/           validating handler registry + event bus
│  ├─ db/            better-sqlite3, migration runner, repositories
│  ├─ resolve/       URL normalizer, Extractor interface + yt-dlp
│  ├─ queue/         QueueEngine, dedup layers, rate limiter, retry policy
│  ├─ download/      selection, streaming .part downloader, verify, naming
│  ├─ postprocess/   watermark tiers, outro rails, LGPL filter graphs
│  ├─ media/         sidecar resolution, ffmpeg/ffprobe wrappers
│  ├─ logging/       pino + self-contained rolling file stream
│  └─ settings/      AppConfig store with atomic writes
├─ preload/          contextBridge surface; ~1 kB, requires only electron
└─ renderer/         React + Tailwind; a synced read model, never the truth
   ├─ screens/       AddLinks, Queue, Library, Settings, Logs
   ├─ components/    primitives and the duplicate modal
   └─ store/         Zustand, hydrated from IPC events
```

`services.ts` deliberately has no Electron dependency, so the whole engine can
be booted in a test or a CLI harness. `tests/services.test.ts` does exactly
that, which is what keeps the boundary honest as the codebase grows.

## Testing

```bash
npm test
```

The suite is Electron-free and runs in a plain Node process. If a test ever
fails with `Cannot find module 'electron'`, a headless module has grown a UI
dependency — fix the module, not the test.

### Queue harness

```bash
npm run harness:queue
```

Drives the real queue engine, dedup layers, retry policy and SQLite
persistence against a fake extractor and download pipeline, printing the whole
run to the terminal. Useful for seeing the behaviours interact on one batch —
particularly that a duplicate question does not stall the items behind it.

### ffmpeg probe

```bash
npm run probe:ffmpeg
```

Phase 5's decision logic is unit tested, but the *filter graph strings* it
produces cannot be validated without a real ffmpeg — a misplaced label is a
runtime error, not a type error. This generates a synthetic clip, runs every
tier's graph against it, and reports whether each executes. It also reports
whether the installed build is GPL, which must be false for anything shipped.

### Live probe

```bash
npm run probe:live
PROBE_URLS="https://vm.tiktok.com/XXXX/,https://…" npm run probe:live
```

Skipped by default and never run in CI. The offline suite proves the logic is
right — that a `play_addr` format is classified clean, that a 404 maps to
`VIDEO_DELETED`. It cannot prove the *premise*: that TikTok still serves a
watermark-free stream at all. Only a real request answers that, so the probe
prints the actual format table and asserts a clean stream was offered.

Coverage is concentrated where bugs hide silently: URL normalization and
canonical IDs, all four dedup layers, queue ordering and position reuse, crash
recovery, retry and rate-limit schedules, `.part` handling, and the error
taxonomy's invariants.

## Continuity guarantees

The queue is built to survive interruption:

- **Sleep / screen off** — while the queue is running the app holds a
  `prevent-app-suspension` blocker, so the display may sleep but the system
  will not suspend under a running batch. Renderer background throttling is
  disabled so progress stays live with the window hidden. The blocker is
  released the moment the queue goes idle.
- **Forced sleep** (lid close, explicit sleep) cannot be blocked by any
  application. In-flight downloads are parked back to `queued` — keeping their
  `.part` files and their position — and continue on wake rather than hanging
  on dead sockets. A suspend costs no retry attempt.
- **Shutdown or crash mid-batch** — every transition is persisted. On launch,
  in-flight rows return to `queued` in position order, `.part` files resume via
  HTTP `Range`, and the queue restarts automatically if it was running at exit.
  A queue the user paused stays paused.

## Licensing constraint worth knowing before you touch post-processing

The app must ship an **LGPL** ffmpeg build, which does not contain `delogo` or
`boxblur` — both are gated on `--enable-gpl`. The watermark pipeline therefore
uses `removelogo` and `gblur`. This is enforced at runtime by the startup
capability probe. See [docs/SIDECARS.md](docs/SIDECARS.md) before changing any
filter chain or encoder.

## Roadmap

| Phase | Scope | State |
| ----- | ----- | ----- |
| 1 | Scaffold: IPC, SQLite + migrations, sidecars, logging | done |
| 2 | URL normalization + Extractor chain (headless) | done |
| 3 | Queue engine: ordering, retries, rate limiting, dedup | done |
| 4 | Download pipeline: `.part` handling, verification, templating | done |
| 5 | Post-processing: watermark filtering tiers, outro detection | done |
| 6 | UI shell: five screens on real engine state | done |
| 7 | Motion + 3D polish, 300-item performance pass | done |
| 8 | Packaging: NSIS, DMG, sidecar bundling, first run | config + preflight done; needs a real machine to build |
