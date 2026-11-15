@echo off
rem ---------------------------------------------------------------------------
rem DevWork one-click packager (Windows x64).
rem Double-click this file, or run it from a terminal:
rem   scripts\package.bat              zip archive          (release\build)
rem   scripts\package.bat --dir        unpacked folder only (fastest self-test)
rem   scripts\package.bat --installer  NSIS installer
rem   scripts\package.bat --portable   single portable exe
rem   scripts\package.bat --all        all three shapes
rem   scripts\package.bat --help       full option list
rem NOTE: keep this file ASCII-only. cmd.exe reads .bat with the system ANSI
rem code page, so Chinese text here turns into mojibake on a Chinese Windows.
rem The Chinese messages live in scripts/package.mjs (UTF-8) instead.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

rem Node is the only hard prerequisite; catch it here so a double-click on a
rem machine without Node reports one line instead of "node is not recognized".
where node >nul 2>nul
if errorlevel 1 (
  echo [DevWork] Node.js was not found on PATH.
  echo [DevWork] Install Node 22 LTS or newer, then run this file again.
  echo [DevWork] Domestic mirror: https://npmmirror.com/mirrors/node/
  pause
  exit /b 1
)

node scripts\package.mjs %*
set EXITCODE=%ERRORLEVEL%
echo.
if %EXITCODE%==0 (
  echo [DevWork] Done. Artifacts are in the release\build folder.
  echo [DevWork] Tip: "package.bat --all" builds zip + installer + portable.
) else (
  echo [DevWork] Packaging failed - see the message above.
)
pause
exit /b %EXITCODE%
