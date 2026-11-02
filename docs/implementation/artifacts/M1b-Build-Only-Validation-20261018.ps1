[CmdletBinding()]
param([switch]$Execute, [switch]$OwnerApprovedBuildOnly, [switch]$PreflightOnly, [switch]$ResumeExisting)

# Preview is read-only. The owner executes npm-consuming Docker builds.
# No push, Git tag, pipeline, port publication, cluster or database command.
$ErrorActionPreference = 'Stop'
if ($Execute -and $PreflightOnly) { throw 'Choose execution or read-only preflight, not both' }
$m1bRoot = 'C:\Users\User\AppData\Local\Temp\VYNVORI-M1b-20261018'
$m1bOutput = Join-Path $m1bRoot 'private-image-validation'
$m1bProbe = Join-Path $PSScriptRoot 'M1b-Image-Runtime-Probe-20261018.cjs'
$m1bNativeHelper = Join-Path $PSScriptRoot 'M1b-Native-Process-20261019.ps1'
$m1bReviewPath = Join-Path (Join-Path (Split-Path $PSScriptRoot) 'evidence') 'M1b-Build-Only-Preparation-20261018.json'
$m1bReview = Get-Content -LiteralPath $m1bReviewPath -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $m1bReview.scriptSha256 -or (Get-FileHash -LiteralPath $m1bProbe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $m1bReview.probeSha256) { throw 'Build/probe artifact differs from review receipt' }
if ((Get-FileHash -LiteralPath $m1bNativeHelper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $m1bReview.nativeHelperSha256) { throw 'Native process helper differs from review receipt' }
. $m1bNativeHelper
$m1bTargets = @(
  @{ Name='Portal'; Tree=(Join-Path $m1bRoot 'portal-merged-35a47c9d'); Commit='35a47c9d6d7b41adbed5cc6556a4e9bbe78269ba'; ResultTree='fd4a59e3cb7cd03b280999b1294e5115d849e6ef'; Npmrc='D:\dev\raum\tcm\Portal.Service\.npmrc'; Image='vynvori-m1b-portal-review:35a47c9d' },
  @{ Name='Core'; Tree=(Join-Path $m1bRoot 'core-merged-30efb9e2'); Commit='30efb9e295ccdf4e6a51c3c3d8d2b05c6494381f'; ResultTree='445e642773a2f5fbe1acb087b89cc428db0395d0'; Npmrc='D:\dev\raum\tcm\service.core-ui\.npmrc'; Image='vynvori-m1b-core-review:30efb9e2' }
)

function Assert-M1bBuildSource($m1bTarget) {
  $m1bTree = [IO.Path]::GetFullPath($m1bTarget.Tree)
  if (-not $m1bTree.StartsWith($m1bRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Source escaped task directory' }
  $m1bSafe = 'safe.directory=' + $m1bTree.Replace('\','/')
  $m1bHead = & git -c $m1bSafe -C $m1bTree rev-parse HEAD
  if ($LASTEXITCODE -ne 0 -or $m1bHead -ne $m1bTarget.Commit) { throw 'Unexpected merged source SHA' }
  $m1bGitTree = & git -c $m1bSafe -C $m1bTree rev-parse 'HEAD^{tree}'
  if ($LASTEXITCODE -ne 0 -or $m1bGitTree -ne $m1bTarget.ResultTree) { throw 'Unexpected merged source tree' }
  $m1bChanges = @(& git -c $m1bSafe -C $m1bTree status --porcelain --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $m1bChanges.Count) { throw 'Build source is not clean' }
  $m1bIgnored = @(& git -c $m1bSafe -C $m1bTree ls-files --others --ignored --exclude-standard)
  if ($LASTEXITCODE -ne 0 -or $m1bIgnored.Count) { throw 'Unexpected ignored files in detached build context' }
  if (-not (Test-Path -LiteralPath $m1bTarget.Npmrc)) { throw 'Existing private npm configuration unavailable; do not send it in chat' }
  $m1bIgnore = [IO.File]::ReadAllLines((Join-Path $m1bTree '.dockerignore'))
  if ($m1bIgnore -notcontains '.npmrc' -or $m1bIgnore -notcontains '.git' -or $m1bIgnore -notcontains 'node_modules') { throw 'Required context exclusions missing' }
  $m1bDockerfile = [IO.File]::ReadAllText((Join-Path $m1bTree 'Dockerfile'))
  if (-not $m1bDockerfile.Contains('node:20.17.0-')) { throw 'Image runtime changed; review required' }
  if ($m1bTarget.Name -eq 'Core' -and $m1bDockerfile.Contains('cat ".env.')) { throw 'Unsafe environment-file logging remains' }
  if ($m1bTarget.Name -eq 'Core' -and -not (Test-Path -LiteralPath (Join-Path $m1bTree '.env.development'))) { throw 'Expected existing development build configuration missing' }
}

function Assert-M1bLocalBuilderText([string]$m1bText) {
  # Inspect output is used because this installed Buildx has no --format option.
  # Require exactly one Docker-driver node on the already verified local context.
  $m1bDrivers = [regex]::Matches($m1bText, '(?m)^Driver:[ \t]+([^ \t\r\n]+)[ \t]*\r?$')
  $m1bEndpoints = [regex]::Matches($m1bText, '(?m)^Endpoint:[ \t]+([^ \t\r\n]+)[ \t]*\r?$')
  if ($m1bDrivers.Count -ne 1 -or $m1bDrivers[0].Groups[1].Value -cne 'docker' -or $m1bEndpoints.Count -ne 1 -or $m1bEndpoints[0].Groups[1].Value -cne 'default') { throw 'Only one existing Docker-driver node on the verified default local context is approved' }
}

function Get-M1bExistingImage($m1bTarget) {
  if (-not (Test-Path -LiteralPath $m1bOutput)) { return $null }
  $m1bFiles = @(Get-ChildItem -LiteralPath $m1bOutput -File -Recurse -Filter ($m1bTarget.Name + '-image.id'))
  if (-not $m1bFiles.Count) { return $null }
  $m1bIds = @($m1bFiles | ForEach-Object {
    if (-not [IO.Path]::GetFullPath($_.FullName).StartsWith($m1bOutput + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Image evidence escaped task output directory' }
    $m1bId = ([IO.File]::ReadAllText($_.FullName)).Trim()
    if ($m1bId -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Prior image evidence is malformed' }
    $m1bId
  } | Sort-Object -Unique)
  if ($m1bIds.Count -ne 1) { throw 'Conflicting prior image IDs require review; no rebuild or overwrite allowed' }
  $m1bAliasId = (& docker.exe --context default image inspect --format '{{.Id}}' $m1bTarget.Image 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $m1bAliasId -ne $m1bIds[0]) { throw 'Prior immutable image and local tag differ; review required' }
  $m1bLabelsText = & docker.exe --context default image inspect --format '{{json .Config.Labels}}' $m1bIds[0] 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'Prior image revision label cannot be inspected' }
  $m1bLabels = ($m1bLabelsText -join "`n") | ConvertFrom-Json
  if ($m1bLabels.'org.opencontainers.image.revision' -ne $m1bTarget.Commit) { throw 'Prior image revision differs from approved source' }
  return [pscustomobject]@{ Id=$m1bIds[0]; Source=$m1bTarget.Commit; EvidenceFiles=$m1bFiles.Count }
}

if (-not (Test-Path -LiteralPath $m1bProbe)) { throw 'Reviewed runtime probe missing' }
foreach ($m1bTarget in $m1bTargets) {
  Assert-M1bBuildSource $m1bTarget
  [pscustomobject]@{ component=$m1bTarget.Name; source=$m1bTarget.Commit; sourceTree=$m1bTarget.ResultTree; context=$m1bTarget.Tree; localImageOnly=$m1bTarget.Image; developmentConfigPreserved=$true; privateNpmConfig='Existing file via BuildKit secret only; contents never printed'; imagePush=$false; networkDisabledForProbe=$true; execute=[bool]$Execute }
}
if (-not $Execute -and -not $PreflightOnly) {
  Write-Output 'PREVIEW ONLY. Builds are not authorized by preparing this script. Do not execute until the separate build-only batch is approved.'
  return
}
if ($Execute -and -not $OwnerApprovedBuildOnly) { throw 'Explicit owner-approved build-only acknowledgement required' }
if ($Execute -and $m1bReview.ownerApproval -ne 'APPROVED_LOCAL_BUILD_ONLY') { throw 'Separate build-only approval is not recorded; no Docker action allowed' }
if ($env:DOCKER_HOST) { throw 'DOCKER_HOST override present; review local-engine selection before building' }
if ($env:BUILDX_BUILDER -and $env:BUILDX_BUILDER -ne 'default') { throw 'Non-default builder override present; no remote build is authorized' }
Get-Command docker.exe -ErrorAction Stop | Out-Null
$m1bContextText = & docker.exe context inspect default 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Local Docker default context unavailable; no setup or installation attempted' }
$m1bContext = @(($m1bContextText -join "`n") | ConvertFrom-Json)[0]
$m1bEndpoint = $m1bContext.Endpoints.docker.Host
if ($m1bEndpoint -notmatch '^npipe:////\./pipe/' -and $m1bEndpoint -notmatch '^unix:///') { throw 'Default Docker context is not a verified local engine' }
$m1bOs = & docker.exe --context default info --format '{{.OSType}}' 2>$null
if ($LASTEXITCODE -ne 0 -or $m1bOs -ne 'linux') { throw 'Running local Linux Docker engine required; no service changes attempted' }
$m1bBuilderText = & docker.exe --context default buildx inspect default 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Existing default builder inspection failed; no builder will be created' }
Assert-M1bLocalBuilderText ($m1bBuilderText -join "`n")
$m1bBuildHelp = & docker.exe --context default build --help 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Installed Docker build command cannot be inspected' }
foreach ($m1bFlag in @('--builder','--secret','--iidfile','--progress','--label')) {
  if (($m1bBuildHelp -join "`n") -notmatch ([regex]::Escape($m1bFlag) + '\b')) { throw ('Installed Docker build command lacks required option ' + $m1bFlag) }
}
if ($PreflightOnly) {
  if ($ResumeExisting) {
    if (-not (Test-Path -LiteralPath $m1bOutput)) { throw 'No existing output directory to resume' }
    foreach ($m1bTarget in $m1bTargets) {
      $m1bExisting = Get-M1bExistingImage $m1bTarget
      Write-Output ('Resume preflight ' + $m1bTarget.Name + ': ' + $(if ($m1bExisting) { 'verified prior image available; will not rebuild' } else { 'no prior image evidence; owner build required' }))
    }
  }
  Write-Output 'PASS_READ_ONLY_PREFLIGHT: reviewed sources, local Linux default context, Docker-driver builder and required build options verified. No image build, probe, directory creation or installation performed.'
  return
}
$m1bWorkers = @(Get-CimInstance Win32_Process -Filter "Name = 'docker.exe' OR Name = 'docker-buildx.exe'" | Where-Object { $_.CommandLine -match 'portal-merged-35a47c9d|core-merged-30efb9e2|m1b-probe\.cjs' })
if ($m1bWorkers.Count) { throw 'A matching build/probe worker is still live; do not start another' }
if (Test-Path -LiteralPath $m1bOutput) {
  if (-not $ResumeExisting) { throw 'Prior private evidence exists; use reviewed -ResumeExisting recovery, never delete it' }
  $m1bAttempt = Join-Path $m1bOutput ('resume-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $m1bAttempt | Out-Null
  $m1bPreviousReceipt = Join-Path $m1bOutput 'owner-build-receipt.json'
  if (Test-Path -LiteralPath $m1bPreviousReceipt) {
    $m1bSavedReceipt = Join-Path $m1bAttempt 'prior-owner-build-receipt.json'
    Copy-Item -LiteralPath $m1bPreviousReceipt -Destination $m1bSavedReceipt
    if ((Get-FileHash -LiteralPath $m1bPreviousReceipt).Hash -ne (Get-FileHash -LiteralPath $m1bSavedReceipt).Hash) { throw 'Prior receipt preservation failed' }
  }
} else {
  if ($ResumeExisting) { throw 'No existing output directory to resume' }
  New-Item -ItemType Directory -Path $m1bOutput | Out-Null
  $m1bAttempt = $m1bOutput
}
$m1bDocker = (Get-Command docker.exe).Source
$m1bResults = @()
$m1bPreviousBuildkit = $env:DOCKER_BUILDKIT
try {
  $env:DOCKER_BUILDKIT = '1'
  foreach ($m1bTarget in $m1bTargets) {
    Assert-M1bBuildSource $m1bTarget
    $m1bLog = Join-Path $m1bAttempt ($m1bTarget.Name + '-build.log')
    $m1bImageFile = Join-Path $m1bAttempt ($m1bTarget.Name + '-image.id')
    $m1bBuildArgs = @('--context','default','build','--builder','default','--progress','plain','--secret',('id=npmrc,src=' + $m1bTarget.Npmrc),'--label',('org.opencontainers.image.revision=' + $m1bTarget.Commit),'--iidfile',$m1bImageFile,'--tag',$m1bTarget.Image,'--file',(Join-Path $m1bTarget.Tree 'Dockerfile'))
    if ($m1bTarget.Name -eq 'Core') { $m1bBuildArgs += @('--build-arg','NODE_ENV=development') }
    $m1bBuildArgs += $m1bTarget.Tree
    $m1bExisting = $(if ($ResumeExisting) { Get-M1bExistingImage $m1bTarget } else { $null })
    $m1bReused = [bool]$m1bExisting
    if ($m1bReused) {
      Write-Host ('[' + $m1bTarget.Name + '] reusing verified existing image; no rebuild.')
      [IO.File]::WriteAllText($m1bImageFile, $m1bExisting.Id + "`n", [Text.UTF8Encoding]::new($false))
      $m1bBuildExit = 'NOT_CAPTURED_PRIOR_RUNNER_STDERR_EXCEPTION'
    } else {
      $m1bNative = Invoke-M1bNativeProcess -FilePath $m1bDocker -ArgumentList $m1bBuildArgs -LogPath $m1bLog -Stage ($m1bTarget.Name + ' image build')
      $m1bBuildExit = $m1bNative.ExitCode
      if ($m1bBuildExit -ne 0) { throw ('Image build failed for ' + $m1bTarget.Name + ' (exit ' + $m1bBuildExit + '); keep raw logs private and report only nonsecret error details') }
    }
    Assert-M1bBuildSource $m1bTarget
    $m1bVerifiedImage = Get-M1bExistingImage $m1bTarget
    if (-not $m1bVerifiedImage) { throw 'Built image evidence missing' }
    $m1bProbeLog = Join-Path $m1bAttempt ($m1bTarget.Name + '-probe.log')
    $m1bEntrypoint = $(if ($m1bTarget.Name -eq 'Portal') { 'tsx' } else { 'node' })
    $m1bRunArgs = @('--context','default','run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--tmpfs','/tmp:rw,nosuid,nodev,size=67108864','--mount',('type=bind,source=' + $m1bProbe + ',target=/m1b-probe.cjs,readonly'),'--env','PORTAL_STRICT_OAUTH_ENABLED=false','--env','CORE_STRICT_OAUTH_CLIENT_IDS=[]','--env','NODE_ENV=production','--entrypoint',$m1bEntrypoint,$m1bTarget.Image)
    $m1bRunArgs += @('/m1b-probe.cjs',$m1bTarget.Name)
    $m1bProbeNative = Invoke-M1bNativeProcess -FilePath $m1bDocker -ArgumentList $m1bRunArgs -LogPath $m1bProbeLog -Stage ($m1bTarget.Name + ' image probe')
    if ($m1bProbeNative.ExitCode -ne 0) { throw ('Runtime probe failed for ' + $m1bTarget.Name + ' (exit ' + $m1bProbeNative.ExitCode + '); no activation allowed') }
    $m1bProbeResult = (Get-Content -LiteralPath $m1bProbeLog | Select-Object -Last 1) | ConvertFrom-Json
    if ($m1bProbeResult.status -ne 'PASS_IMAGE_PROBE_ONLY' -or $m1bProbeResult.role -ne $m1bTarget.Name -or $m1bProbeResult.node -ne 'v20.17.0') { throw 'Unexpected image probe result' }
    $m1bImageId = ([IO.File]::ReadAllText($m1bImageFile)).Trim()
    if ($m1bImageId -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Invalid immutable local image ID' }
    $m1bResults += [ordered]@{ component=$m1bTarget.Name; source=$m1bTarget.Commit; tree=$m1bTarget.ResultTree; localImage=$m1bTarget.Image; localImageId=$m1bImageId; reusedVerifiedPriorImage=$m1bReused; buildExit=$m1bBuildExit; imageAliasAndRevisionVerified=$true; probe=$m1bProbeResult; logSha256=$(if ($m1bReused) { $null } else { (Get-FileHash -LiteralPath $m1bLog -Algorithm SHA256).Hash.ToLowerInvariant() }); buildStderrSha256=$(if ($m1bReused) { $null } else { (Get-FileHash -LiteralPath ($m1bLog + '.stderr') -Algorithm SHA256).Hash.ToLowerInvariant() }); probeSha256=(Get-FileHash -LiteralPath $m1bProbeLog -Algorithm SHA256).Hash.ToLowerInvariant(); probeStderrSha256=(Get-FileHash -LiteralPath ($m1bProbeLog + '.stderr') -Algorithm SHA256).Hash.ToLowerInvariant(); sourceUnchanged=$true }
    $m1bReceiptText = [ordered]@{ scope='OWNER_LOCAL_BUILD_AND_SYNTHETIC_IMAGE_PROBE_ONLY'; attempt=$m1bAttempt; results=$m1bResults; imagePush=$false; gitTag=$false; publicPort=$false; deployment=$false; databaseMutation=$false; acceptance='NOT_M1B_OR_FULL_APPLICATION_ACCEPTANCE' } | ConvertTo-Json -Depth 15
    [IO.File]::WriteAllText((Join-Path $m1bAttempt ('owner-build-receipt-' + $m1bTarget.Name + '.json')), $m1bReceiptText, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $m1bOutput 'owner-build-receipt.json'), $m1bReceiptText, [Text.UTF8Encoding]::new($false))
  }
} finally {
  if ($null -eq $m1bPreviousBuildkit) { Remove-Item Env:\DOCKER_BUILDKIT -ErrorAction SilentlyContinue }
  else { $env:DOCKER_BUILDKIT = $m1bPreviousBuildkit }
}
Write-Output ('Build/probe receipt only: ' + (Join-Path $m1bOutput 'owner-build-receipt.json'))
Write-Output 'Keep images and raw build logs private. No push, tag, deployment, registration or M1b acceptance was performed.'
