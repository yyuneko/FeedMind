[CmdletBinding()]
param(
  [switch]$Execute,
  [switch]$IndependentPreflight,
  [switch]$SkipLocalChecks,
  [string]$ResumeArchive,
  [switch]$ResumeImported,
  [string]$TunnelId = $env:CLOUDFLARE_TUNNEL_ID,
  [string]$ZoneId = $env:CLOUDFLARE_ZONE_ID,
  [string]$AccountId = "841c2769e1a55cd93c7e23470de8bff7",
  [string]$DatabaseName = "feedmind",
  [string]$BucketName = "feedmind-content",
  [int64]$D1DailyRowsReadLimit = 5000000,
  [int]$DrainTimeoutMinutes = 60
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$DrivePnpmStore = Join-Path ([System.IO.Path]::GetPathRoot($ProjectRoot)) "pnpm-store"
$RuntimeRoot = Join-Path $ProjectRoot "server/local-runtime"
$SecretRoot = Join-Path $RuntimeRoot "secrets"
$DataRoot = Join-Path $RuntimeRoot ".local-data"
$ArchiveRoot = Join-Path $ProjectRoot ("migration-archives/" + (Get-Date -Format "yyyyMMdd-HHmmss"))
$Hostnames = @("app.feedmind.cc", "admin.feedmind.cc", "actions.feedmind.cc", "reader.feedmind.cc")
$CloudWorkers = @("c-api", "admin-api", "gpt-actions-api", "reader-api", "pipeline")
$CutoverComplete = $false
$MaintenanceEnabled = $false
$SkipD1Import = $false
$ExpectedClientAudience = "f657e874e6b31d81e7fdf718b688a37997f9e5a59b0ad7e0486ea06dc21a4acc"
$ExpectedAdminAudience = "0fb1d330b27a750c38b95f813b38976cfcd497c37589612efdd0083bc9c73da9"

function Write-Step([string]$Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $ProjectRoot) {
  $Previous = [Environment]::CurrentDirectory
  $PreviousErrorAction = $ErrorActionPreference
  Push-Location $WorkingDirectory
  try {
    [Environment]::CurrentDirectory = $WorkingDirectory
    $ErrorActionPreference = "Continue"
    & $File @Arguments
    $ExitCode = $LASTEXITCODE
    $ErrorActionPreference = $PreviousErrorAction
    if ($ExitCode -ne 0) { throw "$File exited with code $ExitCode" }
  } finally {
    $ErrorActionPreference = $PreviousErrorAction
    [Environment]::CurrentDirectory = $Previous
    Pop-Location
  }
}

function Invoke-Captured([string]$File, [string[]]$Arguments, [string]$WorkingDirectory = $ProjectRoot) {
  $Previous = [Environment]::CurrentDirectory
  $PreviousErrorAction = $ErrorActionPreference
  Push-Location $WorkingDirectory
  try {
    [Environment]::CurrentDirectory = $WorkingDirectory
    $ErrorActionPreference = "Continue"
    $Output = @(& $File @Arguments 2>&1)
    $ExitCode = $LASTEXITCODE
    $ErrorActionPreference = $PreviousErrorAction
    if ($ExitCode -ne 0) { throw ($Output -join [Environment]::NewLine) }
    return ($Output -join [Environment]::NewLine)
  } finally {
    $ErrorActionPreference = $PreviousErrorAction
    [Environment]::CurrentDirectory = $Previous
    Pop-Location
  }
}

function Invoke-WranglerCaptured([string[]]$Arguments, [string]$WorkingDirectory) {
  $ApiToken = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "Process")
  try {
    [Environment]::SetEnvironmentVariable("CLOUDFLARE_API_TOKEN", $null, "Process")
    $Wrangler = Join-Path $WorkingDirectory "node_modules/.bin/wrangler.cmd"
    return Invoke-Captured $Wrangler $Arguments $WorkingDirectory
  } finally {
    [Environment]::SetEnvironmentVariable("CLOUDFLARE_API_TOKEN", $ApiToken, "Process")
  }
}

function Read-SharedUtf8([string]$Path) {
  $Stream = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite)
  try {
    $Reader = [System.IO.StreamReader]::new($Stream, [System.Text.Encoding]::UTF8, $true)
    try { return $Reader.ReadToEnd() } finally { $Reader.Dispose() }
  } catch {
    $Stream.Dispose()
    throw
  }
}

function Stop-ProcessTreeBestEffort([System.Diagnostics.Process]$Process) {
  if (-not $Process) { return }
  try {
    $Process.Refresh()
    if ($Process.HasExited) { return }
    # taskkill can race with Wrangler exiting on its own. Route its diagnostics
    # through cmd so an already-gone PID remains a harmless, idempotent cleanup.
    & cmd.exe /d /c "taskkill /PID $($Process.Id) /T /F >nul 2>&1" | Out-Null
  } catch {
    # The target process is already gone, which is the desired final state.
  }
}

function Invoke-WranglerDeployChecked([string[]]$Arguments, [string]$WorkingDirectory) {
  $Wrangler = Join-Path $WorkingDirectory "node_modules/.bin/wrangler.cmd"
  $StandardOutput = [System.IO.Path]::GetTempFileName()
  $StandardError = [System.IO.Path]::GetTempFileName()
  $Process = $null
  try {
    $Process = Start-Process -FilePath $Wrangler -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
      -NoNewWindow -PassThru -RedirectStandardOutput $StandardOutput -RedirectStandardError $StandardError
    $Deadline = (Get-Date).AddMinutes(3)
    $SuccessAt = $null
    while (-not $Process.HasExited) {
      Start-Sleep -Milliseconds 500
      $Process.Refresh()
      $Output = Read-SharedUtf8 $StandardOutput
      if (-not $SuccessAt -and $Output -match 'Current Version ID:\s*[0-9a-f-]+') { $SuccessAt = Get-Date }
      if ($SuccessAt -and (Get-Date) -ge $SuccessAt.AddSeconds(5)) {
        Stop-ProcessTreeBestEffort $Process
        break
      }
      if ((Get-Date) -ge $Deadline) {
        Stop-ProcessTreeBestEffort $Process
        throw "Wrangler deploy did not complete within three minutes."
      }
    }
    $Output = Read-SharedUtf8 $StandardOutput
    $Errors = Read-SharedUtf8 $StandardError
    if ($Output) { Write-Host $Output.TrimEnd() }
    if ($Errors) { Write-Host $Errors.TrimEnd() }
    if ($Output -notmatch 'Current Version ID:\s*[0-9a-f-]+') {
      $ExitCode = if ($Process.HasExited) { $Process.ExitCode } else { -1 }
      throw "Wrangler deploy failed with code $ExitCode."
    }
  } finally {
    Remove-Item -LiteralPath $StandardOutput, $StandardError -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-WranglerExportChecked([string[]]$Arguments, [string]$WorkingDirectory) {
  $Wrangler = Join-Path $WorkingDirectory "node_modules/.bin/wrangler.cmd"
  $OutputArgument = $Arguments | Where-Object { $_ -like "--output=*" } | Select-Object -First 1
  if (-not $OutputArgument) { throw "Wrangler D1 export requires an --output path." }
  $ExportPath = $OutputArgument.Substring("--output=".Length)
  $StandardOutput = [System.IO.Path]::GetTempFileName()
  $StandardError = [System.IO.Path]::GetTempFileName()
  $Process = $null
  try {
    $Process = Start-Process -FilePath $Wrangler -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
      -NoNewWindow -PassThru -RedirectStandardOutput $StandardOutput -RedirectStandardError $StandardError
    $Deadline = (Get-Date).AddMinutes(30)
    $Succeeded = $false
    while (-not $Process.HasExited) {
      Start-Sleep -Milliseconds 500
      $Process.Refresh()
      $Output = Read-SharedUtf8 $StandardOutput
      if ($Output -match 'Downloaded to .+ successfully!' -and (Test-Path -LiteralPath $ExportPath) `
          -and (Get-Item -LiteralPath $ExportPath).Length -gt 0) {
        $Succeeded = $true
        Start-Sleep -Seconds 2
        Stop-ProcessTreeBestEffort $Process
        break
      }
      if ((Get-Date) -ge $Deadline) {
        Stop-ProcessTreeBestEffort $Process
        throw "Wrangler D1 export did not complete within thirty minutes."
      }
    }
    $Output = Read-SharedUtf8 $StandardOutput
    $Errors = Read-SharedUtf8 $StandardError
    if ($Output) { Write-Host $Output.TrimEnd() }
    if ($Errors) { Write-Host $Errors.TrimEnd() }
    if (-not $Succeeded) {
      $Succeeded = $Output -match 'Downloaded to .+ successfully!' -and (Test-Path -LiteralPath $ExportPath) `
        -and (Get-Item -LiteralPath $ExportPath).Length -gt 0
    }
    if (-not $Succeeded) {
      $ExitCode = if ($Process.HasExited) { $Process.ExitCode } else { -1 }
      throw "Wrangler D1 export failed with code $ExitCode."
    }
  } finally {
    Remove-Item -LiteralPath $StandardOutput, $StandardError -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-WranglerChecked([string[]]$Arguments, [string]$WorkingDirectory) {
  $ApiToken = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "Process")
  try {
    [Environment]::SetEnvironmentVariable("CLOUDFLARE_API_TOKEN", $null, "Process")
    if ($Arguments.Count -gt 0 -and $Arguments[0] -eq "deploy") {
      Invoke-WranglerDeployChecked $Arguments $WorkingDirectory
    } elseif ($Arguments.Count -gt 1 -and $Arguments[0] -eq "d1" -and $Arguments[1] -eq "export") {
      Invoke-WranglerExportChecked $Arguments $WorkingDirectory
    } else {
      $Wrangler = Join-Path $WorkingDirectory "node_modules/.bin/wrangler.cmd"
      Invoke-Checked $Wrangler $Arguments $WorkingDirectory
    }
  } finally {
    [Environment]::SetEnvironmentVariable("CLOUDFLARE_API_TOKEN", $ApiToken, "Process")
  }
}

function Import-DotEnv([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($Line in [System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8)) {
    if ($Line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') { continue }
    $Name = $Matches[1]
    $Value = $Matches[2].Trim()
    if (($Value.StartsWith('"') -and $Value.EndsWith('"')) -or ($Value.StartsWith("'") -and $Value.EndsWith("'"))) {
      $Value = $Value.Substring(1, $Value.Length - 2)
    }
    if (-not [Environment]::GetEnvironmentVariable($Name, "Process")) {
      [Environment]::SetEnvironmentVariable($Name, $Value, "Process")
    }
  }
}

function Get-RequiredValue([string]$Name) {
  $Value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($Value)) { throw "Required secret or setting is missing: $Name" }
  return $Value
}

function Write-SecretFile([string]$Name) {
  $Value = Get-RequiredValue $Name
  [System.IO.Directory]::CreateDirectory($SecretRoot) | Out-Null
  $Path = Join-Path $SecretRoot $Name.ToLowerInvariant()
  [System.IO.File]::WriteAllText($Path, $Value, [System.Text.UTF8Encoding]::new($false))
}

function Invoke-CloudflareApi([string]$Method, [string]$Path, [object]$Body = $null) {
  $Token = Get-RequiredValue "CLOUDFLARE_API_TOKEN"
  $Parameters = @{
    Method = $Method
    Uri = "https://api.cloudflare.com/client/v4/$Path"
    Headers = @{ Authorization = "Bearer $Token"; Accept = "application/json" }
    TimeoutSec = 60
  }
  if ($null -ne $Body) {
    $Parameters.ContentType = "application/json; charset=utf-8"
    $Parameters.Body = ConvertTo-Json $Body -Depth 20 -Compress
  }
  $Response = $null
  for ($Attempt = 1; $Attempt -le 4; $Attempt++) {
    try {
      $Response = Invoke-RestMethod @Parameters
      break
    } catch {
      $Message = $_.Exception.Message
      $NameResolutionFailure = $Message -match "could not be resolved|name resolution|No such host"
      # GET/PUT/DELETE are idempotent here. A POST is retried only when DNS
      # resolution failed before the request could have reached Cloudflare.
      $CanRetry = $Attempt -lt 4 -and ($Method -ne "POST" -or $NameResolutionFailure)
      if (-not $CanRetry) { throw }
      Start-Sleep -Seconds ([Math]::Pow(2, $Attempt - 1))
    }
  }
  # Cloudflare delete endpoints commonly return HTTP 204 with no JSON body.
  # Invoke-RestMethod represents that successful response as null/empty.
  if ($Method -eq "DELETE" -and ($null -eq $Response -or [string]::IsNullOrWhiteSpace([string]$Response))) {
    return $null
  }
  $Success = $Response.PSObject.Properties["success"]
  if ($null -eq $Success) {
    throw "Cloudflare API returned an unexpected response for $Method $Path."
  }
  if (-not $Success.Value) {
    $Messages = @($Response.errors | ForEach-Object { $_.message }) -join "; "
    throw "Cloudflare API request failed: $Messages"
  }
  return $Response.result
}

function Set-CloudMode([ValidateSet("normal", "read_only", "paused")][string]$Mode) {
  foreach ($Worker in $CloudWorkers) {
    $WorkerRoot = Join-Path $ProjectRoot "workers/$Worker"
    Invoke-WranglerChecked @("deploy", "--autoconfig=false", "--keep-vars", "--var", "MIGRATION_MODE:$Mode") $WorkerRoot
  }
}

function Get-D1Json([string]$Sql) {
  $WorkerRoot = Join-Path $ProjectRoot "workers/c-api"
  $Raw = Invoke-WranglerCaptured @("d1", "execute", $DatabaseName, "--remote", "--json", "--command", $Sql) $WorkerRoot
  $Clean = [regex]::Replace($Raw, "\x1B\[[0-?]*[ -/]*[@-~]", "")
  $Match = [regex]::Match($Clean, '(?ms)^\s*(\[.*\])\s*$')
  if (-not $Match.Success) { throw "Could not parse D1 query JSON returned by Wrangler." }
  $Parsed = $Match.Groups[1].Value | ConvertFrom-Json
  if ($Parsed -is [array]) { return $Parsed[0].results }
  return $Parsed.results
}

function Get-D1Info {
  $WorkerRoot = Join-Path $ProjectRoot "workers/c-api"
  $Raw = Invoke-WranglerCaptured @("d1", "info", $DatabaseName, "--json") $WorkerRoot
  $Match = [regex]::Match($Raw, '(?s)\{.*\}')
  if (-not $Match.Success) { throw "Could not parse D1 metadata returned by Wrangler." }
  return ($Match.Value | ConvertFrom-Json)
}

function Get-ActiveCloudWork {
  # Keep the SQL in one physical command-line argument. On Windows, invoking
  # wrangler.cmd with a multi-line --command value can truncate the SQL at the
  # first line and D1 then reports SQLITE_ERROR "incomplete input".
  $Sql = "SELECT (SELECT COUNT(*) FROM feeds WHERE fetch_status = 'running') + (SELECT COUNT(*) FROM article_parse_tasks WHERE status = 'running') + (SELECT COUNT(*) FROM article_preprocessing_tasks WHERE status = 'running') + (SELECT COUNT(*) FROM translations WHERE status = 'running') + (SELECT COUNT(*) FROM source_switch_jobs WHERE status = 'running') + (SELECT COUNT(*) FROM state_sync_outbox WHERE status = 'running') AS active_count;"
  $Rows = @(Get-D1Json $Sql)
  return [int64]$Rows[0].active_count
}

function Test-QueueBacklogs([switch]$CaptureSnapshot) {
  $Queues = @(Invoke-CloudflareApi "GET" "accounts/$AccountId/queues")
  $Relevant = @($Queues | Where-Object { $_.queue_name -in @("feedmind-feed", "feedmind-article", "feedmind-feed-dlq", "feedmind-article-dlq") })
  if ($Relevant.Count -ne 4) { throw "Could not verify all four production queues and DLQs." }
  $Snapshot = @()
  foreach ($Queue in $Relevant) {
    $Metrics = Invoke-CloudflareApi "GET" "accounts/$AccountId/queues/$($Queue.queue_id)/metrics"
    $Backlog = $Metrics.PSObject.Properties["backlog_count"]
    if ($null -eq $Backlog -or $null -eq $Backlog.Value) {
      throw "Cloudflare did not expose a verifiable backlog count for queue $($Queue.queue_name)."
    }
    $Count = [int64]$Backlog.Value
    $IsDeadLetterQueue = $Queue.queue_name -like "*-dlq"
    $Snapshot += [pscustomobject]@{ queue = $Queue.queue_name; backlog = $Count; dead_letter = $IsDeadLetterQueue }
  }
  if ($CaptureSnapshot) {
    $SnapshotPath = Join-Path $ArchiveRoot "cloudflare-queue-snapshot.json"
    $Payload = [ordered]@{ captured_at = (Get-Date).ToUniversalTime().ToString("o"); queues = $Snapshot } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($SnapshotPath, $Payload, [System.Text.UTF8Encoding]::new($false))
  }
}

function Wait-CloudDrain {
  $Deadline = (Get-Date).AddMinutes($DrainTimeoutMinutes)
  $ConsecutiveEmpty = 0
  # Queue and DLQ messages are intentionally not migrated. The local scheduler
  # rebuilds pending work from database state; keep only a count snapshot.
  Test-QueueBacklogs -CaptureSnapshot
  while ((Get-Date) -lt $Deadline) {
    $Active = Get-ActiveCloudWork
    if ($Active -eq 0) {
      $ConsecutiveEmpty++
      if ($ConsecutiveEmpty -ge 2) { return }
    } else {
      $ConsecutiveEmpty = 0
    }
    Start-Sleep -Seconds 20
  }
  throw "Cloud jobs, workflows, queues, or DLQs did not drain within $DrainTimeoutMinutes minutes."
}

function Restore-WorkerDomains {
  foreach ($Worker in @("c-web", "admin-web", "gpt-actions-api", "reader-api")) {
    $WorkerRoot = Join-Path $ProjectRoot "workers/$Worker"
    Invoke-WranglerChecked @("deploy", "--autoconfig=false") $WorkerRoot
  }
}

function Rollback-Cutover {
  Write-Step "Rolling hostnames back to Workers"
  foreach ($Hostname in $Hostnames) {
    $Records = @(Invoke-CloudflareApi "GET" "zones/$ZoneId/dns_records?type=CNAME&name=$Hostname")
    foreach ($Record in $Records) { [void](Invoke-CloudflareApi "DELETE" "zones/$ZoneId/dns_records/$($Record.id)") }
  }
  Restore-WorkerDomains
}

function Switch-HostnamesToTunnel {
  $Deadline = (Get-Date).AddSeconds(60)
  $Matched = @()
  do {
    $Domains = @(Invoke-CloudflareApi "GET" "accounts/$AccountId/workers/domains")
    $Matched = @($Domains | Where-Object { $_.hostname -in $Hostnames })
    if ($Matched.Count -eq 4) { break }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $Deadline)
  if ($Matched.Count -ne 4) { throw "Expected four Worker custom domains before cutover; found $($Matched.Count)." }
  foreach ($Domain in $Matched) { [void](Invoke-CloudflareApi "DELETE" "accounts/$AccountId/workers/domains/$($Domain.id)") }
  foreach ($Hostname in $Hostnames) {
    $Existing = @(Invoke-CloudflareApi "GET" "zones/$ZoneId/dns_records?name=$Hostname")
    foreach ($Record in $Existing) { [void](Invoke-CloudflareApi "DELETE" "zones/$ZoneId/dns_records/$($Record.id)") }
    [void](Invoke-CloudflareApi "POST" "zones/$ZoneId/dns_records" @{
      type = "CNAME"; name = $Hostname; content = "$TunnelId.cfargotunnel.com"; proxied = $true; ttl = 1
    })
  }
}

function Set-TunnelIngress {
  $Ingress = @($Hostnames | ForEach-Object { @{ hostname = $_; service = "http://gateway:8080" } })
  $Ingress += @{ service = "http_status:404" }
  [void](Invoke-CloudflareApi "PUT" "accounts/$AccountId/cfd_tunnel/$TunnelId/configurations" @{ config = @{ ingress = $Ingress } })
}

function Test-PublicEndpoints {
  foreach ($Hostname in $Hostnames) {
    $Accepted = $false
    $LastFailure = $null
    for ($Attempt = 1; $Attempt -le 18; $Attempt++) {
      $Status = 0
      $CurlOutput = & curl.exe -sS -o NUL -w "%{http_code}" --max-time 15 "https://$Hostname/health/live" 2>&1
      $CurlExitCode = $LASTEXITCODE
      if ($CurlExitCode -eq 0 -and [int]::TryParse(([string]$CurlOutput).Trim(), [ref]$Status)) {
        $LastFailure = $null
      } else {
        $LastFailure = ([string]$CurlOutput).Trim()
      }
      if ($Status -in @(200, 302, 401, 403)) {
        $Accepted = $true
        break
      }
      if ($Attempt -lt 18) { Start-Sleep -Seconds 5 }
    }
    if (-not $Accepted) {
      throw "Public endpoint $Hostname did not stabilize within 90 seconds (last status $Status; $LastFailure)."
    }
  }
}

try {
  if ($ResumeImported -and -not $ResumeArchive) {
    throw "-ResumeImported requires -ResumeArchive."
  }
  if ($ResumeArchive -and ($Execute -or $IndependentPreflight -or $SkipLocalChecks)) {
    throw "-ResumeArchive cannot be combined with -Execute, -IndependentPreflight, or -SkipLocalChecks."
  }
  if ($Execute -and $IndependentPreflight) {
    throw "-Execute and -IndependentPreflight cannot be used together."
  }
  if ($SkipLocalChecks -and -not ($IndependentPreflight -or $Execute)) {
    throw "-SkipLocalChecks requires -IndependentPreflight or -Execute."
  }
  $env:CI = "true"
  $env:WRANGLER_SEND_METRICS = "false"
  if (Test-Path -LiteralPath $DrivePnpmStore) {
    $env:npm_config_store_dir = $DrivePnpmStore
  }
  Write-Step "Loading local migration settings without printing secret values"
  Import-DotEnv (Join-Path $ProjectRoot ".env.production-secrets.local")
  Import-DotEnv (Join-Path $RuntimeRoot ".env.migration.local")
  $RuntimeSecrets = @("SOURCE_CREDENTIALS_KEY", "READER_CREDENTIALS_KEY", "OPENROUTER_API_KEY", "GPT_OAUTH_CLIENT_SECRET", "GPT_OAUTH_REDIRECT_URIS", "CLOUDFLARE_TUNNEL_TOKEN")
  $MigrationSettings = @("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID", "CLOUDFLARE_TUNNEL_ID")
  $Missing = @($RuntimeSecrets + $MigrationSettings | Where-Object { [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, "Process")) })
  if ($Missing.Count -gt 0) { throw "Migration preflight is missing required settings: $($Missing -join ', ')." }
  if (-not $TunnelId) { $TunnelId = Get-RequiredValue "CLOUDFLARE_TUNNEL_ID" }
  if (-not $ZoneId) { $ZoneId = Get-RequiredValue "CLOUDFLARE_ZONE_ID" }
  foreach ($Name in $RuntimeSecrets) {
    Write-SecretFile $Name
  }

  if ($ResumeArchive) {
    $ArchiveRoot = (Resolve-Path -LiteralPath $ResumeArchive).Path
    $DumpPath = Join-Path $ArchiveRoot "d1-export.sql"
    if (-not (Test-Path -LiteralPath $DumpPath -PathType Leaf)) {
      throw "Resume archive does not contain d1-export.sql: $ArchiveRoot"
    }
    if ((Get-Item -LiteralPath $DumpPath).Length -le 0) { throw "Resume D1 export is empty: $DumpPath" }
    $SkipD1Import = $ResumeImported
    $MaintenanceEnabled = $true
    $ResumePoint = if ($SkipD1Import) { "completed SQLite import" } else { "completed D1 export" }
    Write-Step "Resuming from $ResumePoint in $ArchiveRoot"
    # A previous attempt may have restored the Workers to normal before the
    # operator supplied or selected this export. Freeze the legacy runtime
    # again so it cannot keep scheduling work after the local cutover.
    Set-CloudMode "paused"
  } else {
  if (-not $SkipLocalChecks) {
    Write-Step "Running code, migration, and compose checks"
    Invoke-Checked "pnpm.cmd" @("local:typecheck")
    Invoke-Checked "pnpm.cmd" @("local:build")
    Invoke-Checked "pnpm.cmd" @("local:test")
    Invoke-Checked "pnpm.cmd" @("workers:typecheck")
    Invoke-Checked "pnpm.cmd" @("workers:test")
    Invoke-Checked "pnpm.cmd" @("exec", "expo", "export", "--platform", "web")
    Invoke-Checked "docker.exe" @("info", "--format", "{{.ServerVersion}}")
    Invoke-Checked "docker.exe" @("compose", "config", "--quiet")
    Invoke-Checked "docker.exe" @("compose", "build", "api", "worker")
  } else {
    Write-Step "Reusing local checks completed earlier in this maintenance session"
  }

  Write-Step "Checking D1 metadata, R2 credentials, disk capacity, Access, Tunnel, DNS, and queues"
  $D1Info = Get-D1Info
  if ([int64]$D1Info.database_size -le 0) { throw "Remote D1 size could not be verified." }
  $R2Estimate = (Invoke-Captured "node.exe" @("server/local-runtime/dist/migrate.mjs", "estimate-r2") | ConvertFrom-Json)
  $RequiredBytes = 3 * ([int64]$D1Info.database_size + [int64]$R2Estimate.bytes)
  $Drive = Get-PSDrive -Name ([System.IO.Path]::GetPathRoot($ProjectRoot).Substring(0, 1))
  if ([int64]$Drive.Free -lt $RequiredBytes) { throw "Free disk space is below three times the estimated D1 and R2 size." }
  $TargetDatabase = Join-Path $DataRoot "db/feedmind.sqlite"
  if (Test-Path -LiteralPath $TargetDatabase) { throw "Target SQLite database already exists: $TargetDatabase" }
  $ExistingContent = @(Get-ChildItem -LiteralPath (Join-Path $DataRoot "content") -File -Recurse -ErrorAction SilentlyContinue)
  $TemporaryContent = @($ExistingContent | Where-Object { $_.Name -like "*.tmp-*" })
  if ($TemporaryContent.Count -gt 0) { throw "Target content directory contains interrupted temporary objects." }
  if ($ExistingContent.Count -gt 0) {
    Write-Host "Reusing $($ExistingContent.Count) previously verified immutable content objects; only missing keys will be downloaded."
  }
  $Tunnel = Invoke-CloudflareApi "GET" "accounts/$AccountId/cfd_tunnel/$TunnelId"
  if ($Tunnel.status -eq "deleted") { throw "Configured Cloudflare Tunnel is deleted." }
  $Apps = @(Invoke-CloudflareApi "GET" "accounts/$AccountId/access/apps")
  $ClientApp = $Apps | Where-Object { $_.domain -eq "app.feedmind.cc" -or $_.domain -like "app.feedmind.cc/*" } | Select-Object -First 1
  $AdminApp = $Apps | Where-Object { $_.domain -eq "admin.feedmind.cc" -or $_.domain -like "admin.feedmind.cc/*" } | Select-Object -First 1
  if (-not $ClientApp) { throw "No Cloudflare Access application covers app.feedmind.cc." }
  if (-not $AdminApp) { throw "No Cloudflare Access application covers admin.feedmind.cc." }
  if ($ClientApp.aud -ne $ExpectedClientAudience) { throw "The app.feedmind.cc Access audience does not match the local runtime." }
  if ($AdminApp.aud -ne $ExpectedAdminAudience) { throw "The admin.feedmind.cc Access audience does not match the local runtime." }
  if ($ClientApp.aud -eq $AdminApp.aud) { throw "Client and Admin Access applications must use separate audiences." }
  $Domains = @(Invoke-CloudflareApi "GET" "accounts/$AccountId/workers/domains")
  $MatchedDomains = @($Domains | Where-Object { $_.hostname -in $Hostnames })
  if ($MatchedDomains.Count -ne 4) { throw "Expected four Worker custom domains before cutover; found $($MatchedDomains.Count)." }
  foreach ($Hostname in $Hostnames) {
    [void]@(Invoke-CloudflareApi "GET" "zones/$ZoneId/dns_records?name=$Hostname")
  }
  Test-QueueBacklogs

  if ($IndependentPreflight) {
    Write-Host "Independent preflight passed. D1 row-read schema verification and export were intentionally skipped." -ForegroundColor Green
    exit 0
  }

  Write-Step "Checking D1 row-read quota and schema compatibility"
  if ($D1DailyRowsReadLimit -gt 0 -and [int64]$D1Info.rows_read_24h -ge $D1DailyRowsReadLimit) {
    Write-Warning "D1 rows_read_24h is $($D1Info.rows_read_24h), at or above $D1DailyRowsReadLimit. This is a rolling metric; probing actual availability because free-tier limits reset at 00:00 UTC."
  }
  $Schema = @(Get-D1Json "SELECT id, name FROM d1_migrations ORDER BY id DESC LIMIT 1;")
  if (-not $Schema[0].name) { throw "Remote D1 migration state could not be verified." }
  $LatestMigrationFile = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "workers/migrations") -Filter "*.sql" -File |
    Sort-Object Name | Select-Object -Last 1
  if ([string]$Schema[0].name -ne $LatestMigrationFile.Name) {
    throw "Remote D1 migration $($Schema[0].name) is incompatible with local migration $($LatestMigrationFile.Name)."
  }

  if (-not $Execute) {
    Write-Host "All preflight gates passed. Re-run with -Execute to enter the maintenance window." -ForegroundColor Green
    exit 0
  }

  [System.IO.Directory]::CreateDirectory($ArchiveRoot) | Out-Null
  Write-Step "Entering read-only mode and draining Cloudflare work"
  Set-CloudMode "read_only"
  $MaintenanceEnabled = $true
  Wait-CloudDrain
  Set-CloudMode "paused"

  Write-Step "Exporting D1 and converting business data"
  $DumpPath = Join-Path $ArchiveRoot "d1-export.sql"
  $CWorkerRoot = Join-Path $ProjectRoot "workers/c-api"
  Invoke-WranglerChecked @("d1", "export", $DatabaseName, "--remote", "--skip-confirmation", "--output=$DumpPath") $CWorkerRoot
  }
  [System.IO.Directory]::CreateDirectory((Join-Path $DataRoot "db")) | Out-Null
  [System.IO.Directory]::CreateDirectory((Join-Path $DataRoot "content")) | Out-Null
  $DatabasePath = Join-Path $DataRoot "db/feedmind.sqlite"
  $ReportPath = Join-Path $ArchiveRoot "report"
  if ($SkipD1Import) {
    if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) { throw "Imported SQLite database is missing: $DatabasePath" }
    if (-not (Test-Path -LiteralPath (Join-Path $ReportPath "r2-manifest.txt") -PathType Leaf)) {
      throw "R2 manifest is missing from the resumed import: $ReportPath"
    }
  } else {
    Invoke-Checked "node.exe" @("server/local-runtime/dist/migrate.mjs", "import-d1", "--dump", $DumpPath, "--output", $DatabasePath, "--report", $ReportPath)
  }
  Invoke-Checked "node.exe" @("server/local-runtime/dist/migrate.mjs", "download-r2", "--manifest", (Join-Path $ReportPath "r2-manifest.txt"), "--content", (Join-Path $DataRoot "content"), "--report", (Join-Path $ReportPath "r2-download-report.json"))
  Invoke-Checked "node.exe" @("server/local-runtime/dist/migrate.mjs", "verify-content", "--database", $DatabasePath, "--content", (Join-Path $DataRoot "content"), "--report", (Join-Path $ReportPath "content-report.json"))
  Copy-Item -LiteralPath (Join-Path $ReportPath "r2-manifest.txt") -Destination (Join-Path $ArchiveRoot "r2-manifest.txt")

  Write-Step "Starting local API and Tunnel with the scheduler disabled"
  $env:MIGRATION_MODE = "paused"
  Set-TunnelIngress
  Invoke-Checked "docker.exe" @("compose", "up", "-d", "--no-deps", "api")
  Invoke-Checked "docker.exe" @("compose", "up", "-d", "gateway", "cloudflared")
  Invoke-Checked "docker.exe" @("compose", "exec", "-T", "api", "node", "server/local-runtime/dist/healthcheck.mjs")

  Write-Step "Moving all four hostnames from Worker custom domains to the Tunnel"
  # From the first custom-domain deletion onward, any failure requires a full
  # hostname rollback because the cutover may be only partially applied.
  $CutoverComplete = $true
  Switch-HostnamesToTunnel
  Test-PublicEndpoints

  Write-Step "Starting the local scheduler and worker"
  # The public read-only checks have passed. From this point local writes may
  # occur, so automatic rollback to the stale D1 database is no longer safe.
  $CutoverComplete = $false
  $MaintenanceEnabled = $false
  $env:MIGRATION_MODE = "normal"
  Invoke-Checked "docker.exe" @("compose", "up", "-d", "--force-recreate", "api", "worker")
  Test-PublicEndpoints
  Write-Host "Migration completed. Archive retained at $ArchiveRoot" -ForegroundColor Green
} catch {
  $Failure = $_
  if ($CutoverComplete) {
    try { Rollback-Cutover } catch { Write-Error "Automatic hostname rollback also failed: $($_.Exception.Message)" }
  }
  if ($MaintenanceEnabled) {
    try { Set-CloudMode "normal" } catch { Write-Error "Automatic maintenance-mode rollback also failed: $($_.Exception.Message)" }
  }
  throw $Failure
}
