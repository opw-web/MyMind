@echo off
rem Double-click launcher for MYMIND. Builds on first run, then starts the app.
setlocal
pushd "%~dp0"

set "EXE=src-tauri\target\release\MYMIND.exe"
if not exist "%EXE%" goto :setup
if not exist "node_modules\" goto :setup
if not exist "speech-runtime\manifest.json" goto :setup
goto :launch

:setup
echo First run: setting up and building MYMIND. This takes a few minutes.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
if errorlevel 1 (
    echo.
    echo Setup failed. See the messages above.
    pause
    exit /b 1
)

:launch
start "" "%~dp0%EXE%"
popd
