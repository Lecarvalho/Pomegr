$ErrorActionPreference = 'Stop'
$skillRoot = Split-Path -Parent $PSScriptRoot
$repositoryRoot = (Resolve-Path -LiteralPath (Join-Path $skillRoot '..\..\..')).Path
$packagePath = Join-Path $repositoryRoot 'package.json'
$devScriptPath = Join-Path $repositoryRoot 'scripts\dev.mjs'

if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $devScriptPath -PathType Leaf)) {
  throw 'Could not resolve the Pomegr repository from the restart skill package.'
}

$terminal = Start-Process -FilePath powershell.exe `
  -ArgumentList '-NoLogo', '-NoExit', '-Command', 'npm run dev' `
  -WorkingDirectory $repositoryRoot `
  -WindowStyle Normal `
  -PassThru

[pscustomobject]@{
  TerminalProcessId = $terminal.Id
  Command = 'npm run dev'
}
