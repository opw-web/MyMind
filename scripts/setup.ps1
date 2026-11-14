# MYMIND one-time setup: install prerequisites, dependencies, the speech
# runtime when missing, the release binary, staged speech resources, the
# desktop shortcut, and the default local model. Safe to re-run; finished
# steps are skipped.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }

# Rust from rustup is not always on PATH in a fresh shell.
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path $cargoBin) { $env:PATH = "$cargoBin;$env:PATH" }
# Locations where winget-based installs land, in case PATH is stale.
foreach ($dir in @(
        "$env:ProgramFiles\nodejs",
        "$env:LOCALAPPDATA\Programs\Python\Python312",
        "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts",
        "$env:ProgramFiles\Ollama"
    )) {
    if ((Test-Path $dir) -and $env:PATH -notlike "*$dir*") { $env:PATH = "$dir;$env:PATH" }
}

function Install-Winget($package, $purpose) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "winget is unavailable; install $purpose manually, then re-run setup."
    }
    Write-Host "Installing $purpose ($package)..."
    winget install --silent --accept-source-agreements --accept-package-agreements --exact $package
    foreach ($dir in @(
            "$env:ProgramFiles\nodejs",
            "$env:LOCALAPPDATA\Programs\Python\Python312",
            "$env:LOCALAPPDATA\Programs\Python\Python312\Scripts",
            "$env:ProgramFiles\Ollama"
        )) {
        if ((Test-Path $dir) -and $env:PATH -notlike "*$dir*") { $env:PATH = "$dir;$env:PATH" }
    }
}

Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Install-Winget 'OpenJS.NodeJS.LTS' 'Node.js 22+'
}
$nodeMajor = (& node --version) -replace '^v' -replace '\..*$'
if ([int]$nodeMajor -lt 22) { throw "Node.js 22+ is required (found $nodeMajor)." }

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Install-Winget 'Rustlang.Rustup' 'the Rust toolchain'
    $env:PATH = "$cargoBin;$env:PATH"
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$hasMsvc = (Test-Path $vswhere) -and (& $vswhere -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null)
if (-not $hasMsvc) {
    Install-Winget 'Microsoft.VisualStudio.2022.BuildTools' 'the MSVC C++ build tools (several GB download)'
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    throw 'Rust is still unavailable. Install rustup from https://rustup.rs, then re-run setup.'
}
Write-Host "node $(node --version), cargo $(cargo --version)"

Step 'Installing JavaScript dependencies'
if (Test-Path 'node_modules') { Write-Host 'node_modules exists, skipping npm ci' }
else { npm ci }

Step 'Preparing the local speech runtime'
if (Test-Path 'speech-runtime\manifest.json') {
    Write-Host 'speech-runtime exists, skipping the speech build'
} else {
    if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
        Install-Winget 'Python.Python.3.12' 'Python 3.12'
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

Step 'Preparing the local assistant model'
if (Get-Command ollama -ErrorAction SilentlyContinue) {
    $models = & ollama list 2>$null
    if ($models -match 'qwen3\.5:4b') {
        Write-Host 'qwen3.5:4b is already installed'
    } else {
        Write-Host 'Pulling qwen3.5:4b into Ollama (a one-time multi-GB download)...'
        & ollama pull qwen3.5:4b
    }
} else {
    Write-Host 'Ollama not found. Install it from https://ollama.com/download/windows' -ForegroundColor Yellow
    Write-Host 'and run: ollama pull qwen3.5:4b   (the assistant needs it to answer).'
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
