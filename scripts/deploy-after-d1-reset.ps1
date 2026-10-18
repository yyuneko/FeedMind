param(
  [string]$TaskName = "FeedMind-Deploy-After-D1-Reset"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$DeployScript = Join-Path $PSScriptRoot "deploy-workers.ps1"
$LogDirectory = Join-Path $ProjectRoot ".deploy-logs"
$LogPath = Join-Path $LogDirectory ("scheduled-deploy-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null

try {
  "[$(Get-Date -Format o)] Starting scheduled FeedMind deployment." |
    Out-File -LiteralPath $LogPath -Encoding utf8

  Push-Location $ProjectRoot
  try {
    & $DeployScript -Force *>&1 |
      Out-File -LiteralPath $LogPath -Encoding utf8 -Append
  } finally {
    Pop-Location
  }

  "[$(Get-Date -Format o)] Scheduled deployment completed successfully." |
    Out-File -LiteralPath $LogPath -Encoding utf8 -Append
  exit 0
} catch {
  "[$(Get-Date -Format o)] Scheduled deployment failed: $($_.Exception.Message)" |
    Out-File -LiteralPath $LogPath -Encoding utf8 -Append
  exit 1
}
