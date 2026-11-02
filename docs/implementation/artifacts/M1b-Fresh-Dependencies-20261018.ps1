[CmdletBinding()]
param([switch]$Execute)

# Owner-run only: D:\dev\raum\tcm\AGENTS.md delegates npm installation to the user.
# Preview is read-only. Execute changes dependencies only in the two isolated trees.
$ErrorActionPreference = 'Stop'
$m1bRoot = 'C:\Users\User\AppData\Local\Temp\VYNVORI-M1b-20261018'
$m1bEvidence = Join-Path (Split-Path $PSScriptRoot) 'evidence'
$m1bTargets = @(
  @{ Name='Portal'; Tree=(Join-Path $m1bRoot 'portal-release-e54028d0'); Original='D:\dev\raum\tcm\Portal.Service'; Receipt='M1b-Portal-Release-Candidate-20261018.json' },
  @{ Name='Core'; Tree=(Join-Path $m1bRoot 'core-release-2c7f0113'); Original='D:\dev\raum\tcm\service.core-ui'; Receipt='M1b-Core-Proxy-Candidate-20261018.json' }
)

function Assert-M1bLockfile($m1bLockPath) {
  # Pass a script file, not JavaScript source through native argument quoting.
  # Node also preserves npm's empty root-package key on Windows PowerShell 5.1.
  & node (Join-Path $PSScriptRoot 'M1b-Validate-Lockfile-20261018.cjs') $m1bLockPath
  if ($LASTEXITCODE -eq 2) { throw 'Local dependency links require separate review before installation' }
  if ($LASTEXITCODE -ne 0) { throw 'Invalid or unreadable package-lock.json; installation has not started' }
}

function Assert-M1bSources($m1bTarget, $m1bReceipt) {
  $m1bTree = [IO.Path]::GetFullPath($m1bTarget.Tree).TrimEnd('\')
  $m1bAllowedRoot = [IO.Path]::GetFullPath($m1bRoot).TrimEnd('\') + '\'
  if (-not $m1bTree.StartsWith($m1bAllowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate tree escaped the explicit task directory' }
  if (-not (Test-Path -LiteralPath (Join-Path $m1bTree '.git'))) { throw 'Expected registered candidate worktree is missing' }
  $m1bSafe = 'safe.directory=' + $m1bTree.Replace('\','/')
  $m1bHead = & git -c $m1bSafe -C $m1bTree rev-parse HEAD
  $m1bExpectedHeads = @($m1bReceipt.releaseSource)
  if ($m1bReceipt.sourcePublication.commit -match '^[a-f0-9]{40}$') { $m1bExpectedHeads += $m1bReceipt.sourcePublication.commit }
  if ($LASTEXITCODE -ne 0 -or $m1bHead -notin $m1bExpectedHeads) { throw ('Unexpected reviewed source: ' + $m1bTarget.Name) }
  Assert-M1bLockfile (Join-Path $m1bTree 'package-lock.json')
  foreach ($m1bFile in @($m1bReceipt.candidateFiles) + @($m1bReceipt.manifestFiles)) {
    if ([IO.Path]::IsPathRooted($m1bFile.path)) { throw 'Receipt must use relative source paths' }
    $m1bFilePath = [IO.Path]::GetFullPath((Join-Path $m1bTree $m1bFile.path))
    if (-not $m1bFilePath.StartsWith($m1bTree + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Receipt path escaped candidate tree' }
    if ((Get-FileHash -LiteralPath $m1bFilePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $m1bFile.sha256) { throw ('Candidate changed since review: ' + $m1bFile.path) }
  }
}

function Get-M1bDependencyLink($m1bTarget) {
  $m1bModulesPath = Join-Path $m1bTarget.Tree 'node_modules'
  $m1bModules = Get-Item -LiteralPath $m1bModulesPath -Force -ErrorAction SilentlyContinue
  if (-not $m1bModules) { return $null }
  if (($m1bModules.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { return $null }
  $m1bLinks = @($m1bModules.Target)
  $m1bExpected = [IO.Path]::GetFullPath((Join-Path $m1bTarget.Original 'node_modules')).TrimEnd('\')
  if ($m1bModules.LinkType -ne 'Junction' -or $m1bLinks.Count -ne 1 -or [IO.Path]::GetFullPath([string]$m1bLinks[0]).TrimEnd('\') -ne $m1bExpected) { throw 'Unexpected dependency link; refusing removal' }
  return $m1bModules
}

$m1bNodeVersion = (& node --version).Trim()
if ($LASTEXITCODE -ne 0 -or [version]$m1bNodeVersion.TrimStart('v') -lt [version]'22.23.0' -or ([version]$m1bNodeVersion.TrimStart('v')).Major -ne 22) { throw 'Use the approved Node 22 runtime (at least 22.23.0)' }
$m1bNpmVersion = (& npm.cmd --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'npm.cmd is required' }

foreach ($m1bTarget in $m1bTargets) {
  $m1bReceipt = Get-Content -LiteralPath (Join-Path $m1bEvidence $m1bTarget.Receipt) -Raw | ConvertFrom-Json
  Assert-M1bSources $m1bTarget $m1bReceipt
  $m1bLink = Get-M1bDependencyLink $m1bTarget
  [pscustomobject]@{ target=$m1bTarget.Name; candidate=$m1bTarget.Tree; dependencyJunction=[bool]$m1bLink; originalDependenciesPreserved=(Join-Path $m1bTarget.Original 'node_modules'); plannedAction='npm ci in isolated candidate only'; execute=[bool]$Execute }
}
if (-not $Execute) {
  Write-Output 'Preview only. Re-run this same script with -Execute to perform the delegated fresh installations.'
  return
}

$m1bResults = @()
$m1bPreviousMongoPostinstall = $env:MONGOMS_DISABLE_POSTINSTALL
try {
  $env:MONGOMS_DISABLE_POSTINSTALL = '1'
  foreach ($m1bTarget in $m1bTargets) {
    $m1bReceipt = Get-Content -LiteralPath (Join-Path $m1bEvidence $m1bTarget.Receipt) -Raw | ConvertFrom-Json
    Assert-M1bSources $m1bTarget $m1bReceipt
    $m1bLink = Get-M1bDependencyLink $m1bTarget
    if ($m1bLink) {
      # Delete the verified junction entry only: no recursive delete and no target deletion.
      [IO.Directory]::Delete($m1bLink.FullName)
      if (-not (Test-Path -LiteralPath (Join-Path $m1bTarget.Original 'node_modules'))) { throw 'Original dependency target missing' }
    }
    Push-Location -LiteralPath $m1bTarget.Tree
    try {
      $m1bNpmrc = Join-Path $m1bTarget.Original '.npmrc'
      if (Test-Path -LiteralPath $m1bNpmrc) { & npm.cmd ci --userconfig $m1bNpmrc }
      else { & npm.cmd ci }
      $m1bInstallExit = $LASTEXITCODE
    } finally { Pop-Location }
    if ($m1bInstallExit -eq 0) { Assert-M1bSources $m1bTarget $m1bReceipt }
    $m1bInstalled = Get-Item -LiteralPath (Join-Path $m1bTarget.Tree 'node_modules') -Force -ErrorAction SilentlyContinue
    $m1bIsIndependent = $m1bInstalled -and (($m1bInstalled.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
    $m1bResults += [ordered]@{ target=$m1bTarget.Name; source=$m1bReceipt.releaseSource; path=$m1bTarget.Tree; npmCiExit=$m1bInstallExit; independentNodeModules=[bool]$m1bIsIndependent; sourceAndLocksUnchanged=($m1bInstallExit -eq 0); status= $(if($m1bInstallExit -eq 0 -and $m1bIsIndependent){'PASS_INSTALL_ONLY'}else{'FAILED'}) }
    [ordered]@{ node=$m1bNodeVersion; npm=$m1bNpmVersion; results=$m1bResults; note='Install receipt only; no tests, migration, registration, tag, push or deployment'; } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $m1bRoot 'fresh-install-owner-receipt.json') -Encoding utf8
    if ($m1bInstallExit -ne 0 -or -not $m1bIsIndependent) { throw ('Fresh install failed for ' + $m1bTarget.Name + '; report the nonsecret error code, not credentials') }
  }
} finally {
  if ($m1bPreviousMongoPostinstall -eq $null) { Remove-Item Env:\MONGOMS_DISABLE_POSTINSTALL -ErrorAction SilentlyContinue }
  else { $env:MONGOMS_DISABLE_POSTINSTALL = $m1bPreviousMongoPostinstall }
}
Write-Output ('Fresh installation receipt: ' + (Join-Path $m1bRoot 'fresh-install-owner-receipt.json'))
