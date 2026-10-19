<#
  Install a desktop shortcut for the packaged (portable) JYSHarness build.
  Usage: .\install-shortcut.ps1 [-Location <dir>] [-Workspace <dir>] [-Name <name>]
#>
param(
  [string]$Location = [Environment]::GetFolderPath("Desktop"),
  [string]$Workspace = (Join-Path $env:USERPROFILE "harness-workspace"),
  [string]$Name = "JYSHarness"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root "jysharness.vbs"
if (-not (Test-Path $vbs)) { throw "launcher not found: $vbs" }
if (-not (Test-Path $Location)) { New-Item -ItemType Directory -Force -Path $Location | Out-Null }
if (-not (Test-Path $Workspace)) { New-Item -ItemType Directory -Force -Path $Workspace | Out-Null }

$shell = New-Object -ComObject WScript.Shell
$link = Join-Path $Location ($Name + ".lnk")
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$sc.Arguments = '"' + $vbs + '"'
$sc.WorkingDirectory = $Workspace
$sc.Description = "JYSHarness - AI agent harness"
$nodeIcon = Join-Path $root "runtime\node.exe"
if (Test-Path $nodeIcon) { $sc.IconLocation = $nodeIcon + ",0" }
else { $sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,13" }
$sc.Save()

Write-Host "installed: $link"
Write-Host "workspace: $Workspace"