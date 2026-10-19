$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 or newer is required for development launchers.' }
  Write-Host 'PicPatch: run-dev '
  & node (Join-Path $PSScriptRoot 'launch.mjs') dev
  if ($LASTEXITCODE -in @(129, 130, 143)) { exit $LASTEXITCODE }
  if ($LASTEXITCODE -ne 0) { throw "PicPatch launcher exited with $LASTEXITCODE." }
} catch {
  Write-Host $_ -ForegroundColor Red
  if (-not [Console]::IsInputRedirected -and [Environment]::UserInteractive) { Read-Host 'Press Enter to close' }
  exit 1
}
