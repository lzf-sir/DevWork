@echo off
rem ---------------------------------------------------------------------------
rem DevWork one-click packager (Windows x64 installer).
rem Double-click this file, or run it from a terminal:
rem   scripts\package.bat          build the installer (release\DevWork Setup *.exe)
rem   scripts\package.bat --dir    build the unpacked folder only (faster)
rem NOTE: keep this file ASCII-only. cmd.exe reads .bat with the system ANSI
rem code page, so Chinese text here turns into mojibake on a Chinese Windows.
rem The Chinese messages live in scripts/package.mjs (UTF-8) instead.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."
node scripts\package.mjs %*
set EXITCODE=%ERRORLEVEL%
echo.
if %EXITCODE%==0 (
  echo [DevWork] Packaging finished. The installer is in the release folder.
) else (
  echo [DevWork] Packaging failed. See the message above.
)
pause
exit /b %EXITCODE%
