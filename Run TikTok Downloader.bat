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
rem  Later runs skip everything that is already done, so the second start is
rem  quick: dependencies are only installed when node_modules is missing, and
rem  the app is only rebuilt when the built output is missing.
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
rem  Rebuilt only when the output is missing. To force one after changing the
rem  code, delete the "out" folder, or run: npm run build
if not exist "out\main\index.js" (
  echo   [3/3] Building the app. First run only.
  echo.
  call npm run build
  if errorlevel 1 (
    echo.
    echo   [X] The build failed. The lines above say why.
    echo.
    pause
    exit /b 1
  )
) else (
  echo   [3/3] Build: OK
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
