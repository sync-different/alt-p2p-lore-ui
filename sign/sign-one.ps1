# sign-one.ps1 — sign a single file with the Alterante code-signing certificate.
#
# Used as Tauri's `bundle > windows > signCommand`, which substitutes %1 with each file it
# wants signed. Driving signtool ourselves rather than letting Tauri do it buys two things:
# the exact command line is ours (Tauri's is opaque and its failure message carries none of
# signtool's own output), and every attempt is logged — which is the only way to see what a
# signing failure inside a build actually said.
#
# The certificate lives on a hardware token (EV/OV rules since 2023 — the key is not
# exportable), so signing needs the token plugged in and unlocked. With SafeNet's
# "single logon" enabled, one PIN entry covers a whole build; without it, expect a prompt per
# file, and a prompt that cannot reach an interactive desktop fails the build rather than
# waiting.
param([Parameter(Mandatory = $true)][string]$File)

$ErrorActionPreference = "Stop"

$thumb = "B8AE16C08756AF6ADE5D7732AA395B8090D98BD6"
# Timestamping is independent of the issuing CA, but using GlobalSign's keeps the chain of
# custody obvious. A signature without a timestamp dies with the certificate.
$tsa   = "http://timestamp.globalsign.com/tsa/r6advanced1"
$log   = Join-Path $env:TEMP "alt-lore-signing.log"

# Newest SDK signtool. Resolved rather than hardcoded so an SDK update does not break the build.
$signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\x64\\' } |
  Sort-Object FullName -Descending |
  Select-Object -First 1

if (-not $signtool) {
  "[$(Get-Date -Format o)] FATAL: signtool.exe not found under Windows Kits" | Add-Content $log
  exit 1
}

"[$(Get-Date -Format o)] signing: $File" | Add-Content $log
# Recorded because Tauri's working directory for signCommand is undocumented, and getting it
# wrong is silent: a relative script path fails before this script runs at all, and Tauri
# reports only "failed to run powershell" with nothing from PowerShell itself. Knowing the cwd
# is what lets this be referenced relatively instead of by an absolute machine path.
"    cwd: $((Get-Location).Path)" | Add-Content $log

$out = & $signtool.FullName sign /v /fd sha256 /sha1 $thumb /tr $tsa /td sha256 $File 2>&1
$code = $LASTEXITCODE

$out | ForEach-Object { "    $_" } | Add-Content $log
"[$(Get-Date -Format o)] exit=$code" | Add-Content $log

if ($code -ne 0) {
  # Surface it on stderr too: Tauri reports only "failed to run signtool", so without this
  # the reason never reaches the build output.
  $out | ForEach-Object { Write-Error $_ }
}
exit $code
