@echo off
rem ---------------------------------------------------------------------------
rem DevWork one-click launcher (development mode).
rem Double-click this file, or run it from a terminal:
rem   scripts\start.bat            start dev mode (vite + backend + desktop)
rem   scripts\start.bat --prod     start in production mode (uses dist/)
rem   scripts\start.bat --check    environment check only
rem NOTE: keep this file ASCII-only. cmd.exe reads .bat with the system ANSI
rem code page, so Chinese text here turns into mojibake on a Chinese Windows.
rem The Chinese messages live in scripts/start.mjs (UTF-8) instead.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."
node scripts\start.mjs %*
if errorlevel 1 (
  echo.
  echo [DevWork] Startup failed. See the message above.
  pause
)
endlocal
