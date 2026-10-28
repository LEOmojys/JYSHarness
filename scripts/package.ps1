<#
  Build a portable, zero-install package.

  Result: dist/JYSHarness/  (double-click jysharness.cmd, no Node required)
          dist/JYSHarness-<version>-win-x64.zip

  Usage:
    .\scripts\package.ps1                 # full package with bundled node.exe
    .\scripts\package.ps1 -NoRuntime      # source-only (requires Node on PATH)
    .\scripts\package.ps1 -NoZip          # skip archive

  NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 without a
  BOM as ANSI, and CJK comments can then break parsing.
#>
param(
  [string]$OutDir = (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) "dist"),
  [switch]$NoRuntime,
  [switch]$NoZip
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$version = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$app = Join-Path $OutDir "JYSHarness"

Write-Host "JYSHarness $version -> $app"
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
New-Item -ItemType Directory -Force -Path $app | Out-Null

# application files (the project has zero runtime deps, so no node_modules)
foreach ($name in @("src", "docs", "examples", "scripts\templates", "scripts\sandbox", "jys.cmd", "jys.ps1", "package.json", "README.md", "QUICKSTART.md", "ARCHITECTURE.md", "DESKTOP.md", "PLUGINS.md")) {
  $from = Join-Path $root $name
  if (-not (Test-Path $from)) { continue }
  Copy-Item -Recurse -Force $from (Join-Path $app $name)
}

# launcher templates are real files on purpose: generating them by string
# concatenation silently eats backslashes (runtime\node.exe -> newline + ode.exe)
$templates = Join-Path $root "scripts\templates"
foreach ($t in @("jysharness.cmd", "jysharness.vbs", "install-shortcut.ps1")) {
  Copy-Item -Force (Join-Path $templates $t) (Join-Path $app $t)
}

# bundled runtime: the portable build must not depend on the target machine
if (-not $NoRuntime) {
  $runtime = Join-Path $app "runtime"
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  Copy-Item -Force (Get-Command node).Source (Join-Path $runtime "node.exe")
  Write-Host ("bundled runtime: " + [math]::Round((Get-Item (Join-Path $runtime "node.exe")).Length / 1MB) + " MB")
}

$runtimeLabel = if ($NoRuntime) { "system node" } else { "bundled node.exe" }
Set-Content -Path (Join-Path $app "VERSION.txt") -Encoding ASCII -Value @(
  "JYSHarness $version",
  "built " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss"),
  "runtime: " + $runtimeLabel
)

if (-not $NoZip) {
  $zip = Join-Path $OutDir ("JYSHarness-" + $version + "-win-x64.zip")
  if (Test-Path $zip) { Remove-Item -Force $zip }
  Compress-Archive -Path $app -DestinationPath $zip -CompressionLevel Optimal
  Write-Host ("archive: " + $zip + " (" + [math]::Round((Get-Item $zip).Length / 1MB, 1) + " MB)")
}

$total = (Get-ChildItem -Recurse -File $app | Measure-Object -Property Length -Sum).Sum
Write-Host ("package: " + $app + " (" + [math]::Round($total / 1MB, 1) + " MB)")
Write-Host "run:     jysharness.cmd    (or run install-shortcut.ps1 for a desktop icon)"