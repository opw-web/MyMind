$ErrorActionPreference = 'Stop'
$graphifyPidFile = Join-Path $PSScriptRoot 'runtime/watch.pid'
if (-not (Test-Path -LiteralPath $graphifyPidFile)) { Write-Output 'No recorded Graphify watcher.'; exit 0 }
$graphifyPidValue = [int](Get-Content -LiteralPath $graphifyPidFile -Raw)
$graphifyScript = Join-Path $PSScriptRoot 'project.py'
$graphifyProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $graphifyPidValue" -ErrorAction SilentlyContinue
if ($graphifyProcess -and $graphifyProcess.CommandLine.Contains($graphifyScript) -and $graphifyProcess.CommandLine.Contains('watch')) {
    Stop-Process -Id $graphifyPidValue
    Write-Output "Stopped Graphify watcher (PID $graphifyPidValue)."
} else { Write-Output 'Recorded watcher is no longer running.' }
Remove-Item -LiteralPath $graphifyPidFile
