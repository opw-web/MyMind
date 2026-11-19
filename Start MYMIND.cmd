@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\.bin\electron.cmd" (
  echo MYMIND dependencies are missing. Installing them now...
  call npm ci
  if errorlevel 1 goto :error
  call npm install-scripts approve electron-winstaller esbuild koffi
  if errorlevel 1 goto :error
  call npm rebuild
  if errorlevel 1 goto :error
)

if not exist "speech-runtime\python\python.exe" (
  echo MYMIND dictation runtime is missing. Building it now...
  if not exist ".speech-env\Scripts\python.exe" (
    py -3.12 -m venv .speech-env
    if errorlevel 1 goto :error
  )
  call ".speech-env\Scripts\python.exe" -m pip install -r speech\requirements.lock.txt
  if errorlevel 1 goto :error
  call npm run build:speech
  if errorlevel 1 goto :error
)

call npm run build -- --mode electron
if errorlevel 1 goto :error
call node_modules\.bin\electron.cmd .
if errorlevel 1 goto :error
exit /b 0

:error
echo.
echo MYMIND could not start. Check the error above, then try again.
pause
exit /b 1
