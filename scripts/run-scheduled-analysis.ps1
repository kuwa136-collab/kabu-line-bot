$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source

Write-Host "[scheduled] start analyze $(Get-Date -Format s)"
& $npm run analyze
$exitCode = $LASTEXITCODE
Write-Host "[scheduled] done analyze exit=$exitCode $(Get-Date -Format s)"

exit $exitCode
