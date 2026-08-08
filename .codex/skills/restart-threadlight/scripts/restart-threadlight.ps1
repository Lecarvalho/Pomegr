[CmdletBinding()]
param(
  [ValidateRange(5, 60)]
  [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$monitorPath = Join-Path $repositoryRoot 'monitor\server.mjs'
$webCliPath = Join-Path $repositoryRoot 'node_modules\vinext\dist\cli.js'
$ports = 3003, 4317

function Get-ProcessTable {
  $table = @{}
  foreach ($process in Get-CimInstance Win32_Process) {
    $table[[int]$process.ProcessId] = $process
  }
  return $table
}

function Get-AncestorIds {
  param(
    [int]$ProcessId,
    [hashtable]$ProcessTable
  )

  $ancestors = [System.Collections.Generic.List[int]]::new()
  $currentId = $ProcessId
  for ($depth = 0; $depth -lt 12; $depth++) {
    if (-not $ProcessTable.ContainsKey($currentId)) { break }
    $parentId = [int]$ProcessTable[$currentId].ParentProcessId
    if ($parentId -le 0 -or $ancestors.Contains($parentId)) { break }
    $ancestors.Add($parentId)
    $currentId = $parentId
  }
  return $ancestors
}

function Get-DescendantIds {
  param(
    [int]$RootId,
    [hashtable]$ProcessTable
  )

  $descendants = [System.Collections.Generic.List[object]]::new()
  $queue = [System.Collections.Generic.Queue[object]]::new()
  $queue.Enqueue([pscustomobject]@{ Id = $RootId; Depth = 0 })
  while ($queue.Count -gt 0) {
    $current = $queue.Dequeue()
    foreach ($child in $ProcessTable.Values | Where-Object { [int]$_.ParentProcessId -eq [int]$current.Id }) {
      $entry = [pscustomobject]@{ Id = [int]$child.ProcessId; Depth = [int]$current.Depth + 1 }
      $descendants.Add($entry)
      $queue.Enqueue($entry)
    }
  }
  return $descendants
}

$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports })
$processTable = Get-ProcessTable

foreach ($listener in $listeners) {
  $processId = [int]$listener.OwningProcess
  if (-not $processTable.ContainsKey($processId)) {
    throw "Listener process $processId disappeared during validation. No processes were stopped."
  }

  $commandLine = [string]$processTable[$processId].CommandLine
  $isExpectedMonitor = $listener.LocalPort -eq 4317 -and $commandLine.IndexOf($monitorPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
  $isExpectedWeb = $listener.LocalPort -eq 3003 -and $commandLine.IndexOf($webCliPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and $commandLine -match '--port\s+3003\b'
  if (-not ($isExpectedMonitor -or $isExpectedWeb)) {
    throw "Port $($listener.LocalPort) is owned by an unrecognized process ($processId). No processes were stopped."
  }
}

if ($listeners.Count -gt 0) {
  $rootCandidates = foreach ($listener in $listeners) {
    foreach ($ancestorId in Get-AncestorIds -ProcessId ([int]$listener.OwningProcess) -ProcessTable $processTable) {
      $ancestor = $processTable[$ancestorId]
      if ([string]$ancestor.CommandLine -match 'scripts[/\\]dev\.mjs(?:\s|$)') { $ancestorId }
    }
  }
  $rootGroups = @($rootCandidates | Group-Object | Sort-Object Count -Descending)
  $rootId = if ($rootGroups.Count -gt 0 -and $rootGroups[0].Count -eq $listeners.Count) { [int]$rootGroups[0].Name } else { 0 }
  if ($rootId -le 0) {
    throw 'Could not prove that all Threadlight listeners share the expected dev-process root. No processes were stopped.'
  }

  $stopTargets = @(
    Get-DescendantIds -RootId $rootId -ProcessTable $processTable | Sort-Object Depth -Descending
    [pscustomobject]@{ Id = $rootId; Depth = 0 }
  )
  foreach ($target in $stopTargets) {
    try {
      Stop-Process -Id $target.Id -Force -ErrorAction Stop
    } catch {
      if (Get-Process -Id $target.Id -ErrorAction SilentlyContinue) {
        throw
      }
    }
  }
}

$terminal = Start-Process -FilePath powershell.exe -ArgumentList '-NoLogo', '-NoExit', '-Command', 'npm run dev' -WorkingDirectory $repositoryRoot -WindowStyle Normal -PassThru

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
  Start-Sleep -Milliseconds 500
  $readyPorts = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ports } | Select-Object -ExpandProperty LocalPort -Unique)
} until (($readyPorts -contains 3003 -and $readyPorts -contains 4317) -or (Get-Date) -ge $deadline)

if (-not ($readyPorts -contains 3003 -and $readyPorts -contains 4317)) {
  throw "Threadlight did not bind both ports within $TimeoutSeconds seconds. The standalone terminal remains open for inspection."
}

$monitorStatus = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:4317/health' -TimeoutSec 5).StatusCode
$dashboardStatus = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3003/' -TimeoutSec 10).StatusCode

[pscustomobject]@{
  TerminalProcessId = $terminal.Id
  MonitorStatus = $monitorStatus
  DashboardStatus = $dashboardStatus
  DashboardUrl = 'http://127.0.0.1:3003/'
}
