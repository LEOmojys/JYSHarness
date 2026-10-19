@echo off
rem JYSHarness launcher.
rem   double-click (no args) -> desktop app
rem   jys repl               -> terminal session
rem   jys "prompt"           -> one-shot run
setlocal
set "ROOT=%~dp0"
set "WORKSPACE=%CD%"
rem Double-click starts in the source folder; use a friendly default instead.
if "%~1"=="" set "WORKSPACE=%USERPROFILE%\jysharness-workspace"
where node >nul 2>nul
if errorlevel 1 goto :nonode
node "%ROOT%src\cli\main.ts" --workspace "%WORKSPACE%" %*
exit /b %ERRORLEVEL%

:nonode
echo.
echo   Node.js was not found on PATH.
echo   Install Node.js 22+ ^(https://nodejs.org^), or use the portable build
echo   that ships its own runtime ^(jysharness.cmd inside the package^).
echo.
pause
exit /b 1
