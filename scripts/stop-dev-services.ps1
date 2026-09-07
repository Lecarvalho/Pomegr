# Invoked only by the local development launcher. Never used by the monitor or HTTP routes.
$ErrorActionPreference = 'Stop'

function Test-NodeEntrypoint {
  param($Process, [string]$ScriptPath, [string]$Mode = '')
  if ($Process.Name -ne 'node.exe' -or -not $Process.ExecutablePath -or
      [System.IO.Path]::GetFileName($Process.ExecutablePath) -ne 'node.exe') { return $false }
  $command = ([string]$Process.CommandLine).Replace('/', '\')
  $script = [regex]::Escape($ScriptPath.Replace('/', '\'))
  # Match the entrypoint, not a path mentioned in an argument to an unrelated script.
  $executable = [regex]::Escape(([string]$Process.ExecutablePath).Replace('/', '\'))
  $pattern = '^(?:"' + $executable + '"|' + $executable + '|node(?:\.exe)?)\s+(?:"' + $script + '"|' + $script + ')(?=\s|$)'
  if ($Mode) { $pattern += '\s+' + [regex]::Escape($Mode) + '(?=\s|$)' }
  return [regex]::IsMatch($command, $pattern, 'IgnoreCase')
}

function Get-DevStopPlan {
  param([array]$Processes, [array]$Listeners, [string]$RepositoryRoot, [int]$LauncherId)
  $table = @{}
  foreach ($entry in $Processes) { $table[[int]$entry.ProcessId] = $entry }
  $protected = [System.Collections.Generic.HashSet[int]]::new()
  $cursor = $LauncherId
  while ($cursor -gt 0 -and $protected.Add($cursor) -and $table.ContainsKey($cursor)) {
    $cursor = [int]$table[$cursor].ParentProcessId
  }
  $roots = [System.Collections.Generic.HashSet[int]]::new()
  foreach ($entry in $Processes) {
    $entryId = [int]$entry.ProcessId
    if ($protected.Contains($entryId)) { continue }
    $known = (Test-NodeEntrypoint $entry (Join-Path $RepositoryRoot 'monitor\cli.mjs')) -or
      (Test-NodeEntrypoint $entry (Join-Path $RepositoryRoot 'scripts\run-vinext.mjs') 'dev') -or
      (Test-NodeEntrypoint $entry (Join-Path $RepositoryRoot 'node_modules\vinext\dist\cli.js') 'dev')
    if (-not $known) { continue }
    [void]$roots.Add($entryId)
    $cursor = $entryId
    $visited = [System.Collections.Generic.HashSet[int]]::new()
    while ($table.ContainsKey($cursor) -and $visited.Add($cursor)) {
      $child = $table[$cursor]
      $cursor = [int]$child.ParentProcessId
      if (-not $table.ContainsKey($cursor) -or $protected.Contains($cursor)) { break }
      $parent = $table[$cursor]
      if ($parent.CreationDate -gt $child.CreationDate) { break }
      # A relative npm entrypoint is trusted only through a child whose absolute
      # entrypoint proves this checkout's ownership.
      $devPaths = @((Join-Path $RepositoryRoot 'scripts\dev.mjs'), 'scripts\dev.mjs', '.\scripts\dev.mjs')
      foreach ($devPath in $devPaths) {
        if (Test-NodeEntrypoint $parent $devPath) { [void]$roots.Add($cursor) }
      }
    }
  }

  $targets = @{}
  function Add-DevTree([int]$TreeId, [int]$Depth) {
    if ($protected.Contains($TreeId)) { throw 'POMEGR_DEV_OWNERSHIP' }
    if ($targets.ContainsKey($TreeId)) { return }
    $entry = $table[$TreeId]
    $targets[$TreeId] = [pscustomobject]@{ Process = $entry; Depth = $Depth }
    foreach ($child in $Processes) {
      if ([int]$child.ParentProcessId -eq $TreeId -and $child.CreationDate -ge $entry.CreationDate) {
        Add-DevTree ([int]$child.ProcessId) ($Depth + 1)
      }
    }
  }
  # Ancestors first so overlapping trees retain their correct child-first depth.
  foreach ($rootId in @($roots | Sort-Object { $table[$_].CreationDate })) { Add-DevTree $rootId 0 }
  foreach ($listener in $Listeners) {
    if ($listener.LocalPort -in @(3003, 4317) -and -not $targets.ContainsKey([int]$listener.OwningProcess)) {
      throw ('POMEGR_DEV_PORT_' + $listener.LocalPort)
    }
  }
  return @($targets.Values | Sort-Object Depth -Descending)
}

function Stop-DevPlan {
  param([array]$Plan)
  foreach ($target in $Plan) {
    $original = $target.Process
    $processId = [int]$original.ProcessId
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $processId"
    if (-not $current) { continue }
    # A recycled PID must never become a new termination target.
    if ($current.CreationDate -ne $original.CreationDate -or
        $current.CommandLine -cne $original.CommandLine -or
        $current.ExecutablePath -cne $original.ExecutablePath) { throw 'POMEGR_DEV_OWNERSHIP' }
    # Hold a native process handle across the final identity check and termination.
    $handle = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if (-not $handle) { continue }
    try {
      $null = $handle.Handle
      # CIM timestamps have microsecond precision; .NET retains an extra digit.
      if ($handle.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssffffff') -ne
          $current.CreationDate.ToUniversalTime().ToString('yyyyMMddHHmmssffffff')) {
        throw 'POMEGR_DEV_OWNERSHIP'
      }
      $handle.Kill()
      if (-not $handle.WaitForExit(2000)) { throw 'POMEGR_DEV_STOP' }
    } catch {
      # Stopping a child can make its supervisor shut down the rest of the tree.
      if (-not $handle.HasExited) { throw }
    } finally { $handle.Dispose() }
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  $diagnosticStage = 'resolve_root'
  try {
    $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    $diagnosticStage = 'inspect_processes'
    $processes = @(Get-CimInstance Win32_Process)
    # Enumerate all TCP endpoints so an empty listener set is a normal result.
    $diagnosticStage = 'inspect_listeners'
    $listeners = @(Get-NetTCPConnection | Where-Object { $_.State -eq 'Listen' -and $_.LocalPort -in @(3003, 4317) })
    $diagnosticStage = 'plan'
    $plan = @(Get-DevStopPlan $processes $listeners $repositoryRoot ([int]$env:POMEGR_DEV_LAUNCHER_PID))
    $diagnosticStage = 'stop'
    Stop-DevPlan $plan
    Write-Output $plan.Count
  } catch {
    # Only fixed diagnostics cross the launcher boundary; never raw command lines/errors.
    [Console]::Error.WriteLine(('DIAGNOSTIC_HELPER_STAGE ' + $diagnosticStage))
    $diagnosticType = $_.Exception.GetType().Name
    if ($diagnosticType -notin @('RuntimeException', 'ParameterBindingException', 'ParameterBindingValidationException', 'MethodInvocationException', 'PSInvalidCastException', 'ArgumentException', 'ArgumentNullException', 'InvalidOperationException')) { $diagnosticType = 'other' }
    [Console]::Error.WriteLine(('DIAGNOSTIC_HELPER_TYPE ' + $diagnosticType))
    [Console]::Error.WriteLine(('DIAGNOSTIC_HELPER_LINE ' + [Math]::Min(2000, [Math]::Max(0, [int]$_.InvocationInfo.ScriptLineNumber))))
    switch -Exact ($_.Exception.Message) {
      'POMEGR_DEV_PORT_3003' { exit 10 }
      'POMEGR_DEV_PORT_4317' { exit 11 }
      'POMEGR_DEV_OWNERSHIP' { exit 12 }
      default { exit 13 }
    }
  }
}
