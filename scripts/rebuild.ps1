$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 or newer is required for development launchers.' }
  Write-Host 'PicPatch: rebuild '
  & node (Join-Path $PSScriptRoot 'launch.mjs') rebuild
  if ($LASTEXITCODE -ne 0) { throw "PicPatch launcher exited with $LASTEXITCODE." }
} catch {
  Write-Host $_ -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
