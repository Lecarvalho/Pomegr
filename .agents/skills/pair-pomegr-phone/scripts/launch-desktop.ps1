[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RepositoryPath,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath $RepositoryPath).Path
if ($repository -match '[\r\n\x00]') { throw 'Repository path contains unsupported characters.' }
$packageFile = Join-Path $repository 'package.json'
$package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
if ($package.name -ne 'pomegr' -or $package.main -ne 'desktop/runtime/main.mjs') {
  throw 'This is not the Pomegr desktop checkout.'
}
$electron = Join-Path $repository 'node_modules\electron\dist\electron.exe'
$command = Join-Path $repository 'node_modules\.bin\electron.cmd'
foreach ($relative in @('desktop\runtime\main.mjs', 'desktop\workers\monitor-host.cjs', 'dist\server\index.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $repository $relative) -PathType Leaf)) {
    throw "Missing $relative. Run npm run desktop:prepare successfully before launching."
  }
}
if (-not (Test-Path -LiteralPath $electron -PathType Leaf) -or
    -not (Test-Path -LiteralPath $command -PathType Leaf)) {
  throw 'The checkout Electron runtime is missing.'
}
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
  Where-Object { $_.ExecutablePath -eq $electron })
$desktopShell = (New-Object -ComObject Shell.Application).Windows().FindWindowSW(0, 0, 8, [ref]0, 1)
if ($null -eq $desktopShell) { throw 'Explorer desktop is unavailable; no terminal was launched.' }
if ($CheckOnly) {
  [pscustomobject]@{
    Repository = $repository
    PrerequisitesPresent = $true
    ExplorerAvailable = $true
    ExistingElectronProcessIds = @($running | ForEach-Object { $_.ProcessId })
  }
  return
}
if ($running.Count -gt 0) { throw 'This checkout still has a running desktop. Quit that app before launching its replacement.' }

# The existing Explorer desktop owns this terminal, outside the caller's Windows job.
$launchCode = "`$pomegrLaunchId = '{0}'`nSet-Location -LiteralPath '{1}'`n& '.\node_modules\.bin\electron.cmd' ." -f
  ([guid]::NewGuid().ToString('N')), $repository.Replace("'", "''")
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launchCode))
$desktopShell.Document.Application.ShellExecute(
  'powershell.exe', "-NoLogo -NoProfile -NoExit -EncodedCommand $encoded", $repository, 'open', 1)
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$terminal = $null
do {
  $launchMatches = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like "* $encoded" })
  if ($launchMatches.Count -eq 1) { $terminal = $launchMatches[0]; break }
  if ($launchMatches.Count -gt 1) { throw 'Cannot uniquely identify the new terminal.' }
  Start-Sleep -Milliseconds 150
} while ([DateTime]::UtcNow -lt $deadline)
if ($null -eq $terminal) { throw 'Terminal launch was requested but its PID could not be confirmed. Inspect before retrying.' }
$parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($terminal.ParentProcessId)"
if ($parent.Name -ne 'explorer.exe') { throw "Terminal $($terminal.ProcessId) does not have the expected Explorer parent. Inspect before retrying." }

if (-not ('PomegrDesktopLaunchJob' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PomegrDesktopLaunchJob {
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll")] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
}
$handle = [PomegrDesktopLaunchJob]::OpenProcess(0x1000, $false, $terminal.ProcessId)
if ($handle -eq [IntPtr]::Zero) { throw "Cannot inspect terminal $($terminal.ProcessId). Inspect before retrying." }
try {
  $inJob = $false
  $checked = [PomegrDesktopLaunchJob]::IsProcessInJob($handle, [IntPtr]::Zero, [ref]$inJob)
  if (-not $checked -or $inJob) { throw "Terminal $($terminal.ProcessId) independence is unverified. Inspect before retrying." }
} finally { [PomegrDesktopLaunchJob]::CloseHandle($handle) | Out-Null }
[pscustomobject]@{
  Repository = $repository
  TerminalProcessId = $terminal.ProcessId
  ExplorerProcessId = $parent.ProcessId
  InWindowsJob = $false
  AppReadiness = 'Verify in the desktop UI'
}
