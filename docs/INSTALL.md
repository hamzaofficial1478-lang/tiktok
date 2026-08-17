# Installing on another PC

From a machine that has never seen this project to a working app. Windows is
the primary target; the macOS and Linux differences are noted at the end.

Total time: about ten minutes, most of it waiting for two downloads.

---

## What you actually have to install by hand

Exactly two things. Everything else the app fetches itself.

| | Why | Where |
| --- | --- | --- |
| **Node.js 20 or newer** | The app runs on it | <https://nodejs.org> — take the **LTS** button |
| **Git** | To get the code, and to update it later | <https://git-scm.com/download/win> |

**Not needed, despite what a generic guide might tell you:** Visual Studio,
C++ Build Tools, Python, ffmpeg, or yt-dlp. The one native module in this app
(`better-sqlite3`) is built against Node-API and ships a ready-made binary for
every platform, so nothing is compiled during install. ffmpeg and yt-dlp are
handled below without you touching a website.

Accept the default options in both installers. The Node.js installer offers a
checkbox for "Tools for Native Modules" — you do not need it, and ticking it
adds a long Chocolatey install for nothing.

---

## Step 1 — Check the two prerequisites

Open **Command Prompt** (press Start, type `cmd`, Enter) and run:

```bat
node -v
git --version
```

You want `v20.x` or higher from the first, and any version from the second. If
either says *"is not recognized as an internal or external command"*, that
program is not installed or the installer has not been picked up yet — close
Command Prompt, open a new one, and try again before reinstalling.

---

## Step 2 — Get the code

Pick where it should live. Your user folder is a good choice; avoid
`C:\Program Files`, which needs administrator rights the app does not want.

```bat
cd %USERPROFILE%
git clone https://github.com/hamzaofficial1478-lang/tiktok.git
cd tiktok
git checkout claude/tiktok-downloader-desktop-0bsyo1
```

That last line matters. The work lives on that branch, not on `main`, so
without it you get an older version of the app.

---

## Step 3 — Start it

Open the `tiktok` folder in File Explorer and **double-click
`Run TikTok Downloader.bat`**.

That is the whole installation. The batch file does four things in order and
stops with a plain-English message if any of them fails:

```
[1/4] Node.js: OK
[2/4] Installing dependencies. First run only - this takes a few minutes.
[3/4] Fetching yt-dlp. First run only.
[4/4] Building the app...
```

Step 2 downloads about 300 MB, most of it Electron, and takes a few minutes on
a normal connection. Step 3 fetches yt-dlp, which is the program that actually
talks to TikTok — without it the app opens but every download fails. Both are
first-run only; afterwards the batch file skips straight to the build and the
app opens in ten to twenty seconds.

Leave the black Command Prompt window open while you use the app. Closing it
closes the app. It can be minimised.

### If you would rather type it than double-click

The batch file is only running these:

```bat
npm install --include=dev
npm run fetch:sidecars
npm run build
npx electron .
```

---

## Step 4 — First launch

The app opens on **Add links** and creates its own download folder,
`Videos\TikTok Downloads`, so there is nothing to configure before your first
paste. Change it in **Settings → Output folder** if you want it elsewhere; that
choice is saved and survives restarts.

Paste a TikTok link, press **Add to queue**, and it downloads. If that works,
you are finished.

---

## Optional extras, installed from inside the app

Neither is needed for downloading. Both are buttons, not websites.

**ffmpeg** — only used when TikTok offers no watermark-free version of a video,
and for burning captions into the picture. Most videos never need it. Install
from **Settings → Processing**, where a missing ffmpeg is reported with an
Install button. It fetches an LGPL build, which is the licensing-safe one for a
commercial product.

**Whisper (offline transcription)** — only needed if you want captions on
videos TikTok published no caption track for. Install from the **Captions**
section; pick `base.en` unless you have a reason not to. It is roughly a 150 MB
model download and runs entirely on your machine, with nothing sent anywhere.

---

## Updating later

Double-click `Run TikTok Downloader.bat`. It pulls the newest code before
building, so that is the whole update procedure — there is nothing else to
remember and no second command to run.

If it prints *"Could not update (offline, or this folder has local changes)"*
it starts the version already on disk rather than refusing to run. That message
means either no internet, or you have edited a file in the folder.

yt-dlp updates itself separately, on launch, because TikTok changes often
enough that waiting for an app release would break downloads in the meantime.

---

## Moving your library and settings across

Optional. Skip this if a fresh start on the new PC is fine.

Everything the app remembers — the download history that stops videos being
taken twice, your saved creator accounts, and every setting — lives in one
folder:

```
%APPDATA%\tiktok-downloader
```

Copy that folder from the old PC to the same place on the new one **while the
app is closed on both**, and the new machine picks up exactly where the old one
left off. The downloaded video files themselves are separate; copy your output
folder too if you want those.

If you copy the library but not the videos, the app will notice the files are
missing from where it recorded them and ask before re-downloading, rather than
silently fetching them all again.

---

## When something goes wrong

**"Node.js is not installed, or is not on your PATH"** — install Node, then
open a *new* Command Prompt. An already-open window does not see a PATH change.

**"Installing dependencies failed"** — almost always a half-finished install.
Delete the `node_modules` folder inside `tiktok` and double-click the batch
file again.

**"Could not download yt-dlp"** — a connection problem, or a corporate network
blocking GitHub. Run it again; if it keeps failing, `npm run fetch:sidecars`
from Command Prompt prints the actual error.

**The app opens but every download fails** — check
`resources\bin\win32-x64\yt-dlp.exe` exists. If it does not, run
`npm run fetch:sidecars`.

**Windows SmartScreen warns about the batch file** — it is unsigned, which is
expected for a file you cloned yourself. *More info* → *Run anyway*.

**Anything else** — the full log is in `%APPDATA%\tiktok-downloader\logs`, and
the app's own **Logs** section has a search box and an Export button that puts
the lines on your clipboard.

To check the engine itself without opening a window:

```bat
npm run verify
```

Typecheck plus the full test suite, offline, in a few seconds. If that is green
the download engine is intact and the problem is elsewhere.

---

## macOS and Linux

The same steps, without the batch file:

```bash
git clone https://github.com/hamzaofficial1478-lang/tiktok.git
cd tiktok
git checkout claude/tiktok-downloader-desktop-0bsyo1
npm install
npm run fetch:sidecars
npm run dev
```

Two differences worth knowing. The settings folder is
`~/Library/Application Support/tiktok-downloader` on macOS and
`~/.config/tiktok-downloader` on Linux. And Whisper has no ready-made build for
either platform — the app says so plainly rather than downloading something
that will not run — so offline transcription needs whisper.cpp built from
source. Everything else, including all downloading and captioning from TikTok's
own caption tracks, works identically.
