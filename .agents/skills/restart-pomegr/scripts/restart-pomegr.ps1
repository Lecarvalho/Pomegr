$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $skillRoot '..\..\..')).Path
$packagePath = Join-Path $repositoryRoot 'package.json'
$devScriptPath = Join-Path $repositoryRoot 'scripts\dev.mjs'

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $devScriptPath -PathType Leaf)) {
  throw 'Could not resolve the Pomegr repository from the restart skill package.'
}

# Dispatch through the existing Explorer desktop, not an in-process Shell.Application
# or Start-Process: those can inherit the calling agent's Windows job.
$desktopShell = (New-Object -ComObject Shell.Application).Windows().FindWindowSW(0, 0, 8, [ref]0, 1)
if ($null -eq $desktopShell) {
  throw 'Windows Explorer desktop is unavailable; an independent terminal was not launched.'
}

# A unique encoded command lets us identify this terminal without a shared PID file.
$launchCode = "`$pomegrLaunchId = '{0}'`nSet-Location -LiteralPath '{1}'`nnpm run dev" -f
  ([guid]::NewGuid().ToString('N')), $repositoryRoot.Replace("'", "''")
$encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($launchCode))
$desktopShell.Document.Application.ShellExecute(
  'powershell.exe', "-NoLogo -NoProfile -NoExit -EncodedCommand $encodedCommand",
  $repositoryRoot, 'open', 1)

$deadline = [DateTime]::UtcNow.AddSeconds(10)
$terminal = $null
while ([DateTime]::UtcNow -lt $deadline) {
  $launchMatches = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
    Where-Object { $_.CommandLine -like "* $encodedCommand" })
  if ($launchMatches.Count -eq 1) { $terminal = $launchMatches[0]; break }
  if ($launchMatches.Count -gt 1) { throw 'The launched terminal could not be identified uniquely.' }
  Start-Sleep -Milliseconds 100
}
if ($null -eq $terminal) {
  throw 'The independent terminal was requested but its process ID could not be confirmed.'
}

[pscustomobject]@{
  TerminalProcessId = $terminal.ProcessId
  Command = 'npm run dev'
}
