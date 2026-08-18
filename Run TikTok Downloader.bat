@echo off
setlocal enabledelayedexpansion
title TikTok Downloader

rem ---------------------------------------------------------------------------
rem  Double-click this file to start the app.
rem
rem  It does what you were typing by hand, in order, and stops at the first step
rem  that fails with a message saying which one — rather than flashing a window
rem  shut and leaving you to guess. Nothing here needs PowerShell.
rem
rem  It also updates itself: the latest code is pulled before the build, so
rem  double-clicking this file is the whole update procedure. Dependencies are
rem  installed only when missing; the app is rebuilt every time, on purpose.
rem ---------------------------------------------------------------------------

cd /d "%~dp0"

echo.
echo   TikTok Downloader
echo   -----------------
echo.

rem --- Node ------------------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   [X] Node.js is not installed, or is not on your PATH.
  echo.
  echo       Install the LTS version from https://nodejs.org and then run this
  echo       file again. Nothing else needs installing by hand.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if !NODE_MAJOR! LSS 20 (
  echo   [X] Node.js !NODE_MAJOR! is too old. This app needs 20 or newer.
  echo       Install the LTS version from https://nodejs.org, then run this again.
  echo.
  pause
  exit /b 1
)
echo   [1/4] Node.js: OK

rem --- Updates ---------------------------------------------------------------
rem  Pulls the latest code before building, so double-clicking this file is the
rem  whole update procedure and there is nothing to remember.
rem
rem  --ff-only on purpose: it takes updates cleanly or not at all, and never
rem  invents a merge commit in someone's working folder. Any failure here is a
rem  warning, not a stop — offline, or a folder with local edits, should start
rem  the version already on disk rather than refusing to start at all.
rem
rem  A failed update used to be one quiet line among four steps, with git's own
rem  output thrown away by >nul. The app then built and opened perfectly, from
rem  weeks-old code, and the only symptom was features that were "missing".
rem  That happened three times. Now the reason is printed, and the version
rem  actually running is stated whether the update worked or not.
if not exist ".git" (
  echo   [!] This folder is not a git checkout, so it can NEVER update itself.
  echo       It was probably downloaded as a ZIP. To get updates, delete this
  echo       folder and clone it instead:
  echo         git clone https://github.com/hamzaofficial1478-lang/tiktok.git
  echo.
) else (
  where git >nul 2>&1
  if errorlevel 1 (
    echo   [!] Git is not installed, so updates cannot be fetched.
    echo.
  ) else (
    echo   [*] Checking for updates...
    rem  Output shown, not swallowed: "no upstream branch", "local changes" and
    rem  an auth failure need completely different fixes and look identical
    rem  once the message is discarded.
    git pull --ff-only
    if errorlevel 1 (
      echo.
      echo   [!] UPDATE FAILED - the app will start, but on OLD code.
      echo       The git message above says why. The usual causes:
      echo         * local changes here      ^-^> git stash
      echo         * wrong branch            ^-^> git checkout claude/tiktok-downloader-desktop-0bsyo1
      echo         * not signed in to GitHub ^-^> git config --global credential.helper manager
      echo.
    )
  )

  rem  Stated every time, so "which version am I running" is never a guess.
  for /f "delims=" %%v in ('git log -1 --format^="%%h  %%cd" --date^=short 2^>nul') do (
    echo   [*] Running build: %%v
  )
)

rem --- Dependencies ----------------------------------------------------------
rem  --include=dev is deliberate: electron-vite and the build tooling live in
rem  devDependencies, and npm skips those when NODE_ENV happens to be production.
if not exist "node_modules\electron\dist\electron.exe" (
  echo   [2/4] Installing dependencies. First run only - this takes a few minutes.
  echo.
  call npm install --include=dev
  if errorlevel 1 (
    echo.
    echo   [X] Installing dependencies failed. The lines above say why.
    echo       A stale half-install is the usual cause: delete the node_modules
    echo       folder and run this file again.
    echo.
    pause
    exit /b 1
  )
) else (
  echo   [2/4] Dependencies: OK
)

rem --- yt-dlp ----------------------------------------------------------------
rem  The one binary the app cannot work without, and it is deliberately not in
rem  git: it is platform-specific, and TikTok changes often enough that yt-dlp
rem  has to be replaceable on its own schedule rather than an app release's.
rem
rem  Fetching it here is the fix for a genuinely bad first run on a new machine.
rem  Without this step the app installed, built and opened perfectly — and then
rem  failed every single download with an extraction error, because the very
rem  thing that does the downloading was never fetched. "Works, but nothing
rem  downloads" is a far worse first impression than a slower first start.
rem
rem  Only when missing: once it is on disk, the app updates it itself on launch.
if not exist "resources\bin\win32-x64\yt-dlp.exe" (
  echo   [3/4] Fetching yt-dlp. First run only.
  call npm run fetch:sidecars
  if errorlevel 1 (
    echo.
    echo   [X] Could not download yt-dlp. Check your internet connection and
    echo       run this file again. Without it, nothing can be downloaded.
    echo.
    pause
    exit /b 1
  )
  echo.
) else (
  echo   [3/4] yt-dlp: OK
)

rem --- Build -----------------------------------------------------------------
rem  Always. This used to skip the build whenever "out" already existed, which
rem  was wrong in the one case that matters: after pulling new code, the old
rem  build is still sitting there, so the app started and showed the previous
rem  version. The only way to see the new one was to run npm run dev by hand,
rem  which is exactly what this file exists to avoid.
rem
rem  A rebuild of unchanged code takes a few seconds. Being a few seconds slower
rem  every time is worth never once running the wrong version.
echo   [4/4] Building the app...
echo.
call npm run build
if errorlevel 1 (
  echo.
  echo   [X] The build failed. The lines above say why.
  echo.
  pause
  exit /b 1
)

echo.
echo   Starting... this window can be minimised, but closing it closes the app.
echo.

call npx electron .
set EXIT_CODE=%errorlevel%

rem  A crash leaves the window open with the reason on screen. A normal exit
rem  closes it, because a window that has to be dismissed after every use is a
rem  window people stop reading.
if not "%EXIT_CODE%"=="0" (
  echo.
  echo   The app closed unexpectedly ^(exit code %EXIT_CODE%^).
  echo   The full log is in:  %%APPDATA%%\tiktok-downloader\logs
  echo.
  pause
)

endlocal
exit /b %EXIT_CODE%
