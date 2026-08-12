# Running it locally

A step-by-step from a clean machine to a downloaded, watermark-free video.
Everything here has been run except the final Electron window — this build
environment has no display, so `npm run dev` is the one step you are verifying
for the first time.

---

## The one thing to understand before you start

**Watermark removal does not use ffmpeg on the normal path.**

TikTok serves most videos from two different URLs. One has the spinning
username watermark burnt into the pixels, one does not. `yt-dlp` can see both,
and this app always asks for the clean one first. When it gets it, the file is
downloaded byte for byte and never re-encoded — no filtering, no quality loss,
no extra pass over the video, no subprocess at all.

So the only binary you actually need is **yt-dlp**. ffmpeg is a fallback for
the minority of videos where no clean stream is offered.

| What you want | What you need |
| ------------- | ------------- |
| Watermark-free downloads (the normal case) | yt-dlp |
| Watermark filtered out when there is no clean stream | yt-dlp + ffmpeg |
| Truncated-file detection | ffprobe (falls back to a size check) |

---

## Step 1 — Install the prerequisites

**Node.js 20 or newer.** Check with:

```bash
node -v
```

If it prints anything lower than `v20`, install the LTS from
<https://nodejs.org>. Developed against v22.

**Git**, from <https://git-scm.com> if you do not already have it.

**That is the whole list.** No Visual Studio, no C++ build tools, no Python.
The one native module in the app, `better-sqlite3`, is built against Node-API
and ships a ready-made binary for every platform, so nothing is compiled during
install. If some guide tells you to install Visual Studio Build Tools for this
project, it is out of date.

## Step 2 — Get the code

```bash
git clone https://github.com/hamzaofficial1478-lang/tiktok.git
cd tiktok
git checkout claude/tiktok-downloader-desktop-0bsyo1
```

## Step 3 — Install dependencies

```bash
npm install
```

This takes a few minutes. Electron is a large download.

Nothing is compiled from source, so there is no build-tool step and no
`postinstall`. If this command finishes without a red `npm error`, you are
done — move on.

## Step 4 — Fetch yt-dlp

```bash
npm run fetch:sidecars
```

This downloads the yt-dlp binary for your platform into
`resources/bin/<platform>-<arch>/` and writes a checksum manifest the app
verifies at startup. **This is the step that gives you watermark removal.**

Expect it to also print two skip warnings:

```
skipping win32-x64/ffmpeg: no source configured.
skipping win32-x64/ffprobe: no source configured.
```

That is correct and expected. ffmpeg is not downloaded automatically — see
"Adding ffmpeg" below if you want the fallback path too. The app runs fine
without it.

The binaries are not in git on purpose: they are large, platform-specific, and
yt-dlp has to be replaceable on its own schedule when TikTok changes something.

## Step 5 — Confirm the engine is healthy before opening a window

```bash
npm run verify
```

Typecheck plus the full test suite — 403 tests, all offline, no network and no
Electron. This takes seconds and tells you the queue, dedup, URL parsing and
filter-graph logic are intact. If this is red, do not bother launching the UI.

## Step 6 — Start the app

```bash
npm run dev
```

An Electron window opens on the **Add links** screen. On first run the app
creates its own download folder — `Videos/TikTok Downloads` on Windows — so
there is nothing to configure before your first paste.

---

## Step 7 — Test watermark removal

1. Open TikTok, find any video, hit Share → Copy link. You get something like
   `https://vm.tiktok.com/ZMxxxxxxx/`. Short links, `/t/` links, `/photo/`
   links, links with tracking junk on the end, and full
   `https://www.tiktok.com/@user/video/1234567890` links all work.
2. Paste it into the box on **Add links**. It validates as you type — you get
   `1 links found` under the box and a per-line preview showing whether each
   line is valid, a duplicate, or junk. You can paste hundreds at once, one
   per line; duplicates inside the paste are dropped before anything is
   queued.
3. Click **Add 1 to queue**. The app switches to the **Queue** screen.
4. Press **Start** (or hit the spacebar).
5. Watch the row. It moves through `resolving` → `downloading` → `completed`,
   and when it finishes a badge appears next to the status chip.

### Reading the badge

This is the answer to "did the watermark come off":

| Badge | Meaning |
| ----- | ------- |
| **clean source** (green) | TikTok served a watermark-free stream. The file was downloaded untouched and never re-encoded. This is the good outcome, and the fast one. |
| **re-encoded** (amber) | No clean stream was available, so the watermark was filtered out of the pixels and the video was encoded again. Needs ffmpeg. |
| **watermarked** (grey) | No clean stream, and removal was not attempted. The watermark is still in the file. |
| *no badge yet* | The item has not finished. |

Click the row to expand it for the full sentence, plus the canonical URL and
attempt count.

6. Open **Library** to confirm the file landed, and use **Open folder** to see
   it on disk. Play it — the watermark should be gone.

If you got **clean source**, watermark removal is working and you are done.
That is the path that handles the large majority of videos.

---

## If you get "watermarked"

It means TikTok only offered the burnt-in version for that video. Two things
to try, in order:

**1. Set Watermark to "Force removal".** Settings → Processing → Watermark.
`Auto` (the default) takes the clean stream when one exists and otherwise
leaves the video alone; `Force removal` tells it to filter the pixels when no
clean stream is on offer. Re-add the link and it should come back
**re-encoded**.

**2. That needs ffmpeg**, so if nothing changes, check Settings — a missing or
underpowered ffmpeg is reported at the bottom of the Processing panel, and
`npm run probe:ffmpeg` prints exactly which filters and encoders your build
has.

## Adding ffmpeg (optional)

Only needed for the fallback path, outro trimming, and full truncation
verification.

The fetch script will not pick an ffmpeg build for you — the filter graphs in
this app are written against `removelogo` and `gblur` specifically, so it
matters which build you point it at. Create `resources/sidecar-sources.json`:

```json
{
  "win32-x64": {
    "ffmpeg": "https://example.com/path/to/ffmpeg.exe",
    "ffprobe": "https://example.com/path/to/ffprobe.exe"
  }
}
```

Then:

```bash
npm run fetch:sidecars
npm run probe:ffmpeg
```

(Re-running the fetch is safe. It re-downloads yt-dlp as well, which is no bad
thing — you get the current release. To fetch just one binary, call the script
directly: `node scripts/fetch-sidecars.mjs --only=ffmpeg`. Going through
`npm run` swallows the `--only` flag.)

`probe:ffmpeg` is the check that matters: it reports which filters and encoders
the build actually has and whether the required ones are present. For local
testing any recent build will do. `docs/SIDECARS.md` covers what to ship.

---

## Things worth trying while you have it open

- **Paste 50 links at once.** They download in exactly the order you pasted
  them, top to bottom. That ordering is a hard guarantee at the default
  concurrency of 1.
- **Paste the same link twice.** The second one is dropped before it reaches
  the queue, and the count says so.
- **Add a link you already downloaded.** You get a question — skip, download
  again, or replace — and crucially the queue *keeps going* while you decide.
  Dismiss it with "Later" and it waits in the header.
- **Close the app mid-download and reopen it.** It resumes from the same item.
  The partial `.part` file is the resume point, so nothing re-downloads from
  zero and no link is lost.
- **Let the screen turn off.** Downloads continue: the app holds a power-save
  blocker while the queue is running and re-arms itself on wake.
- **Raise Concurrent downloads to 4** in Settings if you want throughput. The
  trade is that completion order stops matching paste order — start order
  still does.

## Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `npm install` fails on `node-gyp`, `MSBuild`, or "Could not find any Visual Studio installation" | Nothing here needs compiling, so this is a stale `postinstall` trying to rebuild `better-sqlite3`. Pull the latest commit — it was removed. The install itself already succeeded: check `dir node_modules\.bin` and carry on. |
| "Attempting to build a module with a space in the path" | Same cause as above, triggered by a Windows username containing a space. Same fix; no need to move the project. |
| `NODE_MODULE_VERSION` mismatch at startup | Should not happen — better-sqlite3 v13 is Node-API and ABI-stable. If it does, `npm run rebuild`. |
| `fetch:sidecars` fails on the yt-dlp download | Network or proxy blocking `github.com`. The binary can be placed at `resources/bin/<platform>-<arch>/yt-dlp[.exe]` by hand. |
| Every link fails with `EXTRACTOR_FAILED` | yt-dlp is missing or out of date. `npm run fetch:sidecars` again — TikTok changes things and yt-dlp releases often. |
| Links fail with `RATE_LIMITED` | Too many requests too fast. Raise the request delay in Settings; the default is 1.5s. |
| The window is blank | Check the terminal running `npm run dev` for a renderer error, and the **Logs** screen once it loads. |
| Nothing downloads and the queue sits still | The queue has to be started — press **Start** or the spacebar. |

Every failure in the app maps to a named error code with a plain-language
explanation and a retry button where retrying can help. The **Logs** screen and
`Copy diagnostic` on an expanded queue row have everything needed to debug a
specific item.
