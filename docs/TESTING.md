# Testing this app on your machine

Nothing below can be run in the environment this was built in: there is no
display, no ffmpeg, and TikTok is unreachable. These are the checks that only
you can make.

## 1. Get it running (5 minutes)

```bash
npm install            # also rebuilds better-sqlite3 for Electron's ABI
npm run fetch:sidecars # downloads yt-dlp
npm run dev
```

**If `npm install` fails on better-sqlite3**, run `npm run rebuild`.
**If the window is blank**, open DevTools (Ctrl+Shift+I) and check the console
— a preload failure shows up there and nowhere else.

At this point the app should already have created a download folder for
itself, so nothing needs configuring before the first paste.

## 2. The smoke test — does it actually download? (5 minutes)

Paste **one** link you own into Add links, and press Add.

Watch for: the row appears, progress moves, status ends `completed`, and the
file is in the folder shown in Settings. That single path exercises URL
normalisation, the extractor, the queue, the downloader, verification and
filename templating in one go.

If it fails, the Logs screen has the reason and the row's "Copy diagnostic"
button has everything needed to explain it.

## 3. The things most likely to be wrong

These are ranked by how likely they are to be broken, because they are the
parts that could never be exercised here.

| # | Test | Why it is suspect |
|---|------|-------------------|
| 1 | **Look at every screen.** Add links, Queue, Library, Settings, Logs. | The UI has never been rendered. Layout, contrast and overflow are entirely unverified. |
| 2 | **Paste 200 links.** Do they appear in the exact order pasted? Does scrolling stay smooth? | Virtualisation and the 60fps target were never measured on a real GPU. |
| 3 | **Download the same link twice.** The second should raise the duplicate question and the queue should keep moving behind it. | The engine logic is tested; the modal wiring is not. |
| 4 | **Press "Later" on that question**, then click the count in the header. | Two bugs were just fixed here. |
| 5 | **Quit mid-batch, reopen.** The queue should restore in order and carry on by itself. | Tested headlessly, never through the real Electron lifecycle. |
| 6 | **Turn on Reduce effects in Settings.** All motion should stop and the 3D background should disappear. | |
| 7 | **`npm run probe:live`** with your own links. | Confirms TikTok still serves a watermark-free stream — the premise the whole design rests on. |

## 4. Only if you obtain ffmpeg

```bash
npm run probe:ffmpeg
```

Generates a clip and runs every watermark filter graph against it. Those graphs
are strings no type checker can validate, so this is the only thing that proves
they execute. It also reports whether the build is GPL, which must be **false**
for anything you ship.

Without ffmpeg the app still works: verification falls back to a size check and
watermark filtering is unavailable. Since TikTok usually serves a clean stream,
most downloads never needed it.

## 5. Before building an installer

```bash
npm run preflight
```

Blocks on anything that would ship a working installer of a broken app. It is
wired into `npm run dist:win` and `npm run dist:mac`, so it cannot be skipped.

## What to send back if something breaks

- The Logs screen export, or the row's "Copy diagnostic"
- A screenshot for anything visual
- What you did and what you expected

Layout problems and crashes are cheap to fix and hard to guess at, so a
screenshot is worth more than a description.
