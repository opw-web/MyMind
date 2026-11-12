$ErrorActionPreference = 'Stop'
$graphifyRoot = Split-Path $PSScriptRoot -Parent
$graphifyPython = Join-Path $PSScriptRoot 'env/Scripts/python.exe'
$graphifyScript = Join-Path $PSScriptRoot 'project.py'
$graphifyRuntime = Join-Path $PSScriptRoot 'runtime'
New-Item -ItemType Directory -Path $graphifyRuntime -Force | Out-Null
$graphifyPidFile = Join-Path $graphifyRuntime 'watch.pid'
if (Test-Path -LiteralPath $graphifyPidFile) {
    $graphifyPidValue = [int](Get-Content -LiteralPath $graphifyPidFile -Raw)
    $graphifyExisting = Get-CimInstance Win32_Process -Filter "ProcessId = $graphifyPidValue" -ErrorAction SilentlyContinue
    if ($graphifyExisting -and $graphifyExisting.CommandLine.Contains($graphifyScript) -and $graphifyExisting.CommandLine.Contains('watch')) {
        Write-Output "Graphify watcher already running (PID $graphifyPidValue)."
        exit 0
    }
}
if (-not (Test-Path -LiteralPath $graphifyPython)) { throw 'Restore .graphify/env using .graphify/SETUP.md first.' }
$env:PYTHONUTF8 = '1'
$env:GRAPHIFY_NO_AUTO_REFRESH = '1'
$graphifyWatchProcess = Start-Process -FilePath $graphifyPython -ArgumentList @('-u', ('"' + $graphifyScript + '"'), 'watch') -WorkingDirectory $graphifyRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $graphifyRuntime 'watch.log') -RedirectStandardError (Join-Path $graphifyRuntime 'watch-error.log')
Start-Sleep -Seconds 2
if ($graphifyWatchProcess.HasExited) { throw 'Watcher failed to start. Inspect .graphify/runtime/watch-error.log.' }
if (Test-Path -LiteralPath $graphifyPidFile) { $graphifyActualPid = (Get-Content -LiteralPath $graphifyPidFile -Raw).Trim() } else { $graphifyActualPid = $graphifyWatchProcess.Id }
Write-Output "Graphify watcher started (PID $graphifyActualPid)."
