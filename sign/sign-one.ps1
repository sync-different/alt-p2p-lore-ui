# sign-one.ps1 - sign a single file with the Alterante code-signing certificate.
#
# Used as Tauri's `bundle > windows > signCommand`, which substitutes %1 with each file it wants
# signed. Driving signtool ourselves rather than letting Tauri do it buys two things: the exact
# command line is ours (Tauri's is opaque and its failure message carries none of signtool's own
# output), and every attempt is logged - the only way to see what a signing failure inside a build
# actually said.
#
# SIGNING IS PRESENCE-DETECTED, NOT ALWAYS-ON  (decision on card #139, admin approved)
#
# The certificate lives on a hardware token (EV/OV rules since 2023 - the key is not exportable).
# When the token is absent this script SKIPS signing with a loud warning and exits 0, so a packaged
# build works on any machine. When the token is present it signs, so a release build on the machine
# that has it needs no flag and cannot be forgotten.
#
# Why: `tauri build` is the only way to produce an installer to test, and `tauri dev` never signs at
# all (signCommand lives under `bundle`, so it is consulted only when packaging). Because
# tauri.windows.conf.json is tracked, requiring the token made EVERY packaged build on a machine
# without it fail - and fail as "failed to run powershell", which names the wrong thing entirely.
#
# The risk this trades against is shipping an unsigned installer believing it signed. Three guards:
#   1. the NOT SIGNED banner below goes to stderr, so it lands in the build output;
#   2. sign/verify-windows.ps1 is the real gate before shipping - it checks both installers AND the
#      programs inside the MSI, and exits non-zero if anything is unsigned;
#   3. ALT_SIGN_REQUIRE=1 turns a missing certificate into a hard failure, for a release script or
#      CI that wants the guarantee rather than the convenience.
#
# ASCII only, deliberately: Windows PowerShell 5.1 reads a BOM-less UTF-8 file as ANSI, so a
# non-ASCII character inside a string literal becomes mojibake and fails to PARSE.
param([Parameter(Mandatory = $true)][string]$File)

$ErrorActionPreference = "Stop"

$thumb = "B8AE16C08756AF6ADE5D7732AA395B8090D98BD6"
# Timestamping is independent of the issuing CA, but using GlobalSign's keeps the chain of custody
# obvious. A signature without a timestamp dies with the certificate.
$tsa = "http://timestamp.globalsign.com/tsa/r6advanced1"
$log = Join-Path $env:TEMP "alt-lore-signing.log"

function Test-SigningCert {
  # Both stores: the token's certificate normally appears under CurrentUser when plugged and
  # unlocked, but a machine-installed certificate would be under LocalMachine.
  #
  # HasPrivateKey is the part that matters. The certificate can sit in the store while the token
  # holding its key is unplugged, in which case signtool fails only at the moment of signing -
  # which is the failure this check exists to pre-empt.
  foreach ($store in "Cert:\CurrentUser\My", "Cert:\LocalMachine\My") {
    $c = Get-ChildItem $store -ErrorAction SilentlyContinue |
         Where-Object { $_.Thumbprint -eq $thumb -and $_.HasPrivateKey }
    if ($c) { return $true }
  }
  return $false
}

if (-not (Test-SigningCert)) {
  $why = "signing certificate $thumb not available (token unplugged, or not on this machine)"
  $name = [System.IO.Path]::GetFileName($File)

  if ($env:ALT_SIGN_REQUIRE -eq "1") {
    "[$(Get-Date -Format o)] FATAL: ALT_SIGN_REQUIRE=1 but $why - refusing to skip: $File" | Add-Content $log
    [Console]::Error.WriteLine("*** SIGNING REQUIRED but $why")
    exit 1
  }

  "[$(Get-Date -Format o)] SKIPPED (no certificate): $File" | Add-Content $log
  # stderr, so it reaches the build output rather than only the log.
  [Console]::Error.WriteLine("*** NOT SIGNED: $name - $why")
  [Console]::Error.WriteLine("***   This bundle is UNSIGNED. Fine for dev/test; do not ship it.")
  [Console]::Error.WriteLine("***   Plug the token in to sign, or set ALT_SIGN_REQUIRE=1 to fail instead of skipping.")
  [Console]::Error.WriteLine("***   Before shipping, run: sign\verify-windows.ps1")
  exit 0
}

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
# Recorded because Tauri's working directory for signCommand is undocumented, and getting it wrong
# is silent: a relative script path fails before this script runs at all, and Tauri reports only
# "failed to run powershell" with nothing from PowerShell itself.
"    cwd: $((Get-Location).Path)" | Add-Content $log

$out = & $signtool.FullName sign /v /fd sha256 /sha1 $thumb /tr $tsa /td sha256 $File 2>&1
$code = $LASTEXITCODE

$out | ForEach-Object { "    $_" } | Add-Content $log
"[$(Get-Date -Format o)] exit=$code" | Add-Content $log

if ($code -ne 0) {
  # Surface it on stderr too: Tauri reports only "failed to run signtool", so without this the
  # reason never reaches the build output.
  $out | ForEach-Object { Write-Error $_ }
}
exit $code
