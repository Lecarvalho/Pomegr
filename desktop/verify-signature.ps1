[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string[]] $Path,

    [Parameter(Mandatory = $false)]
    [string] $ExpectedSubject = $env:WINDOWS_PUBLISHER_SUBJECT
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ExpectedSubject) -or $ExpectedSubject -notmatch '^CN=.+,\s*[A-Z][A-Z0-9.]*=.+$') {
    throw 'DESKTOP_RELEASE_PUBLISHER_SUBJECT_MISSING'
}

foreach ($Candidate in $Path) {
    $Resolved = Resolve-Path -LiteralPath $Candidate -ErrorAction Stop
    $Item = Get-Item -LiteralPath $Resolved -Force
    if (-not $Item.PSIsContainer -and $Item.Length -gt 0 -and $Item.Extension -ieq '.exe') {
        $Signature = Get-AuthenticodeSignature -LiteralPath $Resolved
        if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $null -eq $Signature.SignerCertificate) {
            throw "DESKTOP_RELEASE_SIGNATURE_INVALID:$($Item.Name)"
        }
        if ($Signature.SignerCertificate.Subject -cne $ExpectedSubject) {
            throw "DESKTOP_RELEASE_PUBLISHER_INVALID:$($Item.Name)"
        }
        if ($null -eq $Signature.TimeStamperCertificate) {
            throw "DESKTOP_RELEASE_TIMESTAMP_MISSING:$($Item.Name)"
        }
        Write-Output "verified signature: $($Item.Name)"
        continue
    }
    throw "DESKTOP_RELEASE_SIGNED_FILE_INVALID"
}
