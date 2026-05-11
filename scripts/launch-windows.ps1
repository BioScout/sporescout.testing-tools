param(
  [switch]$Dev,
  [switch]$DryRun,
  [switch]$VerifyDownloadAvailability,
  [switch]$NoDownload,
  [string]$ManifestPath
)

$ErrorActionPreference = 'Stop'

function Resolve-Root {
  $scriptDir = Split-Path -Parent $PSCommandPath
  return (Resolve-Path -LiteralPath (Join-Path $scriptDir '..')).Path
}

function Read-Manifest {
  param([string]$Root, [string]$Path)

  $resolvedPath = if ($Path) { $Path } else { Join-Path $Root 'launch.windows.json' }
  if (!(Test-Path -LiteralPath $resolvedPath)) {
    throw "Launch manifest not found: $resolvedPath"
  }

  return Get-Content -LiteralPath $resolvedPath -Raw | ConvertFrom-Json
}

function Convert-ToNativePath {
  param([string]$Root, [string]$RelativePath)

  $parts = $RelativePath -split '/'
  $nativeRelativePath = [string]::Join([IO.Path]::DirectorySeparatorChar, $parts)
  return Join-Path $Root $nativeRelativePath
}

function Find-PortableApp {
  param([string]$Root, $Manifest)

  foreach ($candidate in $Manifest.portableCandidates) {
    $nativeCandidate = Convert-ToNativePath -Root $Root -RelativePath $candidate
    $matches = @(Get-ChildItem -Path $nativeCandidate -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    if ($matches.Count -gt 0) {
      return $matches[0]
    }
  }

  return $null
}

function Find-BundledNode {
  param([string]$Root, $Manifest)

  if ($env:SPORESCOUT_NODE_EXE -and (Test-Path -LiteralPath $env:SPORESCOUT_NODE_EXE)) {
    return (Get-Item -LiteralPath $env:SPORESCOUT_NODE_EXE)
  }

  foreach ($candidate in $Manifest.sourceFallback.nodeCandidates) {
    $nativeCandidate = Convert-ToNativePath -Root $Root -RelativePath $candidate
    if (Test-Path -LiteralPath $nativeCandidate) {
      return (Get-Item -LiteralPath $nativeCandidate)
    }
  }

  return $null
}

function Copy-Hashtable {
  param([hashtable]$InputTable)

  $copy = @{}
  foreach ($key in $InputTable.Keys) {
    $copy[$key] = $InputTable[$key]
  }
  return $copy
}

function Get-EnvironmentValue {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return $null
  }

  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($Name, 'User')
  }
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [Environment]::GetEnvironmentVariable($Name, 'Machine')
  }

  if ([string]::IsNullOrWhiteSpace($value)) {
    return $null
  }

  return $value
}

function Get-GitHubHeaders {
  param($DownloadConfig)

  $headers = @{
    'Accept' = 'application/vnd.github+json'
    'User-Agent' = 'SporeScout-Testing-Tools-Launcher'
    'X-GitHub-Api-Version' = '2022-11-28'
  }

  foreach ($environmentName in @($DownloadConfig.tokenEnvironmentVariables)) {
    $token = Get-EnvironmentValue -Name $environmentName
    if ($token) {
      $headers['Authorization'] = "Bearer $token"
      return $headers
    }
  }

  if ($DownloadConfig.useGhAuth -ne $false -and (Get-Command gh -ErrorAction SilentlyContinue)) {
    try {
      $token = (& gh auth token 2>$null | Select-Object -First 1)
      if ($LASTEXITCODE -eq 0 -and ![string]::IsNullOrWhiteSpace($token)) {
        $headers['Authorization'] = "Bearer $($token.Trim())"
        return $headers
      }
    } catch {
      Write-Host "GitHub CLI auth lookup was unavailable; trying other credentials." -ForegroundColor Yellow
    }
  }

  if ($DownloadConfig.useGitCredentials -and (Get-Command git -ErrorAction SilentlyContinue)) {
    try {
      $credentialInput = "protocol=https`nhost=github.com`n`n"
      $credentialOutput = $credentialInput | git credential fill 2>$null
      if ($LASTEXITCODE -eq 0 -and $credentialOutput) {
        $credential = @{}
        foreach ($line in $credentialOutput) {
          $parts = $line -split '=', 2
          if ($parts.Count -eq 2) {
            $credential[$parts[0]] = $parts[1]
          }
        }

        if ($credential.username -and $credential.password) {
          $rawCredential = "$($credential.username):$($credential.password)"
          $encodedCredential = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($rawCredential))
          $headers['Authorization'] = "Basic $encodedCredential"
        }
      }
    } catch {
      Write-Host "Git credential lookup was unavailable; trying unauthenticated release access." -ForegroundColor Yellow
    }
  }

  return $headers
}

function Get-GitCheckoutInfo {
  param([string]$Root)

  if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    return $null
  }

  Push-Location -LiteralPath $Root
  try {
    $commit = (& git rev-parse HEAD 2>$null | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($commit)) {
      return $null
    }

    $branch = $null
    try {
      $branchOutput = (& git branch --show-current 2>$null | Select-Object -First 1)
      if (![string]::IsNullOrWhiteSpace($branchOutput)) {
        $branch = $branchOutput.Trim()
      }
    } catch {
      $branch = $null
    }

    $tag = $null
    try {
      $tagOutput = (& git describe --exact-match --tags HEAD 2>$null | Select-Object -First 1)
      if (![string]::IsNullOrWhiteSpace($tagOutput)) {
        $tag = $tagOutput.Trim()
      }
    } catch {
      $tag = $null
    }

    return [pscustomobject]@{
      Commit = $commit.Trim()
      ShortCommit = $commit.Trim().Substring(0, [Math]::Min(12, $commit.Trim().Length))
      Branch = $branch
      Tag = $tag
    }
  } finally {
    Pop-Location
  }
}

function Get-ReleaseByTagApi {
  param($DownloadConfig, [string]$Tag)

  if ($DownloadConfig.releaseByTagApiTemplate) {
    return [string]$DownloadConfig.releaseByTagApiTemplate -replace '\{tag\}', [Uri]::EscapeDataString($Tag)
  }

  return "https://api.github.com/repos/$($DownloadConfig.owner)/$($DownloadConfig.repo)/releases/tags/$([Uri]::EscapeDataString($Tag))"
}

function Get-WorkflowRunsApi {
  param($DownloadConfig, $CheckoutInfo)

  if ($DownloadConfig.workflowRunsApiTemplate) {
    return [string]$DownloadConfig.workflowRunsApiTemplate `
      -replace '\{commit\}', [Uri]::EscapeDataString($CheckoutInfo.Commit) `
      -replace '\{shortCommit\}', [Uri]::EscapeDataString($CheckoutInfo.ShortCommit)
  }

  return [string]$DownloadConfig.workflowRunsApi
}

function Find-ReleaseAsset {
  param($Release, $DownloadConfig)

  $assets = @($Release.assets)
  foreach ($pattern in @($DownloadConfig.assetPatterns)) {
    foreach ($asset in $assets) {
      if ($asset.name -like $pattern) {
        return $asset
      }
    }
  }

  return $null
}

function Find-ReleaseAssetMetadata {
  param($DownloadConfig, $CheckoutInfo, $Headers)

  if (!$DownloadConfig -or $DownloadConfig.provider -ne 'github') {
    return $null
  }
  if ($null -eq $CheckoutInfo -or [string]::IsNullOrWhiteSpace($CheckoutInfo.Tag)) {
    return $null
  }

  $release = Invoke-RestMethod -Uri (Get-ReleaseByTagApi -DownloadConfig $DownloadConfig -Tag $CheckoutInfo.Tag) -Headers $Headers -Method Get
  $asset = Find-ReleaseAsset -Release $release -DownloadConfig $DownloadConfig
  if (!$asset) {
    throw "Release '$($release.tag_name)' does not contain a matching portable asset."
  }

  return [pscustomobject]@{
    Release = $release
    Asset = $asset
  }
}

function Download-PortableApp {
  param([string]$Root, $DownloadConfig, $CheckoutInfo)

  if (!$DownloadConfig -or $DownloadConfig.provider -ne 'github') {
    return $null
  }
  if ($null -eq $CheckoutInfo -or [string]::IsNullOrWhiteSpace($CheckoutInfo.Tag)) {
    Write-Host "Skipping GitHub release download because the checked-out commit is not an exact release tag."
    return $null
  }

  $destinationDirectory = Convert-ToNativePath -Root $Root -RelativePath $DownloadConfig.destinationDirectory
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null

  $headers = Get-GitHubHeaders -DownloadConfig $DownloadConfig
  Write-Host "No packaged app was found locally. Downloading portable release for checked-out tag '$($CheckoutInfo.Tag)'..."
  Write-Host "  $($DownloadConfig.owner)/$($DownloadConfig.repo)"

  $metadata = Find-ReleaseAssetMetadata -DownloadConfig $DownloadConfig -CheckoutInfo $CheckoutInfo -Headers $headers
  $asset = $metadata.Asset
  $destinationPath = Join-Path $destinationDirectory $asset.name
  $temporaryPath = "$destinationPath.download"
  if (Test-Path -LiteralPath $temporaryPath) {
    Remove-Item -LiteralPath $temporaryPath -Force
  }

  $downloadHeaders = Copy-Hashtable -InputTable $headers
  $downloadHeaders['Accept'] = 'application/octet-stream'
  Invoke-WebRequest -Uri $asset.url -Headers $downloadHeaders -OutFile $temporaryPath
  Move-Item -LiteralPath $temporaryPath -Destination $destinationPath -Force

  return Get-Item -LiteralPath $destinationPath
}

function Find-ArtifactAsset {
  param($ArtifactsResponse, $DownloadConfig)

  $artifacts = @($ArtifactsResponse.artifacts)
  foreach ($pattern in @($DownloadConfig.artifactNamePatterns)) {
    foreach ($artifact in $artifacts) {
      if ($artifact.expired -eq $true) {
        continue
      }
      if ($artifact.name -like $pattern) {
        return $artifact
      }
    }
  }

  return $null
}

function Copy-FirstPortableFromArchive {
  param([string]$ExtractedDirectory, [string]$DestinationDirectory, $DownloadConfig)

  foreach ($pattern in @($DownloadConfig.assetPatterns)) {
    $matches = @(Get-ChildItem -LiteralPath $ExtractedDirectory -Recurse -File -Filter $pattern -ErrorAction SilentlyContinue | Sort-Object LastWriteTimeUtc -Descending)
    if ($matches.Count -gt 0) {
      $destinationPath = Join-Path $DestinationDirectory $matches[0].Name
      Copy-Item -LiteralPath $matches[0].FullName -Destination $destinationPath -Force
      return Get-Item -LiteralPath $destinationPath
    }
  }

  return $null
}

function Download-PortableArtifact {
  param([string]$Root, $DownloadConfig, $CheckoutInfo)

  if (!$DownloadConfig -or $DownloadConfig.provider -ne 'github') {
    return $null
  }
  if ($null -eq $CheckoutInfo -or [string]::IsNullOrWhiteSpace($CheckoutInfo.Commit)) {
    throw "Cannot select a workflow artifact because the current git commit could not be determined."
  }

  $destinationDirectory = Convert-ToNativePath -Root $Root -RelativePath $DownloadConfig.destinationDirectory
  New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null

  $headers = Get-GitHubHeaders -DownloadConfig $DownloadConfig
  Write-Host "Trying successful GitHub Actions portable artifact for checked-out commit $($CheckoutInfo.ShortCommit)..."
  Write-Host "  $($DownloadConfig.owner)/$($DownloadConfig.repo)"

  $metadata = Find-PortableArtifactMetadata -DownloadConfig $DownloadConfig -CheckoutInfo $CheckoutInfo -Headers $headers
  if (!$metadata) {
    throw "No successful workflow artifact for checked-out commit $($CheckoutInfo.ShortCommit) contained a matching portable executable."
  }

  $artifact = $metadata.Artifact
  $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("sporescout-testing-tools-" + [Guid]::NewGuid().ToString("N"))
  $zipPath = Join-Path $temporaryRoot 'portable-artifact.zip'
  $extractPath = Join-Path $temporaryRoot 'expanded'
  New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
  try {
    $downloadHeaders = Copy-Hashtable -InputTable $headers
    $downloadHeaders['Accept'] = 'application/zip'
    Invoke-WebRequest -Uri $artifact.archive_download_url -Headers $downloadHeaders -OutFile $zipPath
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
    $portable = Copy-FirstPortableFromArchive -ExtractedDirectory $extractPath -DestinationDirectory $destinationDirectory -DownloadConfig $DownloadConfig
    if ($portable) {
      return $portable
    }
  } finally {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  throw "Workflow artifact '$($artifact.name)' did not contain a matching portable executable."
}

function Find-PortableArtifactMetadata {
  param($DownloadConfig, $CheckoutInfo, $Headers)

  if (!$DownloadConfig -or $DownloadConfig.provider -ne 'github') {
    return $null
  }
  if ($null -eq $CheckoutInfo -or [string]::IsNullOrWhiteSpace($CheckoutInfo.Commit)) {
    throw "Cannot select a workflow artifact because the current git commit could not be determined."
  }

  $runsApi = Get-WorkflowRunsApi -DownloadConfig $DownloadConfig -CheckoutInfo $CheckoutInfo
  $runsResponse = Invoke-RestMethod -Uri $runsApi -Headers $Headers -Method Get
  foreach ($run in @($runsResponse.workflow_runs)) {
    if ($run.status -ne 'completed' -or $run.conclusion -ne 'success') {
      continue
    }
    if ([string]$run.head_sha -ne [string]$CheckoutInfo.Commit) {
      continue
    }

    $artifactsResponse = Invoke-RestMethod -Uri $run.artifacts_url -Headers $Headers -Method Get
    $artifact = Find-ArtifactAsset -ArtifactsResponse $artifactsResponse -DownloadConfig $DownloadConfig
    if (!$artifact) {
      continue
    }

    return [pscustomobject]@{
      Run = $run
      Artifact = $artifact
    }
  }

  return $null
}

function Test-DownloadAvailability {
  param($Manifest, $CheckoutInfo)

  if ($Manifest.releaseDownload) {
    if ($null -ne $CheckoutInfo -and ![string]::IsNullOrWhiteSpace($CheckoutInfo.Tag)) {
      try {
        $headers = Get-GitHubHeaders -DownloadConfig $Manifest.releaseDownload
        $releaseMetadata = Find-ReleaseAssetMetadata -DownloadConfig $Manifest.releaseDownload -CheckoutInfo $CheckoutInfo -Headers $headers
        if ($releaseMetadata) {
          Write-Host "Verified exact-tag release portable asset:"
          Write-Host "  tag $($releaseMetadata.Release.tag_name)"
          Write-Host "  asset $($releaseMetadata.Asset.name)"
          return $true
        }
      } catch {
        Write-Host "Exact-tag release check failed: $($_.Exception.Message)" -ForegroundColor Yellow
      }
    } else {
      Write-Host "Skipping exact-tag release check because HEAD is not an exact tag."
    }
  }

  if ($Manifest.artifactDownload) {
    try {
      $headers = Get-GitHubHeaders -DownloadConfig $Manifest.artifactDownload
      $artifactMetadata = Find-PortableArtifactMetadata -DownloadConfig $Manifest.artifactDownload -CheckoutInfo $CheckoutInfo -Headers $headers
      if ($artifactMetadata) {
        Write-Host "Verified checked-out-commit workflow portable artifact:"
        Write-Host "  run $($artifactMetadata.Run.id)"
        Write-Host "  commit $($CheckoutInfo.ShortCommit)"
        Write-Host "  artifact $($artifactMetadata.Artifact.name)"
        return $true
      }
    } catch {
      Write-Host "Workflow artifact check failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }
  }

  return $false
}

function Find-Npm {
  param([IO.FileInfo]$NodeExe)

  $nodeRoot = Split-Path -Parent $NodeExe.FullName
  $npmCmd = Join-Path $nodeRoot 'npm.cmd'
  if (Test-Path -LiteralPath $npmCmd) {
    return $npmCmd
  }

  $npmCli = Join-Path $nodeRoot 'node_modules\npm\bin\npm-cli.js'
  if (Test-Path -LiteralPath $npmCli) {
    return $npmCli
  }

  return $null
}

function Invoke-Npm {
  param([IO.FileInfo]$NodeExe, [string]$NpmPath, [string]$Root, [string[]]$Arguments)

  Push-Location -LiteralPath $Root
  try {
    if ($NpmPath.EndsWith('.cmd', [StringComparison]::OrdinalIgnoreCase)) {
      & $NpmPath @Arguments
    } else {
      & $NodeExe.FullName $NpmPath @Arguments
    }

    if ($LASTEXITCODE -ne 0) {
      throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

$root = Resolve-Root
$manifest = Read-Manifest -Root $root -Path $ManifestPath
$checkoutInfo = Get-GitCheckoutInfo -Root $root
$portableApp = if ($Dev -or $VerifyDownloadAvailability) { $null } else { Find-PortableApp -Root $root -Manifest $manifest }

if (!$Dev -and !$NoDownload -and $VerifyDownloadAvailability) {
  if (Test-DownloadAvailability -Manifest $manifest -CheckoutInfo $checkoutInfo) {
    exit 0
  }
  Write-Host "No exact-tag release asset or checked-out-commit workflow artifact is currently available." -ForegroundColor Red
  exit 4
}

if (!$Dev -and !$portableApp -and !$NoDownload -and $manifest.releaseDownload) {
  if ($DryRun) {
    Write-Host "No packaged app was found locally. The launcher would first try a portable GitHub release only when HEAD is an exact tag:"
    Write-Host "  $($manifest.releaseDownload.owner)/$($manifest.releaseDownload.repo)"
    if ($manifest.artifactDownload) {
      $commitLabel = if ($null -ne $checkoutInfo -and ![string]::IsNullOrWhiteSpace($checkoutInfo.ShortCommit)) { $checkoutInfo.ShortCommit } else { '<unknown commit>' }
      Write-Host "If no matching release asset exists, it would then try a successful GitHub Actions portable artifact for the checked-out commit:"
      Write-Host "  $($manifest.artifactDownload.owner)/$($manifest.artifactDownload.repo)"
      Write-Host "  commit $commitLabel"
    }
    exit 0
  }

  try {
    $portableApp = Download-PortableApp -Root $root -DownloadConfig $manifest.releaseDownload -CheckoutInfo $checkoutInfo
  } catch {
    Write-Host "Portable release download failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

if (!$Dev -and !$portableApp -and !$NoDownload -and $manifest.artifactDownload) {
  try {
    $portableApp = Download-PortableArtifact -Root $root -DownloadConfig $manifest.artifactDownload -CheckoutInfo $checkoutInfo
  } catch {
    Write-Host "Portable workflow artifact download failed: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

if ($portableApp) {
  Write-Host "Launching $($manifest.name) from packaged app:"
  Write-Host "  $($portableApp.FullName)"
  if (!$DryRun) {
    Start-Process -FilePath $portableApp.FullName -WorkingDirectory $portableApp.DirectoryName
  }
  exit 0
}

$nodeExe = Find-BundledNode -Root $root -Manifest $manifest
if (!$nodeExe) {
  Write-Host "No packaged portable app was found and no bundled Node runtime is available. Add a portable release executable under release\, or place node.exe at tools\node\node.exe." -ForegroundColor Red
  exit 2
}

$npmPath = Find-Npm -NodeExe $nodeExe
if (!$npmPath) {
  Write-Host "Bundled Node was found at $($nodeExe.FullName), but npm was not found beside it." -ForegroundColor Red
  exit 3
}

Write-Host "Launching $($manifest.name) from source fallback with bundled Node:"
Write-Host "  $($nodeExe.FullName)"

if ($DryRun) {
  exit 0
}

if (!(Test-Path -LiteralPath (Join-Path $root 'node_modules'))) {
  Invoke-Npm -NodeExe $nodeExe -NpmPath $npmPath -Root $root -Arguments @($manifest.sourceFallback.installCommand)
}

Invoke-Npm -NodeExe $nodeExe -NpmPath $npmPath -Root $root -Arguments @('run', $manifest.sourceFallback.npmScript)
