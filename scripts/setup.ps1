# MYMIND one-time setup: install dependencies, build the speech runtime when
# missing, build the release binary, stage its speech resources, and place a
# desktop shortcut. Safe to re-run; finished steps are skipped.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }

# Rust from rustup is not always on PATH in a fresh shell.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }

Step 'Checking prerequisites'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 22+ is required: https://nodejs.org' }
$nodeMajor = (& node --version) -replace '^v' -replace '\..*$'
if ([int]$nodeMajor -lt 22) { throw "Node.js 22+ is required (found $($nodeMajor))." }
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Rust is required: install rustup from https://rustup.rs (Visual Studio C++ Build Tools too).'
}
Write-Host "node $(& node --version), cargo $(cargo --version)"

Step 'Installing JavaScript dependencies'
if (Test-Path 'node_modules') { Write-Host 'node_modules exists, skipping npm ci' }
else { npm ci }

Step 'Preparing the local speech runtime'
if (Test-Path 'speech-runtime\manifest.json') {
    Write-Host 'speech-runtime exists, skipping the speech build'
} else {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        throw 'Python 3.12 is required to build the speech runtime: https://www.python.org'
    }
    if (-not (Test-Path '.speech-env\Scripts\python.exe')) {
        python -m venv .speech-env
        & .\.speech-env\Scripts\python.exe -m pip install -r speech\requirements.lock.txt
    }
    npm run build:speech
}

Step 'Building the MYMIND desktop (release)'
npm run tauri -- build --no-bundle

Step 'Staging speech resources next to the executable'
foreach ($profile in 'release') {
    $target = "src-tauri\target\$profile\speech"
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item -Recurse 'speech-runtime' $target
}

Step 'Creating the desktop shortcut'
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'MYMIND.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $root 'Run MYMIND.cmd'
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = Join-Path $root 'assets\icon.ico'
$shortcut.Description = 'MYMIND local planner'
$shortcut.Save()
Write-Host "shortcut: $shortcutPath"

Write-Host "`nMYMIND is ready. Use the desktop shortcut or double-click 'Run MYMIND.cmd'." -ForegroundColor Green
