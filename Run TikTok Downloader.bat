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
echo   [1/3] Node.js: OK

rem --- Updates ---------------------------------------------------------------
rem  Pulls the latest code before building, so double-clicking this file is the
rem  whole update procedure and there is nothing to remember.
rem
rem  --ff-only on purpose: it takes updates cleanly or not at all, and never
rem  invents a merge commit in someone's working folder. Any failure here is a
rem  warning, not a stop — offline, or a folder with local edits, should start
rem  the version already on disk rather than refusing to start at all.
if exist ".git" (
  where git >nul 2>&1
  if not errorlevel 1 (
    echo   [*] Checking for updates...
    git pull --ff-only >nul 2>&1
    if errorlevel 1 (
      echo       Could not update ^(offline, or this folder has local changes^).
      echo       Starting the version already here.
    ) else (
      echo       Up to date.
    )
  )
)

rem --- Dependencies ----------------------------------------------------------
rem  --include=dev is deliberate: electron-vite and the build tooling live in
rem  devDependencies, and npm skips those when NODE_ENV happens to be production.
if not exist "node_modules\electron\dist\electron.exe" (
  echo   [2/3] Installing dependencies. First run only - this takes a few minutes.
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
  echo   [2/3] Dependencies: OK
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
echo   [3/3] Building the app...
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
