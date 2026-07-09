# Removes the subsTranslator login auto-start shortcut and stops the running server.
$ErrorActionPreference = 'Stop'

$startup = [Environment]::GetFolderPath('Startup')
$lnkPath = Join-Path $startup 'subsTranslator.lnk'
if (Test-Path $lnkPath) {
  Remove-Item $lnkPath -Force
  Write-Host "Removed startup shortcut: $lnkPath"
} else {
  Write-Host "No startup shortcut found at $lnkPath"
}

# Stop any running server listening on port 7000.
$conns = Get-NetTCPConnection -LocalPort 7000 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    try { Stop-Process -Id $_ -Force; Write-Host "Stopped server process $_" } catch {}
  }
}
