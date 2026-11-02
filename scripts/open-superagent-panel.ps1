<#
.SYNOPSIS
  Opens the dsh-superagent panel, starting the service first when it is not running.
.DESCRIPTION
  The panel URL carries a token that DSH prints into its newest log, so this
  launcher reads that URL instead of hard-coding one; a stale shortcut keeps
  working after restarts. Starting can take up to a minute.
.PARAMETER NoOpen
  Print the URL instead of opening the browser.
#>
[CmdletBinding()]
param(
  [string]$Profile = 'superagent',
  [string]$Url = 'http://127.0.0.1:3082',
  [int]$TimeoutSec = 90,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $scriptDir
$runner = Join-Path $scriptDir 'dsh-superagent.ps1'
$artifacts = Join-Path $repoRoot '.artifacts'

function Get-PanelUrl {
  if (-not (Test-Path -LiteralPath $artifacts)) { return $null }
  $pattern = '^dsh-superagent-' + [regex]::Escape($Profile) + '-\d{8}-\d{6}-\d+\.log$'
  $log = Get-ChildItem -LiteralPath $artifacts -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $pattern } |
    Sort-Object -Property LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $log) { return $null }
  $match = Select-String -LiteralPath $log.FullName -Pattern 'dsh web: (http\S+)' -ErrorAction SilentlyContinue |
    Select-Object -Last 1
  if ($match) { return $match.Matches[0].Groups[1].Value }
  return $null
}

if (-not (Test-Path -LiteralPath $runner)) {
  Write-Host "Cannot find the runner at $runner" -ForegroundColor Red
  exit 1
}

Write-Host "Checking dsh-superagent (profile $Profile)..."
# Run the runner as a child process so its JSON status output does not leak into the launcher console.
$null = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner status --profile $Profile --url $Url 2>&1
$code = $LASTEXITCODE
if ($code -eq 1) {
  Write-Host 'Starting dsh-superagent; this can take up to a minute...'
  $startOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $runner start --profile $Profile --url $Url --timeout $TimeoutSec 2>&1
  $code = $LASTEXITCODE
  foreach ($line in @($startOutput)) { Write-Host $line }
  if ($code -eq 1) {
    Write-Host 'dsh-superagent did not start. Run scripts\dsh-superagent.cmd status for details.' -ForegroundColor Red
    exit 1
  }
}

$panel = Get-PanelUrl
if (-not $panel) {
  Write-Host "The panel URL was not in the newest log yet; opening $Url instead." -ForegroundColor Yellow
  $panel = $Url
}
if ($NoOpen) { Write-Output $panel; exit 0 }
Start-Process $panel
Write-Host "Opened $panel"
exit 0
