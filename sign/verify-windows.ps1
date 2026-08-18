# verify-windows.ps1 - prove the Windows release is signed, payload included.
#
# Run this before shipping. It checks the two installers AND extracts the MSI to check the
# programs inside, because those are different questions: an installer can verify perfectly
# while carrying unsigned executables, which is the failure mode worth catching (SmartScreen
# judges the installer; AV heuristics and anyone who extracts it judge the contents).
#
# It exists as a script rather than a paragraph in the runbook for one specific reason.
# `target\release\alt-p2p-lore-ui.exe` reads NotSigned after a successful signed build - Tauri
# modifies that file about a minute after signing it, once the installers are built. The copies
# inside the installers are correctly signed. So the obvious thing to check is the one thing
# that lies, and a check that runs beats a warning that has to be remembered.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File sign\verify-windows.ps1
#
# Exit code is 0 only if every artifact below is Valid.
#
# ASCII only, deliberately. Windows PowerShell 5.1 reads a UTF-8 file with no BOM as ANSI, so a
# non-ASCII character inside a string literal becomes mojibake and fails to PARSE - which is how
# the first version of this file died.

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$rel  = Join-Path $repo "src-tauri\target\release"
$msi  = Get-ChildItem (Join-Path $rel "bundle\msi")  -Filter *.msi -ErrorAction SilentlyContinue | Select-Object -First 1
$nsis = Get-ChildItem (Join-Path $rel "bundle\nsis") -Filter *setup.exe -ErrorAction SilentlyContinue | Select-Object -First 1

$signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1

$script:bad = 0

function Show($label, $path) {
  if (-not $path -or -not (Test-Path $path)) {
    Write-Output ("  {0,-24} MISSING" -f $label); $script:bad++; return
  }
  $s = Get-AuthenticodeSignature $path
  $who = if ($s.SignerCertificate) { (($s.SignerCertificate.Subject -split ',')[0] -replace 'CN=', '').Trim('"') } else { '-' }
  $ts  = if ($s.TimeStamperCertificate) { 'timestamped' } else { 'NO TIMESTAMP' }
  Write-Output ("  {0,-24} {1,-10} {2,-24} {3}" -f $label, $s.Status, $who, $ts)
  if ($s.Status -ne 'Valid') { $script:bad++ }
}

Write-Output "=== installers ==="
Show "MSI"         $(if ($msi)  { $msi.FullName })
Show "NSIS setup"  $(if ($nsis) { $nsis.FullName })

if ($signtool -and $msi) {
  Write-Output ""
  Write-Output "=== signtool verify /pa ==="
  foreach ($f in @($msi, $nsis)) {
    if (-not $f) { continue }
    $out = & $signtool.FullName verify /pa $f.FullName 2>&1
    if ($out | Select-String "Successfully verified") {
      Write-Output ("  OK   " + $f.Name)
    } else {
      Write-Output ("  FAIL " + $f.Name)
      $out | ForEach-Object { "       $_" }
      $script:bad++
    }
  }
}

# The part that matters most, and the part a wrapper-only check would miss.
if ($msi) {
  Write-Output ""
  Write-Output "=== programs INSIDE the MSI (extracted) ==="
  $out = Join-Path $env:TEMP "alt-lore-verify-extract"
  Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory $out | Out-Null
  # Administrative install unpacks without installing.
  #
  # Routed through cmd.exe deliberately. msiexec wants its own quoting, and PowerShell's
  # -ArgumentList array quotes arguments in a way it rejects with 1639 ("invalid command line")
  # and no further explanation - measured, both forms, same machine. The product name contains
  # a space, so the quotes cannot simply be dropped.
  $cmd = 'msiexec /a "{0}" /qn TARGETDIR="{1}"' -f $msi.FullName, $out
  $p = Start-Process cmd.exe -ArgumentList @("/c", $cmd) -Wait -PassThru
  if ($p.ExitCode -ne 0) {
    Write-Output ("  could not extract (msiexec exit {0}) - payload UNVERIFIED" -f $p.ExitCode)
    $script:bad++
  } else {
    $app = Join-Path $out "PFiles\alt-lore Desktop"
    foreach ($n in "alt-p2p-lore-ui.exe", "run-java.exe", "lore.exe") { Show $n (Join-Path $app $n) }

    # Signed is not the same as runnable.
    #
    # A correctly signed run-java.exe once shipped importing VCRUNTIME140.dll - part of the
    # Visual C++ Redistributable, which every developer machine has and a fresh Windows 11
    # does not. The installed app died on "VCRUNTIME140.dll was not found", and since
    # run-java is what prereq.rs probes, it surfaced as two unrelated-looking failures.
    # Nothing in a signature check would ever have caught it.
    #
    # The Universal CRT (api-ms-win-crt-*) is fine: it is part of Windows 10 and 11.
    Write-Output ""
    Write-Output "=== redistributable dependencies (must be none) ==="
    $dumpbin = Get-ChildItem "C:\Program Files\Microsoft Visual Studio" -Recurse -Filter dumpbin.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\Hostx64\\x64\\' } | Select-Object -First 1
    if (-not $dumpbin) {
      Write-Output "  dumpbin not found - dependency check SKIPPED (install VS Build Tools to enable)"
    } else {
      foreach ($n in "alt-p2p-lore-ui.exe", "run-java.exe", "lore.exe") {
        $p = Join-Path $app $n
        if (-not (Test-Path $p)) { continue }
        $deps = & $dumpbin.FullName /dependents $p 2>$null
        $needs = $deps | Select-String -Pattern 'VCRUNTIME|MSVCP\d|MSVCR\d' | ForEach-Object { $_.ToString().Trim() }
        if ($needs) {
          Write-Output ("  {0,-24} NEEDS REDIST: {1}" -f $n, ($needs -join ', '))
          $script:bad++
        } else {
          Write-Output ("  {0,-24} clean" -f $n)
        }
      }
    }
  }
}

Write-Output ""
if ($script:bad -eq 0) {
  Write-Output "ALL SIGNED AND VALID"
  exit 0
}
Write-Output ("{0} problem(s) found" -f $script:bad)
exit 1
