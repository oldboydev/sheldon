[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Platform,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Platform -ne 'win32-x64') {
  throw "OCR_RUNTIME_PLATFORM_INVALID: Windows builder supports only win32-x64, not $Platform."
}
if ([string]::IsNullOrWhiteSpace($Output)) {
  throw 'OCR_RUNTIME_ARGUMENTS_INVALID: Use --platform win32-x64 --output <directory>.'
}

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Push-Location $repositoryRoot
try {
  $sourcesJson = node --input-type=module --eval "import { OCR_RUNTIME_SOURCES } from './scripts/release/ocr-runtime-sources.mjs'; process.stdout.write(JSON.stringify(OCR_RUNTIME_SOURCES));" 2>$null
} finally {
  Pop-Location
}
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sourcesJson)) {
  throw 'OCR_RUNTIME_SOURCE_UNPINNED: Unable to read the pinned OCR runtime source manifest.'
}
$sources = $sourcesJson | ConvertFrom-Json

$msysRoot = if ([string]::IsNullOrWhiteSpace($env:MSYS2_ROOT)) { 'C:\msys64' } else { $env:MSYS2_ROOT }
$mingwBin = Join-Path $msysRoot 'mingw64\bin'
$pacman = Join-Path $msysRoot 'usr\bin\pacman.exe'
foreach ($tool in @('cmake.exe', 'ninja.exe', 'g++.exe', 'objdump.exe')) {
  if (-not (Test-Path (Join-Path $mingwBin $tool))) {
    throw "OCR_RUNTIME_DEPENDENCY_INVALID: Missing MSYS2 MINGW64 tool $tool."
  }
}
if (-not (Test-Path $pacman)) {
  throw "OCR_RUNTIME_DEPENDENCY_INVALID: Missing MSYS2 package manager $pacman."
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
    Invoke-WebRequest -Uri $Uri -OutFile $Destination
    $actualHash = (Get-FileHash -Path $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $ExpectedHash.ToLowerInvariant()) {
      throw "OCR_RUNTIME_CHECKSUM_INVALID: SHA-256 mismatch for $Uri."
    }
  }

  function Get-PinnedDependencies([object[]]$Identities) {
    $missingDependenciesError = 'OCR_RUNTIME_MISSING_DEPENDENCIES'
    $identitiesJson = ConvertTo-Json -InputObject @($Identities) -Compress
    Push-Location $repositoryRoot
    try {
      $preflightJson = $identitiesJson | node --input-type=module --eval `
        'import { findPinnedOcrRuntimeDependency, formatMissingOcrRuntimeDependencies, OCR_RUNTIME_DEPENDENCY_INVENTORY } from ''./scripts/release/ocr-runtime-dependency-inventory.mjs'';
         const identities = JSON.parse(await new Promise((resolve, reject) => { let input = ``; process.stdin.setEncoding(`utf8`); process.stdin.on(`data`, (chunk) => input += chunk); process.stdin.on(`end`, () => resolve(input)); process.stdin.on(`error`, reject); }));
         if (!Array.isArray(identities) || identities.length === 0 || identities.some((identity) => !identity || typeof identity !== `object` || identity.provider !== `msys2` || typeof identity.name !== `string` || identity.name.length === 0 || typeof identity.version !== `string` || identity.version.length === 0)) {
           throw new Error(`OCR_RUNTIME_NOTICES_INVALID: MSYS2 dependency identities must be a non-empty array of complete records.`);
         }
         const missing = [];
         const diagnostics = [];
         const dependencies = identities.map((identity) => {
           diagnostics.push(`OCR_RUNTIME_DEPENDENCY: provider=${identity.provider} name=${identity.name} version=${identity.version}`);
           const dependency = findPinnedOcrRuntimeDependency(identity.provider, identity.name, identity.version, OCR_RUNTIME_DEPENDENCY_INVENTORY);
           if (!dependency) missing.push(identity);
           return dependency;
         });
         const missingReport = missing.length > 0 ? formatMissingOcrRuntimeDependencies(missing) : null;
         process.stdout.write(JSON.stringify({ dependencies, diagnostics, missingReport }));
         if (missingReport) process.exitCode = 1;'
      $lookupExitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
    if ([string]::IsNullOrWhiteSpace($preflightJson)) {
      throw 'OCR_RUNTIME_NOTICES_INVALID: MSYS2 dependency inventory preflight failed.'
    }
    $preflight = $preflightJson | ConvertFrom-Json
    $preflight.diagnostics | ForEach-Object { Write-Host $_ }
    if ($lookupExitCode -ne 0) {
      if ([string]::IsNullOrWhiteSpace($preflight.missingReport)) {
        throw "${missingDependenciesError}: MSYS2 dependency inventory preflight failed."
      }
      throw $preflight.missingReport
    }
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
    tar --extract --file $dependencyArchive --directory $dependencyRoot
    if ($LASTEXITCODE -ne 0) {
      throw "OCR_RUNTIME_NOTICES_INVALID: Unable to extract pinned source for $($dependency.provider)/$($dependency.name)@$($dependency.version)."
    }

    $licenseNoticeLines = [System.Collections.Generic.List[string]]::new()
    foreach ($license in $dependency.licenses) {
      $licensePath = $license.path -replace '\\', '/'
      $licenseFiles = @(
        Get-ChildItem -Path $dependencyRoot -Recurse -File | Where-Object {
          $relativePath = [System.IO.Path]::GetRelativePath($dependencyRoot, $_.FullName) -replace '\\', '/'
          $relativePath -eq $licensePath -or $relativePath.EndsWith("/$licensePath", [System.StringComparison]::Ordinal)
        }
      )
      if ($licenseFiles.Count -ne 1) {
        throw "OCR_RUNTIME_NOTICES_INVALID: Pinned license path $licensePath did not resolve uniquely for $($dependency.provider)/$($dependency.name)@$($dependency.version)."
      }
      $licenseHash = (Get-FileHash -Path $licenseFiles[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($licenseHash -ne $license.sha256.ToLowerInvariant()) {
        throw "OCR_RUNTIME_NOTICES_INVALID: License SHA-256 mismatch for $($dependency.provider)/$($dependency.name)@$($dependency.version)."
      }
      $licenseText = Get-Content -Raw $licenseFiles[0].FullName
      if ([string]::IsNullOrWhiteSpace($licenseText)) {
        throw "OCR_RUNTIME_NOTICES_INVALID: Verified license text is empty for $($dependency.provider)/$($dependency.name)@$($dependency.version)."
      }
      foreach ($line in @(
        "License SPDX: $($license.spdx)",
        "License path: $licensePath",
        "License SHA-256: $($license.sha256)",
        '',
        $licenseText,
        ''
      )) {
        [void]$licenseNoticeLines.Add($line)
      }
    }

    return @(
      "== $($dependency.provider) package: $($dependency.name)@$($dependency.version) ==",
      "Provider: $($dependency.provider)",
      "Package: $($dependency.name)",
      "Version: $($dependency.version)",
      "SPDX: $($dependency.spdx)",
      "Source: $($dependency.sourceUrl)",
      "Source SHA-256: $($dependency.sourceSha256)",
      "Private DLLs: $(($PrivateDlls | Sort-Object) -join ', ')",
      ''
    ) + $licenseNoticeLines
  }

  Get-PinnedFile $sources.tesseract.url $sourceArchive $sources.tesseract.sha256
  Get-PinnedFile $sources.models.eng.url (Join-Path $modelsRoot 'eng.traineddata') $sources.models.eng.sha256
  Get-PinnedFile $sources.models.por.url (Join-Path $modelsRoot 'por.traineddata') $sources.models.por.sha256
  tar --extract --gzip --file $sourceArchive --directory $sourceRoot --strip-components=1
  Copy-Item (Join-Path $modelsRoot 'eng.traineddata') (Join-Path $dataRoot 'eng.traineddata')
  Copy-Item (Join-Path $modelsRoot 'por.traineddata') (Join-Path $dataRoot 'por.traineddata')

  $previousPath = $env:PATH
  $env:PATH = "$mingwBin;$env:PATH"
  & (Join-Path $mingwBin 'cmake.exe') -S $sourceRoot -B (Join-Path $workRoot 'build') -G Ninja `
    -DCMAKE_BUILD_TYPE=Release `
    -DBUILD_SHARED_LIBS=ON `
    -DBUILD_TESTS=OFF `
    -DBUILD_TRAINING_TOOLS=OFF `
    -DSW_BUILD=OFF `
    -DDISABLE_ARCHIVE=ON `
    -DDISABLE_CURL=ON `
    -DENABLE_NATIVE=OFF `
    -DGRAPHICS_DISABLED=ON `
    -DOPENMP_BUILD=OFF
  if ($LASTEXITCODE -ne 0) { throw 'OCR_RUNTIME_BUILD_FAILED: CMake configuration failed.' }
  & (Join-Path $mingwBin 'cmake.exe') --build (Join-Path $workRoot 'build') --target tesseract --parallel
  if ($LASTEXITCODE -ne 0) { throw 'OCR_RUNTIME_BUILD_FAILED: Tesseract compilation failed.' }
  $env:PATH = $previousPath

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
    $dependencies = & $objdump -p $candidate |
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
        $ownership = & $pacman -Qo $packagePath 2>$null
        if ($LASTEXITCODE -eq 0 -and $ownership -match '\s+is owned by\s+([^\s]+)\s+') {
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
    $packageQuery = & $pacman -Q $packageName 2>$null
    if ($LASTEXITCODE -ne 0 -or $packageQuery -notmatch '^([^\s]+)\s+([^\s]+)$') {
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
  $env:PATH = "$libraryRoot;$env:PATH"
  $health = & $executable --tessdata-dir $dataRoot --list-langs 2>&1
  $env:PATH = $previousPath
  if ($LASTEXITCODE -ne 0 -or -not ($health -contains 'eng') -or -not ($health -contains 'por')) {
    throw "OCR_RUNTIME_HEALTHCHECK_FAILED: Tesseract could not list eng and por. Output: $health"
  }
} finally {
  if (Test-Path $workRoot) { Remove-Item -Recurse -Force $workRoot }
}
