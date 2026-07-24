[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Platform,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-WatchedProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [AllowEmptyString()][string]$StandardInput,
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds,
    [Parameter(Mandatory = $true)][string]$TimeoutCode
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in $ArgumentList) {
    [void]$startInfo.ArgumentList.Add($argument)
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  Write-Host "OCR_RUNTIME_STAGE: $Stage"
  if (-not $process.Start()) {
    throw "OCR_RUNTIME_PROCESS_INVALID: Unable to start stage $Stage."
  }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if ($PSBoundParameters.ContainsKey('StandardInput')) {
    $process.StandardInput.Write($StandardInput)
  }
  $process.StandardInput.Close()

  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill($true)
    $process.WaitForExit()
    [void]$stdoutTask.GetAwaiter().GetResult()
    [void]$stderrTask.GetAwaiter().GetResult()
    throw "${TimeoutCode}: Stage $Stage exceeded $TimeoutSeconds seconds."
  }

  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    StdOut = $stdoutTask.GetAwaiter().GetResult()
    StdErr = $stderrTask.GetAwaiter().GetResult()
  }
}

if ($Platform -ne 'win32-x64') {
  throw "OCR_RUNTIME_PLATFORM_INVALID: Windows builder supports only win32-x64, not $Platform."
}
if ([string]::IsNullOrWhiteSpace($Output)) {
  throw 'OCR_RUNTIME_ARGUMENTS_INVALID: Use --platform win32-x64 --output <directory>.'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$msysRoot = if ([string]::IsNullOrWhiteSpace($env:MSYS2_ROOT)) { 'C:\msys64' } else { $env:MSYS2_ROOT }
$mingwBin = Join-Path $msysRoot 'mingw64\bin'
$pacman = Join-Path $msysRoot 'usr\bin\pacman.exe'
if (-not (Test-Path $pacman)) {
  throw "OCR_RUNTIME_DEPENDENCY_INVALID: Missing MSYS2 package manager $pacman."
}
$graphQuery = Invoke-WatchedProcess -FilePath $pacman -ArgumentList @('-Q') -Stage 'graph-query' `
  -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_GRAPH_TIMEOUT'
$installedGraph = $graphQuery.StdOut
if ($graphQuery.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($installedGraph)) {
  throw 'OCR_RUNTIME_MSYS2_GRAPH_INVALID: Unable to read the complete installed MSYS2 package graph.'
}

$windowsRuntimeCli = Join-Path $repositoryRoot 'scripts\release\windows-ocr-runtime-cli.mjs'
$graphLock = Join-Path $repositoryRoot 'scripts\release\msys2-ocr-runtime.lock.json'
if (-not (Test-Path $windowsRuntimeCli)) {
  throw "OCR_RUNTIME_DEPENDENCY_INVALID: Missing Windows OCR runtime CLI $windowsRuntimeCli."
}
$graphLockResult = Invoke-WatchedProcess -FilePath 'node' `
  -ArgumentList @($windowsRuntimeCli, 'graph-lock', '--lock', $graphLock) -StandardInput $installedGraph `
  -Stage 'graph-lock' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_GRAPH_TIMEOUT'
if ($graphLockResult.ExitCode -ne 0) {
  throw 'OCR_RUNTIME_MSYS2_GRAPH_INVALID: Installed MSYS2 packages do not match the committed graph lock.'
}

foreach ($tool in @('cmake.exe', 'ninja.exe', 'g++.exe', 'objdump.exe')) {
  if (-not (Test-Path (Join-Path $mingwBin $tool))) {
    throw "OCR_RUNTIME_DEPENDENCY_INVALID: Missing MSYS2 MINGW64 tool $tool."
  }
}

$sourcesResult = Invoke-WatchedProcess -FilePath 'node' -ArgumentList @($windowsRuntimeCli, 'sources') `
  -Stage 'read-sources' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_SOURCE_TIMEOUT'
$sourcesJson = $sourcesResult.StdOut
if ($sourcesResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($sourcesJson)) {
  throw 'OCR_RUNTIME_SOURCE_UNPINNED: Unable to read the pinned OCR runtime source manifest.'
}
try {
  $sources = $sourcesJson | ConvertFrom-Json
} catch {
  throw 'OCR_RUNTIME_SOURCE_UNPINNED: Pinned OCR runtime source manifest is not valid JSON.'
}

$outputRoot = [System.IO.Path]::GetFullPath($Output)
if (Test-Path $outputRoot) {
  if ((Get-ChildItem -Force $outputRoot | Measure-Object).Count -ne 0) {
    throw "OCR_RUNTIME_OUTPUT_INVALID: Output directory must be empty: $outputRoot"
  }
} else {
  New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
}

$workRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("sheldon-ocr-win-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $workRoot | Out-Null
try {
  $sourceArchive = Join-Path $workRoot 'tesseract.tar.gz'
  $sourceRoot = Join-Path $workRoot 'source'
  $modelsRoot = Join-Path $workRoot 'models'
  $runtimeRoot = Join-Path $outputRoot 'runtime\win32-x64'
  $libraryRoot = Join-Path $runtimeRoot 'lib'
  $dataRoot = Join-Path $outputRoot 'data\tessdata'
  New-Item -ItemType Directory -Force -Path $sourceRoot, $modelsRoot, $libraryRoot, $dataRoot | Out-Null

   function Get-PinnedFile([string]$Uri, [string]$Destination, [string]$ExpectedHash) {
     $downloadResult = Invoke-WatchedProcess -FilePath 'node' `
       -ArgumentList @($windowsRuntimeCli, 'download', '--url', $Uri, '--output', $Destination, '--sha256', $ExpectedHash) `
       -Stage 'download-source' -TimeoutSeconds 180 -TimeoutCode 'OCR_RUNTIME_DOWNLOAD_TIMEOUT'
     if ($downloadResult.ExitCode -ne 0) {
      throw "OCR_RUNTIME_DOWNLOAD_INVALID: Unable to download pinned source $Uri."
    }
  }

   function Get-PinnedDependencies([object[]]$Identities) {
     $identitiesJson = ConvertTo-Json -InputObject @($Identities) -Compress
     $preflightResult = Invoke-WatchedProcess -FilePath 'node' `
       -ArgumentList @($windowsRuntimeCli, 'dependency-preflight') -StandardInput $identitiesJson `
       -Stage 'preflight-dependencies' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_INSPECTION_TIMEOUT'
     $preflightJson = $preflightResult.StdOut
     if ($preflightResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($preflightJson)) {
      throw 'OCR_RUNTIME_NOTICES_INVALID: MSYS2 dependency inventory preflight failed.'
    }
    $preflight = $preflightJson | ConvertFrom-Json
    return @($preflight.dependencies)
  }

  function Get-VerifiedDependencyNotice(
    [object]$dependency,
    [string[]]$PrivateDlls,
    [int]$Index
  ) {
     $dependencyArchive = Join-Path $workRoot "dependency-$Index.source"
     $dependencyRoot = Join-Path $workRoot "dependency-$Index"
     New-Item -ItemType Directory -Path $dependencyRoot | Out-Null
     Get-PinnedFile $dependency.sourceUrl $dependencyArchive $dependency.sourceSha256
     $extractResult = Invoke-WatchedProcess -FilePath 'tar' `
       -ArgumentList @('--extract', '--file', $dependencyArchive, '--directory', $dependencyRoot) `
       -Stage 'extract-dependency' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_ARCHIVE_TIMEOUT'
     if ($extractResult.ExitCode -ne 0) {
      throw "OCR_RUNTIME_NOTICES_INVALID: Unable to extract pinned source for $($dependency.provider)/$($dependency.name)@$($dependency.version)."
    }

    $noticeInput = @{
      dependency = $dependency
      privateDlls = @($PrivateDlls)
      extractedRoot = $dependencyRoot
    } | ConvertTo-Json -Depth 8 -Compress
     $noticeResult = Invoke-WatchedProcess -FilePath 'node' `
       -ArgumentList @($windowsRuntimeCli, 'dependency-notice') -StandardInput $noticeInput `
       -Stage 'render-notice' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_INSPECTION_TIMEOUT'
     $notice = $noticeResult.StdOut
     if ($noticeResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($notice)) {
      throw "OCR_RUNTIME_NOTICES_INVALID: Unable to render verified notice for $($dependency.provider)/$($dependency.name)@$($dependency.version)."
    }
    return $notice
  }

   Get-PinnedFile $sources.tesseract.url $sourceArchive $sources.tesseract.sha256
   Get-PinnedFile $sources.models.eng.url (Join-Path $modelsRoot 'eng.traineddata') $sources.models.eng.sha256
   Get-PinnedFile $sources.models.por.url (Join-Path $modelsRoot 'por.traineddata') $sources.models.por.sha256
   $tesseractExtract = Invoke-WatchedProcess -FilePath 'tar' `
     -ArgumentList @('--extract', '--gzip', '--file', $sourceArchive, '--directory', $sourceRoot, '--strip-components=1') `
     -Stage 'extract-tesseract' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_ARCHIVE_TIMEOUT'
   if ($tesseractExtract.ExitCode -ne 0) {
     throw 'OCR_RUNTIME_BUILD_FAILED: Unable to extract pinned Tesseract source.'
   }
  Copy-Item (Join-Path $modelsRoot 'eng.traineddata') (Join-Path $dataRoot 'eng.traineddata')
  Copy-Item (Join-Path $modelsRoot 'por.traineddata') (Join-Path $dataRoot 'por.traineddata')

   $previousPath = $env:PATH
   try {
     $env:PATH = "$mingwBin;$env:PATH"
     $configureResult = Invoke-WatchedProcess -FilePath (Join-Path $mingwBin 'cmake.exe') `
       -ArgumentList @(
         '-S', $sourceRoot, '-B', (Join-Path $workRoot 'build'), '-G', 'Ninja',
         '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=ON', '-DBUILD_TESTS=OFF',
         '-DBUILD_TRAINING_TOOLS=OFF', '-DSW_BUILD=OFF', '-DDISABLE_ARCHIVE=ON',
         '-DDISABLE_CURL=ON', '-DENABLE_NATIVE=OFF', '-DGRAPHICS_DISABLED=ON', '-DOPENMP_BUILD=OFF'
       ) -Stage 'configure' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_CONFIGURE_TIMEOUT'
     if ($configureResult.ExitCode -ne 0) { throw 'OCR_RUNTIME_BUILD_FAILED: CMake configuration failed.' }
     $buildResult = Invoke-WatchedProcess -FilePath (Join-Path $mingwBin 'cmake.exe') `
       -ArgumentList @('--build', (Join-Path $workRoot 'build'), '--target', 'tesseract', '--parallel') `
       -Stage 'build' -TimeoutSeconds 900 -TimeoutCode 'OCR_RUNTIME_BUILD_TIMEOUT'
     if ($buildResult.ExitCode -ne 0) { throw 'OCR_RUNTIME_BUILD_FAILED: Tesseract compilation failed.' }
  } finally {
    $env:PATH = $previousPath
  }

  $builtExecutable = Get-ChildItem -Path (Join-Path $workRoot 'build') -Recurse -File -Filter 'tesseract.exe' |
    Select-Object -First 1
  if ($null -eq $builtExecutable) { throw 'OCR_RUNTIME_BUILD_FAILED: Tesseract executable was not produced.' }
  $executable = Join-Path $runtimeRoot 'tesseract.exe'
  Copy-Item $builtExecutable.FullName $executable

  $systemDlls = @(
    'ADVAPI32.DLL', 'BCRYPT.DLL', 'COMDLG32.DLL', 'CRYPT32.DLL', 'GDI32.DLL', 'IPHLPAPI.DLL',
    'KERNEL32.DLL', 'MSVCRT.DLL', 'NTDLL.DLL', 'OLE32.DLL', 'OLEAUT32.DLL', 'SHELL32.DLL',
    'SHLWAPI.DLL', 'UCRTBASE.DLL', 'USER32.DLL', 'USERENV.DLL', 'VERSION.DLL', 'WINMM.DLL', 'WS2_32.DLL'
  )
  $objdump = Join-Path $mingwBin 'objdump.exe'
  $queue = [System.Collections.Generic.Queue[string]]::new()
  $queue.Enqueue($builtExecutable.FullName)
  $visited = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $copied = [System.Collections.Generic.List[string]]::new()
  $privateDllProviders = @{}
  while ($queue.Count -gt 0) {
    $candidate = $queue.Dequeue()
    $resolvedCandidate = [System.IO.Path]::GetFullPath($candidate)
    if (-not $visited.Add($resolvedCandidate)) { continue }
     $inspection = Invoke-WatchedProcess -FilePath $objdump -ArgumentList @('-p', $candidate) `
       -Stage 'inspect-dll' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_INSPECTION_TIMEOUT'
     if ($inspection.ExitCode -ne 0) {
       throw "OCR_RUNTIME_DEPENDENCY_INVALID: Unable to inspect private DLL dependencies for $candidate."
     }
     $dependencies = $inspection.StdOut |
       Select-String -Pattern '^\s*DLL Name:\s*(.+)$' |
       ForEach-Object { $_.Matches[0].Groups[1].Value.Trim() }
    foreach ($dependency in $dependencies) {
      if ($systemDlls -contains $dependency.ToUpperInvariant()) { continue }
      $matches = @(
        Get-ChildItem -Path (Split-Path $candidate), (Join-Path $workRoot 'build'), $mingwBin -Recurse -File -Filter $dependency -ErrorAction SilentlyContinue |
          Select-Object -First 1
      )
      $sourceDll = $matches | Where-Object { $_ -is [System.IO.FileInfo] } | Select-Object -First 1
      if ($null -eq $sourceDll) {
        throw "OCR_RUNTIME_DEPENDENCY_INVALID: Unable to locate private DLL dependency $dependency."
      }
      $destinationDll = Join-Path $libraryRoot $dependency
      if (-not (Test-Path $destinationDll)) {
        Copy-Item $sourceDll.FullName $destinationDll
        $copied.Add($dependency)
        $packagePath = if ($sourceDll.FullName.StartsWith($msysRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
          '/' + ($sourceDll.FullName.Substring($msysRoot.Length).TrimStart('\') -replace '\\', '/')
        } else {
          $sourceDll.FullName
        }
         $ownership = Invoke-WatchedProcess -FilePath $pacman -ArgumentList @('-Qo', $packagePath) `
           -Stage 'package-owner' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_INSPECTION_TIMEOUT'
         if ($ownership.ExitCode -eq 0 -and $ownership.StdOut -match '\s+is owned by\s+([^\s]+)\s+') {
          $packageName = $Matches[1]
          if (-not $privateDllProviders.ContainsKey($packageName)) {
            $privateDllProviders[$packageName] = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
          }
          [void]$privateDllProviders[$packageName].Add($dependency)
        }
      }
      $queue.Enqueue($sourceDll.FullName)
    }
  }
  if ($copied.Count -eq 0) { throw 'OCR_RUNTIME_DEPENDENCY_INVALID: No private DLL dependencies were packaged.' }
  if ($privateDllProviders.Count -eq 0) {
    throw 'OCR_RUNTIME_NOTICES_INVALID: No MSYS2 package ownership was found for bundled private DLLs.'
  }

   $packageIdentities = [System.Collections.Generic.List[object]]::new()
   foreach ($packageName in ($privateDllProviders.Keys | Sort-Object)) {
     $packageQuery = Invoke-WatchedProcess -FilePath $pacman -ArgumentList @('-Q', $packageName) `
       -Stage 'package-owner' -TimeoutSeconds 300 -TimeoutCode 'OCR_RUNTIME_INSPECTION_TIMEOUT'
     if ($packageQuery.ExitCode -ne 0 -or $packageQuery.StdOut -notmatch '^([^\s]+)\s+([^\s]+)$') {
      throw "OCR_RUNTIME_NOTICES_INVALID: Unable to determine the installed MSYS2 version for $packageName."
    }
    $installedName = $Matches[1]
    $installedVersion = $Matches[2]
    [void]$packageIdentities.Add([pscustomobject]@{
      provider = 'msys2'
      name = $installedName
      version = $installedVersion
    })
  }

  $pinnedDependencies = @(Get-PinnedDependencies @($packageIdentities))
  $msys2LicenseNotices = [System.Collections.Generic.List[string]]::new()
  $dependencyIndex = 0
  foreach ($dependency in $pinnedDependencies) {
    $noticeLines = Get-VerifiedDependencyNotice $dependency @($privateDllProviders[$dependency.name]) $dependencyIndex
    $noticeLines | ForEach-Object { [void]$msys2LicenseNotices.Add($_) }
    $dependencyIndex++
  }

  $modelLicense = Join-Path $workRoot 'tessdata-LICENSE'
  $modelLicenseUrl = $sources.models.eng.licenseSource -replace 'https://github.com/', 'https://raw.githubusercontent.com/' -replace '/blob/', '/'
  Get-PinnedFile $modelLicenseUrl $modelLicense $sources.models.eng.licenseSha256
  $sourceLicense = Join-Path $sourceRoot 'LICENSE'
  if (-not (Test-Path $sourceLicense) -or -not (Test-Path $modelLicense)) {
    throw 'OCR_RUNTIME_NOTICES_INVALID: Required upstream license text is missing.'
  }
  $notices = @(
    'Sheldon OCR runtime third-party notices',
    '',
    'Platform: win32-x64',
    "Tesseract source: $($sources.tesseract.url)",
    "Tesseract revision: $($sources.tesseract.revision)",
    "Tesseract SHA-256: $($sources.tesseract.sha256)",
    '', '== Tesseract OCR ==', (Get-Content -Raw $sourceLicense),
    '', '== tessdata_fast base models ==',
    "eng source: $($sources.models.eng.url)", "por source: $($sources.models.por.url)",
    "tessdata license source: $modelLicenseUrl", "tessdata license SHA-256: $($sources.models.eng.licenseSha256)",
    (Get-Content -Raw $modelLicense),
    '', '== Bundled MSYS2 DLLs ==', ($copied | Sort-Object | ForEach-Object { "- $_" }),
    '', '== Verified MSYS2 package licenses ==', $msys2LicenseNotices
  ) -join [Environment]::NewLine
  $noticesPath = Join-Path $runtimeRoot 'THIRD_PARTY_NOTICES'
  [System.IO.File]::WriteAllText($noticesPath, $notices + [Environment]::NewLine)
  if ((Get-Item $noticesPath).Length -eq 0) { throw 'OCR_RUNTIME_NOTICES_INVALID: Notices are empty.' }
  foreach ($packageName in $privateDllProviders.Keys) {
    if ($notices -notmatch [regex]::Escape("Package: $packageName")) {
      throw "OCR_RUNTIME_NOTICES_INVALID: Notices are missing the MSYS2 package section for $packageName."
    }
  }

   $previousPath = $env:PATH
   try {
     $env:PATH = "$libraryRoot;$env:PATH"
     $health = Invoke-WatchedProcess -FilePath $executable `
       -ArgumentList @('--tessdata-dir', $dataRoot, '--list-langs') `
       -Stage 'health-check' -TimeoutSeconds 60 -TimeoutCode 'OCR_RUNTIME_HEALTH_TIMEOUT'
   } finally {
     $env:PATH = $previousPath
   }
   $healthLines = $health.StdOut -split "`r?`n"
   if ($health.ExitCode -ne 0 -or -not ($healthLines -contains 'eng') -or -not ($healthLines -contains 'por')) {
     throw "OCR_RUNTIME_HEALTHCHECK_FAILED: Tesseract could not list eng and por. Output: $($health.StdOut)"
   }
} finally {
  if (Test-Path $workRoot) { Remove-Item -Recurse -Force $workRoot }
}
