#Requires -Version 5.1
<#
.SYNOPSIS
Manages a local dsh-superagent service on Windows: start, stop, restart and status, without tmux.

.DESCRIPTION
The Windows counterpart of scripts/dsh-superagent. It starts dsh for one DeepSeek Harness profile in a hidden
console, records the process ids, waits for the management API health, and stops the service with a graceful Ctrl+C.

status, start and restart exit 0 while the service runs normally; 1 when it is stopped, duplicated, unreachable or
reporting a runtime error, which restart may fix; 2 when it runs while a component such as a Source reports an error;
and 3 when it runs and waits for setup. A restart fixes neither 2 nor 3: they need a person.
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ROOT = Split-Path -Parent $PSScriptRoot
$ARTIFACTS = Join-Path $ROOT '.artifacts'
$CONTROL = Join-Path $ARTIFACTS 'control'
$KEEP_LOGS = 20
$PART_ERROR = 2
$SETUP_WAITS = 3

function Write-Line([string]$Text) {
  [Console]::Out.WriteLine($Text)
}

function Write-ErrorLine([string]$Text) {
  [Console]::Error.WriteLine($Text)
}

function Show-Help {
  Write-Line 'usage: dsh-superagent.cmd start|stop|restart|status [--profile <profile>] [--url <url>] [--timeout <seconds>] [--stop-timeout <seconds>] [--respect-stop]'
  Write-Line ''
  Write-Line 'Manages a local dsh-superagent service on Windows in a hidden console.'
  Write-Line ''
  Write-Line '  start         Start the service unless it already runs, and wait until it is ready or waits for setup.'
  Write-Line '  stop          Request a graceful shutdown and record the intentional stop.'
  Write-Line '  restart       Stop gracefully, then start.'
  Write-Line '  status        Print process ids, health and setup problems as JSON.'
  Write-Line ''
  Write-Line '  --profile <profile>      DSH profile that loads dsh-superagent (default: superagent, env DSH_SUPERAGENT_PROFILE).'
  Write-Line '  --url <url>              Health-check URL (default: http://127.0.0.1:3082, env DSH_SUPERAGENT_URL).'
  Write-Line '  --timeout <seconds>      Startup timeout in seconds (default: 60).'
  Write-Line '  --stop-timeout <seconds> Graceful shutdown timeout in seconds (default: 300).'
  Write-Line '  --respect-stop           For monitoring: never start or restart after an intentional stop.'
  exit 0
}

function Fail-Usage([string]$Message) {
  Write-ErrorLine ('dsh-superagent: error: ' + $Message)
  Write-ErrorLine 'usage: dsh-superagent.cmd start|stop|restart|status [--profile <profile>] [--url <url>] [--timeout <seconds>] [--stop-timeout <seconds>] [--respect-stop]'
  exit 2
}

function Convert-Seconds([string]$Name, [string]$Value) {
  $seconds = 0.0
  if (-not [double]::TryParse($Value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$seconds)) {
    Fail-Usage ($Name + ' must be a number of seconds')
  }
  if ($seconds -le 0) {
    Fail-Usage ($Name + ' must be positive')
  }
  return $seconds
}

function Read-Options([string[]]$Arguments) {
  $profile = 'superagent'
  if (-not [string]::IsNullOrEmpty($env:DSH_SUPERAGENT_PROFILE)) { $profile = $env:DSH_SUPERAGENT_PROFILE }
  $url = 'http://127.0.0.1:3082'
  if (-not [string]::IsNullOrEmpty($env:DSH_SUPERAGENT_URL)) { $url = $env:DSH_SUPERAGENT_URL }
  $options = [ordered]@{
    action = ''
    profile = $profile
    url = $url
    timeout = 60.0
    stopTimeout = 300.0
    respectStop = $false
  }
  $actions = New-Object System.Collections.Generic.List[string]
  $index = 0
  while ($index -lt $Arguments.Count) {
    $argument = [string]$Arguments[$index]
    if ($argument -eq '-h' -or $argument -eq '--help' -or $argument -eq '/?') { Show-Help }
    $name = $argument
    $value = $null
    $equals = $argument.IndexOf('=')
    if ($argument.StartsWith('--') -and $equals -gt 2) {
      $name = $argument.Substring(0, $equals)
      $value = $argument.Substring($equals + 1)
    }
    if ($name -eq '--profile' -or $name -eq '--url' -or $name -eq '--timeout' -or $name -eq '--stop-timeout') {
      if ($null -eq $value) {
        $index++
        if ($index -ge $Arguments.Count) { Fail-Usage ('option ' + $name + ' requires a value') }
        $value = [string]$Arguments[$index]
      }
      if ($name -eq '--profile') {
        $options.profile = $value
      } elseif ($name -eq '--url') {
        $options.url = $value
      } elseif ($name -eq '--timeout') {
        $options.timeout = Convert-Seconds $name $value
      } else {
        $options.stopTimeout = Convert-Seconds $name $value
      }
    } elseif ($argument -eq '--respect-stop') {
      $options.respectStop = $true
    } elseif ($argument.StartsWith('-')) {
      Fail-Usage ('unrecognized argument: ' + $argument)
    } else {
      $actions.Add($argument)
    }
    $index++
  }
  if ($actions.Count -eq 0) { Fail-Usage 'an action is required (start, stop, restart or status)' }
  if ($actions.Count -gt 1) { Fail-Usage ('unexpected arguments: ' + (($actions | Select-Object -Skip 1) -join ' ')) }
  $options.action = $actions[0]
  if (@('start', 'stop', 'restart', 'status') -notcontains $options.action) {
    Fail-Usage ('invalid action: ' + $options.action + ' (choose start, stop, restart or status)')
  }
  if ($options.profile -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') {
    Fail-Usage '--profile must be a DSH profile name'
  }
  return $options
}

function Get-ControlDirectory([string]$Profile) {
  $directory = Join-Path $CONTROL (Join-Path 'profiles' $Profile)
  [void][System.IO.Directory]::CreateDirectory($directory)
  return $directory
}

function Get-ControlFile([string]$Profile, [string]$Name) {
  return (Join-Path (Get-ControlDirectory $Profile) $Name)
}

function Read-PidFile([string]$Path) {
  try {
    if (-not [System.IO.File]::Exists($Path)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path)
    $first = ($text -split '\r?\n')[0].Trim()
    $value = 0
    if ([int]::TryParse($first, [ref]$value) -and $value -gt 0) { return $value }
    return $null
  } catch {
    return $null
  }
}

function Write-PidFile([string]$Path, [int]$ProcessId) {
  [System.IO.File]::WriteAllText($Path, $ProcessId.ToString() + [Environment]::NewLine)
}

function Test-ManuallyStopped([string]$Profile) {
  return [System.IO.File]::Exists((Get-ControlFile $Profile 'manually-stopped'))
}

function Set-ManuallyStopped([string]$Profile) {
  $path = Get-ControlFile $Profile 'manually-stopped'
  [System.IO.File]::WriteAllText($path, (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz') + [Environment]::NewLine)
}

function Clear-ManuallyStopped([string]$Profile) {
  $path = Get-ControlFile $Profile 'manually-stopped'
  if ([System.IO.File]::Exists($path)) { [System.IO.File]::Delete($path) }
}

function Enter-OperationLock([string]$Profile) {
  $path = Get-ControlFile $Profile 'operation.lock'
  try {
    return [System.IO.File]::Open($path, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch [System.IO.IOException] {
    throw 'Another dsh-superagent control operation is in progress.'
  }
}

function Get-OrchestratorState([string]$Url) {
  $request = $null
  $response = $null
  $reader = $null
  $text = $null
  try {
    $request = [System.Net.HttpWebRequest]::Create($Url.TrimEnd('/') + '/orchestrator/api/state')
    $request.Method = 'GET'
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $request.Proxy = $null
    $request.Headers.Add('x-orchestrator-request', '1')
    $response = $request.GetResponse()
    $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
    $text = $reader.ReadToEnd()
  } catch {
    return $null
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($response) { $response.Dispose() }
  }
  try {
    $value = $text | ConvertFrom-Json
  } catch {
    return $null
  }
  if ($null -eq $value) { return $null }
  $health = @{}
  $errors = @{}
  $setup = $null
  $feishu = $null
  if ($value.PSObject.Properties['health'] -and $value.health) {
    foreach ($entry in $value.health.PSObject.Properties) {
      $entryValue = $entry.Value
      $entryState = $null
      $entryDetail = ''
      if ($entryValue -and $entryValue.PSObject.Properties['state']) { $entryState = $entryValue.state }
      if ($entryValue -and $entryValue.PSObject.Properties['detail']) { $entryDetail = [string]$entryValue.detail }
      $health[$entry.Name] = $entryState
      if ($entryState -eq 'error') { $errors[$entry.Name] = $entryDetail }
    }
  }
  if ($value.PSObject.Properties['setup'] -and $value.setup) {
    if ($value.setup.PSObject.Properties['problem']) { $setup = $value.setup.problem }
    if ($value.setup.PSObject.Properties['feishuProblem']) { $feishu = $value.setup.feishuProblem }
  }
  return [pscustomobject]@{ health = $health; errors = $errors; setup = $setup; feishu = $feishu }
}

function Get-ProblemDetail($Problem) {
  if ($null -eq $Problem) { return '' }
  if ($Problem -is [string]) { return $Problem }
  if ($Problem.PSObject.Properties['detail']) { return [string]$Problem.detail }
  return ''
}

function Test-RuntimeUp($Current) {
  if ($null -eq $Current) { return $false }
  if (-not $Current.health) { return $false }
  if (-not $Current.health.ContainsKey('runtime')) { return $false }
  $runtime = $Current.health['runtime']
  return ($runtime -eq 'ready' -or $runtime -eq 'paused')
}

function Get-PartErrors($Current) {
  $parts = @{}
  if ($null -eq $Current) { return $parts }
  foreach ($name in @($Current.errors.Keys | Sort-Object)) {
    if ($name -ne 'runtime') { $parts[$name] = $Current.errors[$name] }
  }
  return $parts
}

function Get-Outcome([int[]]$Pids, $Current) {
  if ($Pids.Count -ne 1) { return 1 }
  if (-not (Test-RuntimeUp $Current)) { return 1 }
  if ($Current.setup) { return $SETUP_WAITS }
  if ((Get-PartErrors $Current).Count -gt 0) { return $PART_ERROR }
  return 0
}

function Test-DshServiceCommand([string]$CommandLine, [string]$Profile) {
  if ([string]::IsNullOrEmpty($CommandLine)) { return $false }
  $words = $CommandLine -split '\s+'
  $matched = $false
  $expectsProfile = $false
  $subcommands = New-Object System.Collections.Generic.List[string]
  for ($index = 1; $index -lt $words.Count; $index++) {
    $word = $words[$index]
    if ($expectsProfile) {
      if ($word -eq $Profile) { $matched = $true }
      $expectsProfile = $false
    } elseif ($word -eq '--profile') {
      $expectsProfile = $true
    } elseif ($word -eq ('--profile=' + $Profile)) {
      $matched = $true
    } elseif (-not $word.StartsWith('-')) {
      $subcommands.Add($word)
    }
  }
  if (-not $matched) { return $false }
  return (-not $subcommands.Contains('plugin'))
}

function Test-DshServiceProcess([int]$ProcessId, [string]$Profile) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) { return $false }
  if ($process.Name -notmatch '^(node|dsh)(\.exe)?$') { return $false }
  return (Test-DshServiceCommand $process.CommandLine $Profile)
}

function Get-DshProcesses([string]$Profile) {
  $found = New-Object System.Collections.Generic.List[int]
  $scanned = @()
  try {
    $scanned = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'dsh.exe'" -ErrorAction Stop)
  } catch {
    $scanned = @()
  }
  foreach ($process in $scanned) {
    if (Test-DshServiceCommand $process.CommandLine $Profile) {
      $processId = [int]$process.ProcessId
      if (-not $found.Contains($processId)) { $found.Add($processId) }
    }
  }
  $recorded = Read-PidFile (Get-ControlFile $Profile 'service.pid')
  if ($recorded -and -not $found.Contains($recorded) -and (Test-DshServiceProcess $recorded $Profile)) {
    $found.Add($recorded)
  }
  return $found.ToArray()
}

function Remove-OldLogs([string]$Profile) {
  if (-not [System.IO.Directory]::Exists($ARTIFACTS)) { return }
  $pattern = '^dsh-superagent-' + [regex]::Escape($Profile) + '-\d{8}-\d{6}-\d+\.log$'
  $logs = @(Get-ChildItem -LiteralPath $ARTIFACTS -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $pattern } | Sort-Object -Property LastWriteTime)
  if ($logs.Count -le $KEEP_LOGS) { return }
  $remove = $logs.Count - $KEEP_LOGS
  for ($index = 0; $index -lt $remove; $index++) {
    Remove-Item -LiteralPath $logs[$index].FullName -Force -ErrorAction SilentlyContinue
  }
}

function Remove-RecordedLauncher([string]$Profile) {
  $launcherPid = Read-PidFile (Get-ControlFile $Profile 'launcher.pid')
  if (-not $launcherPid) { return }
  $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $launcherPid" -ErrorAction SilentlyContinue
  if ($candidate -and $candidate.Name -eq 'cmd.exe' -and $candidate.CommandLine -and $candidate.CommandLine.Contains('--no-open') -and (Test-DshServiceCommand $candidate.CommandLine $Profile)) {
    Stop-Process -Id $launcherPid -Force -ErrorAction SilentlyContinue
  }
}

$script:ConsoleHelperLoaded = $false

function Initialize-ConsoleHelper {
  if ($script:ConsoleHelperLoaded) { return }
  $source = @'
using System;
using System.Runtime.InteropServices;

public static class DshSuperagentConsole
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GenerateConsoleCtrlEvent(uint controlEvent, uint processGroupId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetConsoleCtrlHandler(ConsoleCtrlDelegate handler, bool add);

    public delegate bool ConsoleCtrlDelegate(uint controlType);

    public static int Interrupt(uint processId)
    {
        SetConsoleCtrlHandler(null, true);
        FreeConsole();
        if (!AttachConsole(processId))
        {
            return -1;
        }
        bool sent = GenerateConsoleCtrlEvent(0, 0);
        FreeConsole();
        return sent ? 0 : -2;
    }
}
'@
  Add-Type -TypeDefinition $source -Language CSharp
  $script:ConsoleHelperLoaded = $true
}

function Send-ConsoleInterrupt([int]$ProcessId) {
  Initialize-ConsoleHelper
  return [DshSuperagentConsole]::Interrupt([uint32]$ProcessId)
}

function Request-GracefulStop([string]$Profile, [int]$ProcessId) {
  $target = $ProcessId
  $launcher = Read-PidFile (Get-ControlFile $Profile 'launcher.pid')
  if ($launcher) {
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $launcher" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Name -eq 'cmd.exe' -and $candidate.CommandLine -and $candidate.CommandLine.Contains('--no-open') -and (Test-DshServiceCommand $candidate.CommandLine $Profile)) {
      $target = $launcher
    }
  }
  $result = Send-ConsoleInterrupt $target
  if ($result -ne 0 -and $target -ne $ProcessId) {
    $result = Send-ConsoleInterrupt $ProcessId
  }
  if ($result -ne 0) {
    throw ("Could not request a graceful shutdown of PID ${ProcessId}: its console could not be reached. No forced kill was sent.")
  }
}

function Write-Status($Options) {
  $profile = $Options.profile
  $pids = @(Get-DshProcesses $profile)
  $current = $null
  if ($pids.Count -gt 0) { $current = Get-OrchestratorState $Options.url }
  $status = [ordered]@{
    pids = $pids
    cwd = $ROOT
    url = $Options.url
    manually_stopped = Test-ManuallyStopped $profile
    health = $null
    errors = $null
    setup = $null
    feishu = $null
  }
  if ($null -ne $current) {
    $status.health = $current.health
    $status.errors = $current.errors
    $status.setup = $current.setup
    $status.feishu = $current.feishu
  }
  Write-Line ($status | ConvertTo-Json -Depth 8)
  return (Get-Outcome $pids $current)
}

function Invoke-Start($Options) {
  $profile = $Options.profile
  $pids = @(Get-DshProcesses $profile)
  if ($pids.Count -gt 1) {
    throw 'Multiple dsh-superagent processes found; refusing to start another.'
  }
  if ($pids.Count -eq 0) {
    # npm installs dsh.ps1, dsh.cmd and an extensionless dsh. Get-Command's default first match is the
    # ExternalScript dsh.ps1, so resolve only Application commands and prefer the cmd/exe/bat shim.
    $command = Get-Command dsh -CommandType Application -All -ErrorAction SilentlyContinue |
      Where-Object { $_.Source -match '\.(cmd|bat|exe)$' } | Select-Object -First 1
    if (-not $command) { throw 'The dsh command must be on PATH. Install it with npm install -g @deepseek-ai/dsh.' }
    $source = $command.Source
    if (-not $source) { $source = $command.Path }
    if (-not $source) { throw 'The dsh command could not be resolved to a file.' }
    if (Get-OrchestratorState $Options.url) {
      throw 'An existing orchestrator answers at this URL; refusing duplicate startup.'
    }
    $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $log = Join-Path $ARTIFACTS ("dsh-superagent-$profile-$stamp-$PID.log")
    [System.IO.File]::WriteAllText($log, '')
    Remove-OldLogs $profile
    $commandShell = Join-Path $env:SystemRoot 'System32\cmd.exe'
    if (-not [System.IO.File]::Exists($commandShell)) { $commandShell = 'cmd.exe' }
    $commandLine = '""' + $source + '" --profile ' + $profile + ' --no-open 1>>"' + $log + '" 2>&1"'
    $launcher = Start-Process -FilePath $commandShell -ArgumentList @('/d', '/s', '/c', $commandLine) -WindowStyle Hidden -PassThru
    Write-PidFile (Get-ControlFile $profile 'launcher.pid') $launcher.Id
    Write-Line ('Log: ' + $log)
  } else {
    Write-PidFile (Get-ControlFile $profile 'service.pid') $pids[0]
    Write-Line ("dsh-superagent already running (PID $($pids[0])); no duplicate started.")
  }
  Clear-ManuallyStopped $profile
  $deadline = (Get-Date).AddSeconds($Options.timeout)
  while ((Get-Date) -lt $deadline) {
    $found = @(Get-DshProcesses $profile)
    if ($found.Count -gt 0) { Write-PidFile (Get-ControlFile $profile 'service.pid') $found[0] }
    $current = Get-OrchestratorState $Options.url
    if ($found.Count -gt 0 -and (Test-RuntimeUp $current)) {
      $code = Write-Status $Options
      if ($current.setup) {
        Write-Line ('dsh-superagent is waiting for setup: ' + (Get-ProblemDetail $current.setup))
        Write-Line 'Open the URL DSH printed in the log, then the dsh-superagent overview.'
      }
      if ($current.feishu) {
        Write-Line ('dsh-superagent runs without Feishu: ' + (Get-ProblemDetail $current.feishu))
        Write-Line 'Fix it on the Feishu card of the Source settings.'
      }
      $partErrors = Get-PartErrors $current
      foreach ($name in @($partErrors.Keys | Sort-Object)) {
        Write-Line ("$name reports an error, which a restart does not fix: $($partErrors[$name])")
      }
      return $code
    }
    Start-Sleep -Seconds 1
  }
  $null = Write-Status $Options
  throw 'Startup health check timed out; inspect the log. Any running process was left intact.'
}

function Invoke-Stop($Options, [bool]$Intentional) {
  $profile = $Options.profile
  $pids = @(Get-DshProcesses $profile)
  if ($pids.Count -gt 1) {
    throw 'Multiple dsh-superagent processes found; refusing to choose one.'
  }
  if ($Intentional) {
    Set-ManuallyStopped $profile
  }
  foreach ($servicePid in $pids) {
    Request-GracefulStop $profile $servicePid
  }
  $deadline = (Get-Date).AddSeconds($Options.stopTimeout)
  while (@($pids | Where-Object { Test-DshServiceProcess $_ $profile }).Count -gt 0) {
    if ((Get-Date) -ge $deadline) {
      throw 'Graceful stop timed out; no forced kill was sent. Check status.'
    }
    Start-Sleep -Milliseconds 250
  }
  Remove-RecordedLauncher $profile
  $servicePidFile = Get-ControlFile $profile 'service.pid'
  if ([System.IO.File]::Exists($servicePidFile)) { [System.IO.File]::Delete($servicePidFile) }
  $launcherPidFile = Get-ControlFile $profile 'launcher.pid'
  if ([System.IO.File]::Exists($launcherPidFile)) { [System.IO.File]::Delete($launcherPidFile) }
  if ($Intentional) {
    Write-Line 'dsh-superagent stopped. Automatic recovery is paused until start/restart.'
  } else {
    Write-Line 'dsh-superagent stopped.'
  }
}

function Invoke-Main([string[]]$Arguments) {
  $options = Read-Options $Arguments
  [void](Get-ControlDirectory $options.profile)
  $lock = $null
  try {
    $lock = Enter-OperationLock $options.profile
    if ($options.respectStop -and ($options.action -eq 'start' -or $options.action -eq 'restart') -and (Test-ManuallyStopped $options.profile)) {
      Write-Line 'Intentional stop is active; automatic recovery skipped.'
      return 0
    }
    if ($options.action -eq 'status') {
      return (Write-Status $options)
    }
    if ($options.action -eq 'stop' -or $options.action -eq 'restart') {
      Invoke-Stop $options ($options.action -eq 'stop')
    }
    if ($options.action -eq 'start' -or $options.action -eq 'restart') {
      return (Invoke-Start $options)
    }
    return 0
  } finally {
    if ($lock) { $lock.Dispose() }
  }
}

try {
  $code = Invoke-Main -Arguments $args
  exit $code
} catch {
  Write-ErrorLine ([string]$_.Exception.Message)
  exit 1
}
