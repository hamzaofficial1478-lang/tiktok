# Installing on another PC

Windows 10 or 11, using PowerShell. About ten minutes, most of it waiting for
two downloads.

---

## Install two things by hand

That is the whole list.

1. **Node.js** — <https://nodejs.org>, click the big **LTS** button, run the
   installer, accept every default. Any version from 20 up works, including
   whatever the front page is offering today.
   - It offers a checkbox called **"Tools for Native Modules"**. Leave it
     unticked. This project needs none of it, and ticking it starts a long
     install of things you will never use.

2. **Git** — <https://git-scm.com/download/win>, run it, accept every default.

You do **not** need Visual Studio, C++ Build Tools, Python, ffmpeg, or yt-dlp.
If a guide tells you to install those for a Node project, it does not apply
here — nothing in this app is compiled on your machine.

**Close PowerShell after installing, then open a new one.** An already-open
window cannot see newly installed programs.

---

## Step 1 — Let PowerShell run npm

Do this once. Open PowerShell and paste:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Answer `Y` when it asks.

**Why:** `npm` on Windows is a PowerShell script, and Windows 10 ships with
script-running switched off. Without this you get
*"npm.ps1 cannot be loaded because running scripts is disabled on this system"*
the moment you try to install anything — an error that looks like a broken Node
install and is not. `CurrentUser` needs no administrator rights and changes
nothing for other accounts on the PC.

---

## Step 2 — Check both programs are there

```powershell
node -v
git --version
```

You want `v20` or higher from the first, and any number from the second.

If either says *"is not recognized"*, close PowerShell, open a new one, and try
again — that fixes it far more often than reinstalling does.

---

## Step 3 — Download the code

```powershell
cd $HOME
git clone https://github.com/hamzaofficial1478-lang/tiktok.git
cd tiktok
git checkout claude/tiktok-downloader-desktop-0bsyo1
```

**Do not skip the last line.** The app lives on that branch. Without it you get
an older version missing everything recent.

This puts the app in `C:\Users\<you>\tiktok`. Anywhere in your user folder is
fine; avoid `C:\Program Files`, which needs administrator rights the app does
not want.

---

## Step 4 — Start it

```powershell
.\"Run TikTok Downloader.bat"
```

The `.\` is required — PowerShell will not run a file in the current folder
without it. You can also just double-click the file in File Explorer, which
avoids the quoting entirely.

It prints four steps and stops with a plain message if any of them fails:

```
[1/4] Node.js: OK
[2/4] Installing dependencies. First run only - this takes a few minutes.
[3/4] Fetching yt-dlp. First run only.
[4/4] Building the app...
```

Steps 2 and 3 only happen the first time. Step 2 downloads about 300 MB, mostly
Electron. After that, starting the app takes ten to twenty seconds.

Keep the window open while you use the app — closing it closes the app. You can
minimise it.

---

## Step 5 — First launch

The app opens on **Add links** and makes its own download folder,
`Videos\TikTok Downloads`. Nothing needs configuring. Paste a TikTok link,
press **Add to queue**, and it downloads.

Change where files go in **Settings → Output folder**. That choice is saved.

---

## About yt-dlp

**You do not download it yourself.** yt-dlp is the program that actually talks
to TikTok, and step 3 above fetches it for you, straight from its official
GitHub releases into `resources\bin\win32-x64\yt-dlp.exe` inside the project
folder.

It is not shipped with the code on purpose. TikTok changes things often, and
yt-dlp has to be replaceable on its own schedule rather than waiting for an app
release — so the app also **updates it by itself** every time it starts. A
stale yt-dlp is the single most common reason a downloader suddenly stops
working, and this is what stops that happening to you.

To fetch it by hand, or to re-fetch it if you suspect it is broken:

```powershell
npm run fetch:sidecars
```

To check it arrived:

```powershell
Test-Path .\resources\bin\win32-x64\yt-dlp.exe
```

`True` means you are set. Expect the fetch to also print two skip warnings
about ffmpeg and ffprobe — those are correct and expected, and explained next.

---

## Two optional extras, installed by a button in the app

Neither is needed to download videos. Neither involves a website.

**ffmpeg** — used only when TikTok has no watermark-free copy of a video, and
for burning captions into the picture. Most videos need neither.
**Settings → Processing** reports it as missing and has an **Install** button.

**Whisper** — offline transcription, only needed for captions on videos TikTok
published no captions for. Install from the **Captions** section and choose
`base.en`. Around 150 MB, and it runs entirely on your PC.

---

## Updating later

Run the same file:

```powershell
.\"Run TikTok Downloader.bat"
```

It pulls the newest code before building. That is the entire update procedure.

If it says *"Could not update (offline, or this folder has local changes)"* it
starts the version already on disk instead of refusing to run.

---

## Bringing your library over from the old PC

Optional — skip it if starting fresh is fine.

Everything the app remembers lives in one folder: the record that stops videos
being downloaded twice, your saved creator accounts, and every setting.

**With the app closed on both PCs**, copy this folder across to the same place:

```powershell
explorer $env:APPDATA\tiktok-downloader
```

Copy your videos folder too if you want the files themselves. If you bring the
library but not the videos, the app notices the files are missing and asks
before downloading them again rather than silently re-fetching everything.

---

## If something goes wrong

**"npm.ps1 cannot be loaded because running scripts is disabled"** — step 1 was
skipped. Run it, then try again.

**"node is not recognized"** — open a new PowerShell window. If it still
happens, Node did not install; run its installer again.

**"Installing dependencies failed"** — a half-finished install, almost always.
Delete the `node_modules` folder inside `tiktok` and run the file again:

```powershell
Remove-Item -Recurse -Force .\node_modules
```

**The app opens but every download fails** — yt-dlp is missing. Check with the
`Test-Path` command above, and run `npm run fetch:sidecars` if it says `False`.

**Windows protected your PC / SmartScreen** — expected for a file you cloned
yourself rather than downloaded signed. **More info** → **Run anyway**.

**Anything else** — the app's **Logs** section has a search box and an Export
button that copies the lines to your clipboard. The same log is on disk:

```powershell
explorer $env:APPDATA\tiktok-downloader\logs
```

To test the download engine without opening the app at all:

```powershell
npm run verify
```

A typecheck and the full offline test suite, in a few seconds. Green means the
engine is intact and the problem is somewhere else.

---

## macOS and Linux

Same idea, no batch file and no execution policy:

```bash
git clone https://github.com/hamzaofficial1478-lang/tiktok.git
cd tiktok
git checkout claude/tiktok-downloader-desktop-0bsyo1
npm install
npm run fetch:sidecars
npm run dev
```

The settings folder is `~/Library/Application Support/tiktok-downloader` on
macOS and `~/.config/tiktok-downloader` on Linux. Whisper has no ready-made
build for either, so offline transcription needs whisper.cpp compiled from
source — the app says so plainly rather than downloading something that cannot
run. Everything else works identically.
