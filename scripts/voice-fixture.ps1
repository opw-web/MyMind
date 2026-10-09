$fixtureRoot = Join-Path (Split-Path $PSScriptRoot -Parent) 'test-results'
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
$fixturePath = Join-Path $fixtureRoot 'voice-command.wav'
$speaker = New-Object -ComObject SAPI.SpVoice
$stream = New-Object -ComObject SAPI.SpFileStream
$stream.Format.Type = 18
$stream.Open($fixturePath, 3, $false)
$speaker.AudioOutputStream = $stream
$speaker.Speak('<speak><silence msec="1000"/>Add an exam next Friday.<silence msec="4000"/></speak>', 8) | Out-Null
$stream.Close()
Write-Output $fixturePath
