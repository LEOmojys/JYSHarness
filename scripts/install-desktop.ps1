<#
  Install a desktop shortcut for JYSHarness (repo checkout, requires node on PATH).

  Usage:
    .\scripts\install-desktop.ps1                          # shortcut on your Desktop
    .\scripts\install-desktop.ps1 -Location D:\links        # custom folder (tests use this)
    .\scripts\install-desktop.ps1 -Workspace D:\work         # default workspace for the app
#>
param(
  [string]$Location = [Environment]::GetFolderPath("Desktop"),
  [string]$Workspace = (Join-Path $env:USERPROFILE "harness-workspace"),
  [string]$Name = "JYSHarness"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$launcher = Join-Path $root "jys.cmd"

if (-not (Test-Path $launcher)) { throw "launcher not found: $launcher" }
if (-not (Test-Path $Location)) { New-Item -ItemType Directory -Force -Path $Location | Out-Null }

# The app needs a workspace to open; create it on first install.
if (-not (Test-Path $Workspace)) {
    New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
    Write-Host "created workspace: $Workspace"
}

$shell = New-Object -ComObject WScript.Shell
$link = Join-Path $Location ($Name + ".lnk")
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = $launcher
$shortcut.Arguments = "desktop --workspace `"$Workspace`""
$shortcut.WorkingDirectory = $root
$shortcut.Description = "JYSHarness - AI agent harness desktop app"
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$shortcut.Save()

Write-Host "installed: $link"
Write-Host "workspace: $Workspace"
