@echo off
rem JYSHarness portable launcher.
rem   double-click (no args) -> desktop app
rem   jysharness repl        -> terminal session
setlocal
set "ROOT=%~dp0"
set "NODE=node"
if exist "%ROOT%runtime\node.exe" set "NODE=%ROOT%runtime\node.exe"
set "WORKSPACE=%CD%"
if "%~1"=="" set "WORKSPACE=%USERPROFILE%\jysharness-workspace"
if /i not "%NODE%"=="node" goto :run
where node >nul 2>nul
if errorlevel 1 goto :nonode

:run
"%NODE%" "%ROOT%src\cli\main.ts" --workspace "%WORKSPACE%" %*
exit /b %ERRORLEVEL%

:nonode
echo.
echo   Node.js was not found on PATH and no bundled runtime was found.
echo   Rebuild the portable package with: npm run package
echo.
pause
exit /b 1
