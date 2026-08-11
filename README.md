# TikTok Downloader

A cross-platform desktop app that takes one or many TikTok links, downloads them
in a strictly ordered queue, refuses to silently duplicate work, and saves clean
video files with metadata.

**Status: Phase 1 of 8 — scaffold.** The engine's foundations (IPC boundary,
database, migrations, sidecar resolution, logging, settings) are in place and
tested. There is no queue, no extractor and no product UI yet.

## Getting started

```bash
npm install
npm run fetch:sidecars     # downloads yt-dlp; see docs/SIDECARS.md for ffmpeg
npm run dev
```

`npm run verify` runs the typecheck and the full test suite. Both must be clean
before a phase is considered done.

### Native module note

`better-sqlite3` is a native module and must be compiled against Electron's ABI,
not Node's. `npm install` handles this via `electron-builder install-app-deps`.
If the app starts with a `NODE_MODULE_VERSION` mismatch, run `npm run rebuild`.

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
│  ├─ media/         sidecar resolution, ffmpeg capability probe
│  ├─ logging/       pino + self-contained rolling file stream
│  └─ settings/      AppConfig store with atomic writes
├─ preload/          contextBridge surface; ~1 kB, requires only electron
└─ renderer/         React 18 + Tailwind; a synced read model, never the truth
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

Coverage is concentrated where bugs hide silently: migrations and rollback,
queue ordering and position reuse, crash recovery, dedup lookups, config
validation, IPC payload rejection, and the error taxonomy's invariants. URL
normalization, dedup and queue state transitions get their own dedicated suites
in phases 2 and 3.

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
| 3 | Queue engine: ordering, retries, rate limiting, dedup | next |
| 4 | Download pipeline: `.part` handling, verification, templating | |
| 5 | Post-processing: stream selection, watermark, outro | |
| 6 | UI shell: five screens on real engine state | |
| 7 | Motion + 3D polish, 300-item performance pass | |
| 8 | Packaging: NSIS, DMG, sidecar bundling, first run | |
