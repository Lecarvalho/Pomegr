[CmdletBinding(SupportsShouldProcess)]
param(
  [switch]$LeaveDevStopped,
  [ValidateRange(5, 60)]
  [int]$RestartTimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_WINDOWS_REQUIRED'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageJsonPath = Join-Path $repositoryRoot 'package.json'
$devScriptPath = Join-Path $repositoryRoot 'scripts\dev.mjs'
$monitorCliPath = Join-Path $repositoryRoot 'monitor\cli.mjs'
$runVinextPath = Join-Path $repositoryRoot 'scripts\run-vinext.mjs'
$vinextCliPath = Join-Path $repositoryRoot 'node_modules\vinext\dist\cli.js'
$electronInstallerPath = Join-Path $repositoryRoot 'node_modules\electron\install.js'
$electronPath = Join-Path $repositoryRoot 'node_modules\electron\dist\electron.exe'
$npmCommand = Get-Command npm.cmd -CommandType Application | Select-Object -First 1 -ExpandProperty Source
$nodeCommand = Get-Command node.exe -CommandType Application | Select-Object -First 1 -ExpandProperty Source
$ports = 3003, 4317

if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
  throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_ROOT_INVALID'
}
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$outputDirectory = [string]$packageJson.build.directories.output
if ([string]::IsNullOrWhiteSpace($outputDirectory)) {
  throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_OUTPUT_INVALID'
}
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $outputDirectory))
$backupRoot = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot '.electron-builder-cache\local-package-backups'))
$packageVersion = [string]$packageJson.version
if ($packageVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') {
  throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_VERSION_INVALID'
}
$portablePath = Join-Path $releaseRoot "Pomegr-Portable-$packageVersion-x64.exe"
$unpackedAppPath = Join-Path $releaseRoot 'win-unpacked\Pomegr.exe'
if (-not $releaseRoot.StartsWith("$repositoryRoot\", [System.StringComparison]::OrdinalIgnoreCase) -or
    -not $backupRoot.StartsWith("$repositoryRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_OUTPUT_INVALID'
}

function Get-ProcessTable {
  $table = @{}
  foreach ($process in Get-CimInstance Win32_Process) {
    $table[[int]$process.ProcessId] = $process
  }
  return $table
}

function Test-ExactCommandArgument {
  param(
    [string]$CommandLine,
    [string]$Argument
  )

  if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($Argument)) {
    return $false
  }
  $pattern = '(?i)(?:^|\s|")' + [regex]::Escape($Argument) + '(?:"|\s|$)'
  return [regex]::IsMatch($CommandLine, $pattern)
}

function Test-ExactExecutablePath {
  param(
    [string]$ObservedPath,
    [string]$ExpectedPath
  )

  if ([string]::IsNullOrWhiteSpace($ObservedPath) -or [string]::IsNullOrWhiteSpace($ExpectedPath)) {
    return $false
  }
  return [string]::Equals(
    [System.IO.Path]::GetFullPath($ObservedPath),
    [System.IO.Path]::GetFullPath($ExpectedPath),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Test-DevRoot {
  param([object]$Process)

  return $Process.Name -ieq 'node.exe' -and
    (Test-ExactCommandArgument -CommandLine ([string]$Process.CommandLine) -Argument $devScriptPath)
}

function Test-RecognizedRepositoryRoot {
  param([object]$Process)

  $commandLine = [string]$Process.CommandLine
  if (Test-DevRoot -Process $Process) { return $true }
  if ($Process.Name -ieq 'node.exe' -and
      (Test-ExactCommandArgument -CommandLine $commandLine -Argument $monitorCliPath)) { return $true }
  if ($Process.Name -ieq 'node.exe' -and
      (Test-ExactCommandArgument -CommandLine $commandLine -Argument $runVinextPath) -and
      (Test-ExactCommandArgument -CommandLine $commandLine -Argument 'dev')) { return $true }
  if ($Process.Name -ieq 'node.exe' -and
      (Test-ExactCommandArgument -CommandLine $commandLine -Argument $vinextCliPath) -and
      (Test-ExactCommandArgument -CommandLine $commandLine -Argument 'dev')) { return $true }
  $executablePath = [string]$Process.ExecutablePath
  if ($Process.Name -ieq 'electron.exe' -and
      (Test-ExactExecutablePath -ObservedPath $executablePath -ExpectedPath $electronPath)) { return $true }
  if (Test-ExactExecutablePath -ObservedPath $executablePath -ExpectedPath $portablePath) { return $true }
  return Test-ExactExecutablePath -ObservedPath $executablePath -ExpectedPath $unpackedAppPath
}

function Get-DescendantTargets {
  param(
    [int]$RootId,
    [hashtable]$ProcessTable
  )

  $targets = [System.Collections.Generic.List[object]]::new()
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue([pscustomobject]@{ Id = $RootId; Depth = 0 })
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    $targets.Add($current)
    foreach ($child in $ProcessTable.Values | Where-Object { [int]$_.ParentProcessId -eq [int]$current.Id }) {
      $queue.Enqueue([pscustomobject]@{ Id = [int]$child.ProcessId; Depth = [int]$current.Depth + 1 })
    }
  }
  return $targets
}

function Stop-RecognizedRepositoryProcesses {
  $processTable = Get-ProcessTable
  $roots = @($processTable.Values | Where-Object { Test-RecognizedRepositoryRoot -Process $_ })
  $devWasRunning = @($roots | Where-Object { Test-DevRoot -Process $_ }).Count -gt 0
  if ($roots.Count -eq 0) {
    return $devWasRunning
  }

  $targetsById = @{}
  foreach ($root in $roots) {
    foreach ($target in Get-DescendantTargets -RootId ([int]$root.ProcessId) -ProcessTable $processTable) {
      $existing = $targetsById[[int]$target.Id]
      if (-not $existing -or [int]$target.Depth -gt [int]$existing.Depth) {
        $targetsById[[int]$target.Id] = $target
      }
    }
  }
  $targets = @($targetsById.Values | Sort-Object Depth -Descending)
  $targetIds = @($targets | Select-Object -ExpandProperty Id)
  $targetLabel = ($targetIds -join ', ')

  if (-not $PSCmdlet.ShouldProcess(
      "verified Pomegr process IDs $targetLabel",
      'Stop repository-owned processes before replacing node_modules'
    )) {
    return $devWasRunning
  }

  foreach ($target in $targets) {
    try {
      Stop-Process -Id ([int]$target.Id) -Force -ErrorAction Stop
    } catch {
      if (Get-Process -Id ([int]$target.Id) -ErrorAction SilentlyContinue) {
        throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_PROCESS_STOP_FAILED'
      }
    }
  }

  $deadline = (Get-Date).AddSeconds(10)
  do {
    $remaining = @($targetIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    if ($remaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 200
  } until ((Get-Date) -ge $deadline)
  if ($remaining.Count -gt 0) {
    throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_PROCESS_STOP_TIMEOUT'
  }

  return $devWasRunning
}

function Invoke-Npm {
  param(
    [string[]]$Arguments,
    [string]$FailureCode
  )

  & $npmCommand @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureCode
  }
}

function Install-ElectronRuntime {
  if (-not (Test-Path -LiteralPath $electronInstallerPath -PathType Leaf)) {
    throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_ELECTRON_INSTALLER_MISSING'
  }

  & $nodeCommand $electronInstallerPath
  if ($LASTEXITCODE -ne 0) {
    throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_ELECTRON_INSTALL_FAILED'
  }
  if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
    throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_ELECTRON_RUNTIME_MISSING'
  }
}

function Archive-ExistingReleaseOutput {
  if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
    return
  }
  $existingEntry = Get-ChildItem -LiteralPath $releaseRoot -Force | Select-Object -First 1
  if (-not $existingEntry) {
    return
  }

  $timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss-fff')
  $suffix = [guid]::NewGuid().ToString('N').Substring(0, 8)
  $backupPath = Join-Path $backupRoot "$timestamp-$suffix-release"
  if (-not $PSCmdlet.ShouldProcess(
      $releaseRoot,
      "Archive existing local release output to $backupPath"
    )) {
    return
  }

  try {
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $attempt = 0
    do {
      $attempt += 1
      try {
        [System.IO.Directory]::Move($releaseRoot, $backupPath)
        break
      } catch {
        if ($attempt -ge 5) { throw }
        Start-Sleep -Milliseconds (250 * $attempt)
      }
    } while ($true)
  } catch {
    throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_OUTPUT_ARCHIVE_FAILED'
  }
  Write-Host "Previous local release output archived at $backupPath."
}

function Start-DetachedDevServer {
  $escapedNodePath = $nodeCommand.Replace("'", "''")
  $escapedDevScriptPath = $devScriptPath.Replace("'", "''")
  $launchCommand = "& '$escapedNodePath' '$escapedDevScriptPath'"
  $terminal = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo', '-NoExit', '-Command', $launchCommand -WorkingDirectory $repositoryRoot -WindowStyle Normal -PassThru

  $deadline = (Get-Date).AddSeconds($RestartTimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 500
    $readyPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -in $ports } |
      Select-Object -ExpandProperty LocalPort -Unique)
  } until (($readyPorts -contains 3003 -and $readyPorts -contains 4317) -or (Get-Date) -ge $deadline)

  if (-not ($readyPorts -contains 3003 -and $readyPorts -contains 4317)) {
    throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_DEV_RESTART_TIMEOUT'
  }

  $monitorStatus = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4317/health' -TimeoutSec 5).StatusCode
  $dashboardStatus = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3003/' -TimeoutSec 10).StatusCode
  if ($monitorStatus -ne 200 -or $dashboardStatus -ne 200) {
    throw 'POMEGR_LOCAL_DESKTOP_PACKAGE_DEV_RESTART_FAILED'
  }

  Write-Host "Pomegr development server restored in terminal process $($terminal.Id)."
}

Push-Location $repositoryRoot
try {
  $devWasRunning = Stop-RecognizedRepositoryProcesses

  if ($PSCmdlet.ShouldProcess($repositoryRoot, 'Install locked dependencies with npm ci')) {
    Invoke-Npm -Arguments @('ci') -FailureCode 'POMEGR_LOCAL_DESKTOP_PACKAGE_NPM_CI_FAILED'
  }

  if ($PSCmdlet.ShouldProcess($repositoryRoot, 'Download and verify the Electron desktop runtime')) {
    Install-ElectronRuntime
  }

  Archive-ExistingReleaseOutput

  if ($PSCmdlet.ShouldProcess($repositoryRoot, 'Build the NSIS installer and portable desktop executable')) {
    Invoke-Npm -Arguments @('run', 'desktop:package') -FailureCode 'POMEGR_LOCAL_DESKTOP_PACKAGE_BUILD_FAILED'
  }

  if ($PSCmdlet.ShouldProcess($repositoryRoot, 'Inspect the packaged runtime, privacy boundary, and release artifacts')) {
    Invoke-Npm -Arguments @('run', 'desktop:inspect') -FailureCode 'POMEGR_LOCAL_DESKTOP_PACKAGE_INSPECTION_FAILED'
  }

  if ($devWasRunning -and -not $LeaveDevStopped -and
      $PSCmdlet.ShouldProcess($repositoryRoot, 'Restore the Pomegr development server')) {
    Start-DetachedDevServer
  }
} finally {
  Pop-Location
}

if ($WhatIfPreference) {
  Write-Host 'Pomegr local desktop packaging preview completed.'
} else {
  Write-Host 'Pomegr local desktop packaging completed.'
}
