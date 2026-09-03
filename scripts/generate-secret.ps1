<#
.SYNOPSIS
生成密码学安全的通用密钥。

.DESCRIPTION
使用系统密码学随机数生成器创建密钥。默认输出一个由 32 个随机字节编码而成的 Base64 字符串，
适用于 SOURCE_CREDENTIALS_KEY、READER_CREDENTIALS_KEY 和 OAuth Client Secret 等配置。

.PARAMETER Bytes
每个密钥包含的随机字节数，范围为 16 至 4096，默认 32。

.PARAMETER Format
输出格式：Base64、Base64Url 或 Hex，默认 Base64。

.PARAMETER Count
生成数量，范围为 1 至 100，默认 1。

.EXAMPLE
./scripts/generate-secret.ps1

.EXAMPLE
./scripts/generate-secret.ps1 -Format Base64Url -Bytes 48

.EXAMPLE
./scripts/generate-secret.ps1 -Format Hex -Count 3
#>

[CmdletBinding()]
param(
  [ValidateRange(16, 4096)]
  [int]$Bytes = 32,

  [ValidateSet("Base64", "Base64Url", "Hex")]
  [string]$Format = "Base64",

  [ValidateRange(1, 100)]
  [int]$Count = 1
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
  for ($index = 0; $index -lt $Count; $index++) {
    $buffer = New-Object byte[] $Bytes
    $random.GetBytes($buffer)

    switch ($Format) {
      "Base64" {
        [Convert]::ToBase64String($buffer)
      }
      "Base64Url" {
        [Convert]::ToBase64String($buffer).TrimEnd("=").Replace("+", "-").Replace("/", "_")
      }
      "Hex" {
        [BitConverter]::ToString($buffer).Replace("-", "").ToLowerInvariant()
      }
    }
  }
}
finally {
  $random.Dispose()
}
