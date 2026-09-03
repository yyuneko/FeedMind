param(
  [switch]$DryRun,
  [switch]$SkipMigrations,
  [switch]$SkipChecks,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Step {
  param([string]$Message)

  Write-Host ""
  Write-Host "==> $Message"
}

function Invoke-Pnpm {
  param(
    [string]$Description,
    [string[]]$Arguments
  )

  Write-Step $Description
  & $script:Pnpm @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

function Invoke-WorkerPnpm {
  param(
    [string]$Worker,
    [string]$Description,
    [string[]]$Arguments
  )

  $WorkerRoot = Join-Path $ProjectRoot "workers/$Worker"
  $PreviousNativeDirectory = [Environment]::CurrentDirectory
  Push-Location $WorkerRoot
  try {
    # Windows PowerShell 5.1 does not always synchronize its location with the
    # native process working directory used by Node/esbuild.
    [Environment]::CurrentDirectory = $WorkerRoot
    Invoke-Pnpm -Description $Description -Arguments $Arguments
  } finally {
    [Environment]::CurrentDirectory = $PreviousNativeDirectory
    Pop-Location
  }
}

function Get-DeploymentFingerprint {
  param([string]$Worker)

  $InputFiles = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
  $WorkerRoot = Join-Path $ProjectRoot "workers/$Worker"

  foreach ($RelativePath in @("package.json", "wrangler.jsonc")) {
    $InputFiles.Add((Get-Item -LiteralPath (Join-Path $WorkerRoot $RelativePath)))
  }

  foreach ($Directory in @("src", "public")) {
    $Path = Join-Path $WorkerRoot $Directory
    if (Test-Path -LiteralPath $Path) {
      Get-ChildItem -LiteralPath $Path -Recurse -File | ForEach-Object { $InputFiles.Add($_) }
    }
  }

  if ($Worker -notin @("c-web", "admin-web")) {
    Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "workers/shared/src") -Recurse -File |
      ForEach-Object { $InputFiles.Add($_) }
  }

  if ($Worker -eq "pipeline") {
    $InputFiles.Add((Get-Item -LiteralPath (Join-Path $ProjectRoot "src/utils/html.ts")))
  }

  if ($Worker -eq "translation-workflow") {
    foreach ($RelativePath in @("src/utils/html.ts", "src/utils/translationHtml.ts", "src/types/index.ts")) {
      $InputFiles.Add((Get-Item -LiteralPath (Join-Path $ProjectRoot $RelativePath)))
    }
  }

  if ($Worker -eq "c-web") {
    Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "dist") -Recurse -File |
      ForEach-Object { $InputFiles.Add($_) }
  }

  # Dependency resolution can alter the bundle even when source files do not.
  $InputFiles.Add((Get-Item -LiteralPath (Join-Path $ProjectRoot "pnpm-lock.yaml")))

  $Lines = $InputFiles |
    Sort-Object -Property FullName -Unique |
    ForEach-Object {
      $RelativePath = $_.FullName.Substring($ProjectRoot.Length).TrimStart([char[]]@("\", "/")).Replace("\", "/")
      $FileHash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      "$RelativePath`0$FileHash"
    }

  $Payload = [System.Text.Encoding]::UTF8.GetBytes($Lines -join "`n")
  $Hasher = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($Hasher.ComputeHash($Payload))).Replace("-", "").ToLowerInvariant()
  } finally {
    $Hasher.Dispose()
  }
}

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$PnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
if (-not $PnpmCommand) {
  $PnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
}
$script:Pnpm = if ($PnpmCommand) { $PnpmCommand.Source } else { $null }
if (-not $script:Pnpm) {
  throw "pnpm was not found. Install pnpm or enable Corepack, then rerun this script."
}

$WorkerOrder = @(
  "ai-service",
  "translation-workflow",
  "pipeline",
  "c-api",
  "reader-api",
  "admin-api",
  "gpt-actions-api",
  "c-web",
  "admin-web"
)

# Keep this list explicit because Service Bindings and Workflows require a stable
# deployment order. Fail when a new deployable Worker has not been ordered yet.
$ConfiguredWorkers = Get-ChildItem -LiteralPath (Join-Path $ProjectRoot "workers") -Directory |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "wrangler.jsonc") } |
  Select-Object -ExpandProperty Name
$UnorderedWorkers = @($ConfiguredWorkers | Where-Object { $_ -notin $WorkerOrder })
$MissingWorkers = @($WorkerOrder | Where-Object { $_ -notin $ConfiguredWorkers })

if ($UnorderedWorkers.Count -gt 0) {
  throw "Deployable Worker(s) missing from deployment order: $($UnorderedWorkers -join ', ')."
}
if ($MissingWorkers.Count -gt 0) {
  throw "Deployment order references missing Worker(s): $($MissingWorkers -join ', ')."
}

function Get-UnstagedPaths {
  $GitArguments = @("-c", "core.quotepath=false", "-c", "safe.directory=$($ProjectRoot.Replace('\', '/'))")
  $ModifiedPaths = @(& git @GitArguments diff --name-only --diff-filter=ACDMRTUXB --)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read unstaged Git changes (git diff exited with code $LASTEXITCODE)."
  }

  $UntrackedPaths = @(& git @GitArguments ls-files --others --exclude-standard --)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to read untracked Git files (git ls-files exited with code $LASTEXITCODE)."
  }

  return @($ModifiedPaths + $UntrackedPaths | Where-Object { $_ } | Sort-Object -Unique)
}

function Get-AffectedWorkers {
  param([string[]]$ChangedPaths)

  $Affected = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $BackendWorkers = @($WorkerOrder | Where-Object { $_ -notin @("c-web", "admin-web") })

  foreach ($Path in $ChangedPaths) {
    $NormalizedPath = $Path.Replace("\", "/")

    if ($NormalizedPath -match '^workers/([^/]+)/(package\.json|wrangler\.jsonc|src/|public/)') {
      $Candidate = $Matches[1]
      if ($Candidate -in $WorkerOrder) {
        [void]$Affected.Add($Candidate)
      } elseif ($Candidate -eq "shared") {
        foreach ($Worker in $BackendWorkers) {
          [void]$Affected.Add($Worker)
        }
      }
    }

    if ($NormalizedPath -eq "pnpm-lock.yaml") {
      foreach ($Worker in $WorkerOrder) {
        [void]$Affected.Add($Worker)
      }
    }

    if ($NormalizedPath -eq "src/utils/html.ts") {
      [void]$Affected.Add("pipeline")
      [void]$Affected.Add("translation-workflow")
    }

    if ($NormalizedPath -in @("src/utils/translationHtml.ts", "src/types/index.ts")) {
      [void]$Affected.Add("translation-workflow")
    }

    if ($NormalizedPath -match '^(app|assets|src)/' -or $NormalizedPath -in @(
      "app.json", "babel.config.js", "metro.config.js", "package.json"
    )) {
      [void]$Affected.Add("c-web")
    }
  }

  return @($WorkerOrder | Where-Object { $Affected.Contains($_) })
}

Write-Step "Reading unstaged and untracked Worker changes"
$ChangedPaths = @(Get-UnstagedPaths)
$WorkersToDeploy = @(
  if ($Force) { $WorkerOrder } else { Get-AffectedWorkers -ChangedPaths $ChangedPaths }
)
$HasMigrationChanges = @($ChangedPaths | Where-Object { $_.Replace("\", "/") -like "workers/migrations/*" }).Count -gt 0

Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
if ($Force) {
  Write-Host "  WORKERS TO REDEPLOY (-Force: full deployment)" -ForegroundColor Black -BackgroundColor Yellow
} else {
  Write-Host "  WORKERS TO REDEPLOY (from unstaged Git changes)" -ForegroundColor Black -BackgroundColor Yellow
}
Write-Host "============================================================" -ForegroundColor Yellow
if ($WorkersToDeploy.Count -eq 0) {
  Write-Host "  (none)" -ForegroundColor DarkGray
} else {
  foreach ($Worker in $WorkersToDeploy) {
    Write-Host "  >>> workers/$Worker" -ForegroundColor Cyan
  }
}
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "Detected $($ChangedPaths.Count) unstaged or untracked file(s)."

Push-Location $ProjectRoot
try {
  if ($WorkersToDeploy.Count -eq 0 -and (-not $HasMigrationChanges -or $SkipMigrations)) {
    Write-Host "No affected Workers found; nothing to deploy."
    return
  }

  if (-not $SkipChecks) {
    Invoke-Pnpm -Description "Type-checking all Workers" -Arguments @("workers:typecheck")
    Invoke-Pnpm -Description "Testing all Workers" -Arguments @("workers:test")
  }

  if (-not $DryRun -and -not $SkipMigrations) {
    Invoke-WorkerPnpm -Worker "c-api" -Description "Applying remote D1 migrations" -Arguments @(
      "exec", "wrangler", "d1", "migrations", "apply", "feedmind", "--remote"
    )
  } elseif ($DryRun) {
    Write-Step "Dry run: skipping remote D1 migrations"
  } else {
    Write-Step "Skipping remote D1 migrations"
  }

  $ProcessedCount = 0
  foreach ($Worker in $WorkersToDeploy) {
    if ($Worker -eq "c-web") {
      Invoke-Pnpm -Description "Exporting Expo Web assets" -Arguments @(
        "exec", "expo", "export", "--platform", "web"
      )
    }

    $Fingerprint = Get-DeploymentFingerprint -Worker $Worker
    $DeployArguments = @("exec", "wrangler", "deploy", "--autoconfig=false")
    if ($DryRun) {
      $DeployArguments += "--dry-run"
    } else {
      $DeployArguments += @("--message", "feedmind-deploy-sha256:$Fingerprint")
    }

    $Action = if ($DryRun) { "Validating" } else { "Deploying" }
    Invoke-WorkerPnpm -Worker $Worker -Description "$Action workers/$Worker" -Arguments $DeployArguments
    $ProcessedCount++
  }
} finally {
  Pop-Location
}

Write-Host ""
if ($DryRun) {
  Write-Host "Worker deployment checks completed: $ProcessedCount validated."
} else {
  Write-Host "Worker deployment completed: $ProcessedCount deployed."
}
