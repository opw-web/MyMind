$ErrorActionPreference = 'Stop'
$graphifyRoot = Split-Path $PSScriptRoot -Parent
$graphifyGitHookDir = (& git -C $graphifyRoot rev-parse --git-path hooks).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Not a Git repository.' }
if (-not [IO.Path]::IsPathRooted($graphifyGitHookDir)) { $graphifyGitHookDir = Join-Path $graphifyRoot $graphifyGitHookDir }
New-Item -ItemType Directory -Path $graphifyGitHookDir -Force | Out-Null
foreach ($graphifyEvent in @('post-commit','post-checkout','post-merge')) {
    $graphifyHookPath = Join-Path $graphifyGitHookDir $graphifyEvent
    $graphifyExistingText = if (Test-Path -LiteralPath $graphifyHookPath) { [IO.File]::ReadAllText($graphifyHookPath) } else { "#!/bin/sh`n" }
    if (-not $graphifyExistingText.Contains('# MYMIND GRAPHIFY REFRESH')) {
        # Append an independent block; never replace another tool's hook.
        $graphifyHookBlock = @'

# MYMIND GRAPHIFY REFRESH
graphify_root=$(git rev-parse --show-toplevel)
if [ -f "$graphify_root/.graphify/run.cjs" ]; then
  node "$graphify_root/.graphify/run.cjs" hook || printf '%s\n' 'Graphify refresh failed; see .graphify/README.md' >&2
fi
# END MYMIND GRAPHIFY REFRESH
'@
        [IO.File]::WriteAllText($graphifyHookPath, $graphifyExistingText.TrimEnd() + "`n" + $graphifyHookBlock.Replace("`r`n","`n") + "`n", [Text.UTF8Encoding]::new($false))
    }
}
# Restore the watcher after a Windows sign-in. The shortcut runs hidden,
# scoped to this user and project. No administrator rights or password needed.
$graphifyStartupDir = [Environment]::GetFolderPath('Startup')
$graphifyHasher = [Security.Cryptography.SHA256]::Create()
$graphifyId = [BitConverter]::ToString($graphifyHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($graphifyRoot))).Replace('-','').Substring(0,10)
$graphifyHasher.Dispose()
$graphifyShortcutPath = Join-Path $graphifyStartupDir "MYMIND-Graphify-$graphifyId.lnk"
$graphifyShell = New-Object -ComObject WScript.Shell
$graphifyShortcut = $graphifyShell.CreateShortcut($graphifyShortcutPath)
$graphifyShortcut.TargetPath = (Get-Command powershell.exe).Source
$graphifyShortcut.Arguments = '-NoProfile -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'start-watch.ps1') + '"'
$graphifyShortcut.WorkingDirectory = $graphifyRoot
$graphifyShortcut.WindowStyle = 7
$graphifyShortcut.Description = 'Keep MYMIND Graphify map and Obsidian vault synchronized'
$graphifyShortcut.Save()
New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'runtime') -Force | Out-Null
@{ startupShortcut = $graphifyShortcutPath; hooksDirectory = $graphifyGitHookDir } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime/hooks.json') -Encoding utf8
Write-Output "Git refresh hooks installed. Sign-in watcher: $graphifyShortcutPath"
& (Join-Path $PSScriptRoot 'start-watch.ps1')
