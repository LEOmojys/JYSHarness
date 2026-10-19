#!/usr/bin/env pwsh
# JYSHarness launcher (PowerShell). Same behaviour as jys.cmd.
param([Parameter(ValueFromRemainingArguments = $true)] $Rest)
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$root/src/cli/main.ts" --workspace (Get-Location).Path @Rest
exit $LASTEXITCODE
