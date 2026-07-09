# Registers subsTranslator to auto-start (hidden) at every login for the CURRENT user.
# Uses the per-user Startup folder, so NO administrator elevation is required.
$ErrorActionPreference = 'Stop'

$projectDir = Split-Path $PSScriptRoot -Parent
$vbs        = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path $vbs)) { throw "run-hidden.vbs not found at $vbs" }

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'subsTranslator.lnk'

$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($lnkPath)
$lnk.TargetPath       = 'wscript.exe'
$lnk.Arguments        = "`"$vbs`""
$lnk.WorkingDirectory = $projectDir
$lnk.Description       = 'Starts the subsTranslator Stremio addon server at login.'
$lnk.Save()

Write-Host "Installed startup shortcut: $lnkPath"
Write-Host "Starting the server now..."
Start-Process wscript.exe -ArgumentList "`"$vbs`"" -WorkingDirectory $projectDir
Start-Sleep -Seconds 2
try {
  $m = Invoke-RestMethod 'http://127.0.0.1:7000/manifest.json' -TimeoutSec 5
  Write-Host "Server is up: $($m.name) v$($m.version)"
} catch {
  Write-Host "Server did not respond yet; it should be available shortly at http://127.0.0.1:7000/manifest.json"
}
