param(
  [string]$BuildDir = "C:\tmp\FeedMindBuild",
  [string]$Abi = "arm64-v8a",
  [string]$OutputApk = "",
  [switch]$KeepBuildDir
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Resolve-Pnpm {
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd) {
    return $cmd.Source
  }

  $candidates = @(
    "D:\app\nvm\v20.16.0\pnpm.cmd",
    "D:\app\nvm\v22.11.0\pnpm.cmd",
    "D:\app\nvm\v22.23.1\node_modules\corepack\shims\pnpm.cmd"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }

  $corepack = Get-Command corepack -ErrorAction SilentlyContinue
  if ($corepack) {
    return "corepack pnpm"
  }

  throw "pnpm was not found. Install pnpm or enable Corepack, then rerun this script."
}

function Write-Utf8NoBom {
  param(
    [string]$Path,
    [string]$Text
  )

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $encoding)
}

$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$PackageJson = Join-Path $ProjectRoot "package.json"
$AndroidDir = Join-Path $ProjectRoot "android"

if (-not (Test-Path -LiteralPath $PackageJson)) {
  throw "package.json was not found. Run this script from the project checkout."
}

if (-not (Test-Path -LiteralPath (Join-Path $AndroidDir "gradlew.bat"))) {
  throw "android\gradlew.bat was not found. Generate the native Android project first."
}

if ([string]::IsNullOrWhiteSpace($OutputApk)) {
  $OutputApk = Join-Path $ProjectRoot "FeedMind-$Abi-release.apk"
}

$BuildDirFull = [System.IO.Path]::GetFullPath($BuildDir)
if (-not $BuildDirFull.StartsWith("C:\tmp\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "BuildDir must be under C:\tmp for safety. Got: $BuildDirFull"
}

Write-Step "Preparing short-path build directory: $BuildDirFull"
if ((Test-Path -LiteralPath $BuildDirFull) -and -not $KeepBuildDir) {
  Remove-Item -LiteralPath $BuildDirFull -Recurse -Force
}

New-Item -ItemType Directory -Path $BuildDirFull -Force | Out-Null

$robocopyArgs = @(
  $ProjectRoot,
  $BuildDirFull,
  "/E",
  "/XD", ".git", "node_modules", "android\build", "android\app\build", ".expo", "dist", "web-build",
  "/XF", "*.apk",
  "/NFL", "/NDL", "/NJH", "/NJS", "/NP"
)

& robocopy @robocopyArgs | Out-Host
if ($LASTEXITCODE -gt 7) {
  throw "robocopy failed with exit code $LASTEXITCODE"
}

Write-Step "Installing dependencies in build copy"
$pnpm = Resolve-Pnpm
if ($pnpm -eq "corepack pnpm") {
  & corepack pnpm install --frozen-lockfile --dir $BuildDirFull
} else {
  & $pnpm install --frozen-lockfile --dir $BuildDirFull
}

if ($LASTEXITCODE -ne 0) {
  throw "pnpm install failed with exit code $LASTEXITCODE"
}

$BuildAndroidDir = Join-Path $BuildDirFull "android"
$BuildGradleProperties = Join-Path $BuildAndroidDir "gradle.properties"

Write-Step "Setting Android ABI: $Abi"
$gradleProps = [System.IO.File]::ReadAllText($BuildGradleProperties, [System.Text.Encoding]::UTF8)
if ($gradleProps -match "(?m)^reactNativeArchitectures=") {
  $gradleProps = [regex]::Replace($gradleProps, "(?m)^reactNativeArchitectures=.*$", "reactNativeArchitectures=$Abi")
} else {
  $gradleProps = $gradleProps.TrimEnd() + [Environment]::NewLine + "reactNativeArchitectures=$Abi" + [Environment]::NewLine
}
Write-Utf8NoBom -Path $BuildGradleProperties -Text $gradleProps

Write-Step "Applying expo-sqlite CMake regeneration workaround"
$sqliteBuildGradle = Get-ChildItem -LiteralPath (Join-Path $BuildDirFull "node_modules\.pnpm") -Recurse -Filter "build.gradle" |
  Where-Object { $_.FullName -like "*\node_modules\expo-sqlite\android\build.gradle" } |
  Select-Object -First 1

if (-not $sqliteBuildGradle) {
  throw "Could not find expo-sqlite android build.gradle in node_modules."
}

$sqliteText = [System.IO.File]::ReadAllText($sqliteBuildGradle.FullName, [System.Text.Encoding]::UTF8)
if ($sqliteText.Length -gt 0 -and [int][char]$sqliteText[0] -eq 0xFEFF) {
  $sqliteText = $sqliteText.Substring(1)
}

if ($sqliteText -notlike "*-DCMAKE_SUPPRESS_REGENERATION=ON*") {
  $sqliteText = $sqliteText.Replace(
    'arguments "-DANDROID_STL=c++_shared",',
    'arguments "-DANDROID_STL=c++_shared",' + [Environment]::NewLine + '          "-DCMAKE_SUPPRESS_REGENERATION=ON",'
  )
}
Write-Utf8NoBom -Path $sqliteBuildGradle.FullName -Text $sqliteText

$sqliteCxxDir = Join-Path $sqliteBuildGradle.DirectoryName ".cxx"
if (Test-Path -LiteralPath $sqliteCxxDir) {
  Remove-Item -LiteralPath $sqliteCxxDir -Recurse -Force
}

Write-Step "Building release APK"
Push-Location $BuildAndroidDir
try {
  & cmd /c gradlew.bat assembleRelease
  if ($LASTEXITCODE -ne 0) {
    throw "Gradle build failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

$BuiltApk = Join-Path $BuildAndroidDir "app\build\outputs\apk\release\app-release.apk"
if (-not (Test-Path -LiteralPath $BuiltApk)) {
  throw "Gradle finished, but APK was not found at $BuiltApk"
}

Write-Step "Copying APK to $OutputApk"
Copy-Item -LiteralPath $BuiltApk -Destination $OutputApk -Force

$apk = Get-Item -LiteralPath $OutputApk
Write-Host ""
Write-Host "APK built successfully:"
Write-Host "  $($apk.FullName)"
Write-Host "  $([Math]::Round($apk.Length / 1MB, 2)) MB"