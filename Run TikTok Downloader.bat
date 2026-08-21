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
  echo   [^!] This folder is not a git checkout, so it can NEVER update itself.
  echo       It was probably downloaded as a ZIP. To get updates, delete this
  echo       folder and clone it instead:
  echo         git clone https://github.com/hamzaofficial1478-lang/tiktok.git
  echo.
) else (
  where git >nul 2>&1
  if errorlevel 1 (
    echo   [^!] Git is not installed, so updates cannot be fetched.
    echo.
  ) else (
    echo   [*] Checking for updates...

    rem  Throw away local edits to package-lock.json before pulling.
    rem
    rem  This is the fix for an update that failed every single time. `npm
    rem  install` rewrites package-lock.json as a side effect — a different npm
    rem  version, a platform-specific optional dependency, anything — and git
    rem  then refuses to pull because the incoming commit touches the same file:
    rem
    rem      error: Your local changes to the following files would be
    rem      overwritten by merge:  package-lock.json
    rem      Aborting
    rem
    rem  Nothing was updated, the app built and ran happily on old code, and the
    rem  only symptom was features that were "missing". Discarding is safe
    rem  precisely because the file is generated: npm rebuilds it from
    rem  package.json, and the committed version is the one that should win.
    rem  Nothing else in the folder is touched.
    git checkout -- package-lock.json 2>nul

    for /f "delims=" %%h in ('git rev-parse HEAD 2^>nul') do set BEFORE=%%h

    rem  Output shown, not swallowed: "no upstream branch", "local changes" and
    rem  an auth failure need completely different fixes and look identical
    rem  once the message is discarded.
    git pull --ff-only
    if errorlevel 1 (
      echo.
      echo   [^!] UPDATE FAILED - the app will start, but on OLD code.
      echo       The git message above says why. The usual causes:
      echo         * local changes here      ^-^> git stash
      echo         * wrong branch            ^-^> git checkout claude/tiktok-downloader-desktop-0bsyo1
      echo         * not signed in to GitHub ^-^> git config --global credential.helper manager
      echo.
    ) else (
      rem  What the update actually did.
      rem
      rem  git prints its transfer statistics and then says nothing about the
      rem  working folder, so a successful pull and a pull that changed nothing
      rem  looked identical. These lines are the answer to "did it update?".
      for /f "delims=" %%a in ('git rev-parse HEAD 2^>nul') do set AFTER=%%a
      if "!BEFORE!"=="!AFTER!" (
        echo       Already up to date - nothing changed.
      ) else (
        git diff --name-status !BEFORE! !AFTER! > "%TEMP%\ttd-changed.txt" 2>nul
        for /f %%c in ('find /c /v "" ^< "%TEMP%\ttd-changed.txt"') do set FILES=%%c
        for /f %%c in ('findstr /b /c:"A" "%TEMP%\ttd-changed.txt" ^| find /c /v ""') do set NEW=%%c
        for /f %%c in ('findstr /b /c:"M" "%TEMP%\ttd-changed.txt" ^| find /c /v ""') do set MOD=%%c
        for /f %%c in ('findstr /b /c:"D" "%TEMP%\ttd-changed.txt" ^| find /c /v ""') do set GONE=%%c

        echo.
        echo       Updated: !FILES! files  ^(!NEW! added, !MOD! changed, !GONE! deleted^)
        echo.
        type "%TEMP%\ttd-changed.txt"
        del "%TEMP%\ttd-changed.txt" >nul 2>&1
        echo.
      )
    )
  )

  rem  Stated every time, so "which version am I running" is never a guess.
  for /f "delims=" %%v in ('git log -1 --format^="%%h  %%cd" --date^=short 2^>nul') do (
    echo   [*] Running build: %%v
  )
)

rem --- Dependencies ----------------------------------------------------------
rem  `npm ci` rather than `npm install`, and the difference is the whole reason
rem  updates kept failing.
rem
rem  `npm install` treats package-lock.json as something it may rewrite, and it
rem  does — which leaves a modified tracked file in the folder, which makes the
rem  next `git pull` abort rather than overwrite it. `npm ci` installs exactly
rem  what the lockfile says and never writes to it, so the folder stays clean
rem  and updates keep working. It also installs devDependencies by default,
rem  which is what electron-vite and the build tooling live in.
rem
rem  It falls back to `npm install` when the lockfile and package.json disagree,
rem  since `npm ci` refuses outright in that case and a refusal here means the
rem  app cannot start at all.
if not exist "node_modules\electron\dist\electron.exe" (
  echo   [2/4] Installing dependencies. First run only - this takes a few minutes.
  echo.
  call npm ci
  if errorlevel 1 (
    echo.
    echo       Lockfile out of step with package.json; falling back.
    call npm install --include=dev
  )
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
