[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Platform,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function New-OcrRuntimeJob {
  if ($null -eq ('OcrRuntimeJob' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;

public sealed class OcrRuntimeJob : IDisposable
{
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, int length);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr handle;

    public OcrRuntimeJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        try
        {
            Marshal.StructureToPtr(limits, pointer, false);
            if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, pointer, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        catch
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
            throw;
        }
        finally { Marshal.FreeHGlobal(pointer); }
    }

    public void AddProcess(IntPtr process)
    {
        if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static Task WriteAndCloseAsync(StreamWriter writer, string text)
    {
        return Task.Run(() =>
        {
            try { writer.Write(text); }
            finally { writer.Close(); }
        });
    }

    public void Dispose()
    {
        if (handle != IntPtr.Zero)
        {
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }
}
'@
  }
  return [OcrRuntimeJob]::new()
}

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
  $job = New-OcrRuntimeJob
  try {
    Write-Host "OCR_RUNTIME_STAGE: $Stage"
    if (-not $process.Start()) {
      throw "OCR_RUNTIME_PROCESS_INVALID: Unable to start stage $Stage."
    }
    $job.AddProcess($process.Handle)
    $stdout = [System.Text.StringBuilder]::new()
    $stderr = [System.Text.StringBuilder]::new()
    $stdoutBuffer = [char[]]::new(4096)
    $stderrBuffer = [char[]]::new(4096)
    $stdoutRead = $process.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
    $stderrRead = $process.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $stdinWrite = if ($PSBoundParameters.ContainsKey('StandardInput')) {
      [OcrRuntimeJob]::WriteAndCloseAsync($process.StandardInput, $StandardInput)
    } else {
      $process.StandardInput.Close()
      $null
    }
    $stdinOpen = $null -ne $stdinWrite
    $timedOut = $false
    while ($null -ne $stdinWrite -or $null -ne $stdoutRead -or $null -ne $stderrRead) {
      $pending = [System.Collections.Generic.List[System.Threading.Tasks.Task]]::new()
      if ($null -ne $stdinWrite) { [void]$pending.Add($stdinWrite) }
      if ($null -ne $stdoutRead) { [void]$pending.Add($stdoutRead) }
      if ($null -ne $stderrRead) { [void]$pending.Add($stderrRead) }
      [void][System.Threading.Tasks.Task]::WaitAny($pending.ToArray(), 50)

      if ($null -ne $stdinWrite -and $stdinWrite.IsCompleted) {
        try {
          [void]$stdinWrite.GetAwaiter().GetResult()
        } catch {
          if (-not $timedOut) { throw }
        }
        $stdinOpen = $false
        $stdinWrite = $null
      }
      if ($null -ne $stdoutRead -and $stdoutRead.IsCompleted) {
        $stdoutCount = $stdoutRead.GetAwaiter().GetResult()
        if ($stdoutCount -gt 0) {
          $stdoutChunk = [string]::new($stdoutBuffer, 0, $stdoutCount)
          [void]$stdout.Append($stdoutChunk)
          [Console]::Out.Write("OCR_RUNTIME_STDOUT: $stdoutChunk")
          $stdoutRead = $process.StandardOutput.ReadAsync($stdoutBuffer, 0, $stdoutBuffer.Length)
        } else {
          $stdoutRead = $null
        }
      }
      if ($null -ne $stderrRead -and $stderrRead.IsCompleted) {
        $stderrCount = $stderrRead.GetAwaiter().GetResult()
        if ($stderrCount -gt 0) {
          $stderrChunk = [string]::new($stderrBuffer, 0, $stderrCount)
          [void]$stderr.Append($stderrChunk)
          [Console]::Error.Write("OCR_RUNTIME_STDERR: $stderrChunk")
          $stderrRead = $process.StandardError.ReadAsync($stderrBuffer, 0, $stderrBuffer.Length)
        } else {
          $stderrRead = $null
        }
      }

      if (-not $timedOut -and $watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
        $timedOut = $true
        # Do not synchronously close a stream while its background writer is blocked on a full
        # pipe. More importantly, do not wait for redirected readers to observe EOF after a
        # timeout: that observation can itself block on Windows. Killing the job and throwing
        # immediately keeps the watchdog's bound independent of pipe cleanup scheduling.
        if ($stdinOpen) {
          $stdinOpen = $false
          $stdinWrite = $null
        }
        if (-not $process.WaitForExit(0)) {
          try {
            $process.Kill($true)
          } catch [System.InvalidOperationException] {
            if (-not $process.HasExited) { throw }
          }
        }
        $job.Dispose()
        $job = $null
        throw "${TimeoutCode}: Stage $Stage exceeded $TimeoutSeconds seconds."
      }
    }
    $process.WaitForExit()
    if ($timedOut) {
      throw "${TimeoutCode}: Stage $Stage exceeded $TimeoutSeconds seconds."
    }

    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      StdOut = $stdout.ToString()
      StdErr = $stderr.ToString()
    }
  } finally {
    if ($null -ne $job) { $job.Dispose() }
    $process.Dispose()
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
$tar = Join-Path $msysRoot 'usr\bin\bsdtar.exe'
if (-not (Test-Path $pacman)) {
  throw "OCR_RUNTIME_DEPENDENCY_INVALID: Missing MSYS2 package manager $pacman."
}
if (-not (Test-Path $tar)) {
  throw "OCR_RUNTIME_DEPENDENCY_INVALID: Missing MSYS2 archive extractor $tar."
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
     $licensePaths = @($dependency.licenses | ForEach-Object { $_.path })
     $extractResult = Invoke-WatchedProcess -FilePath $tar `
       -ArgumentList (@('--extract', '--file', $dependencyArchive, '--directory', $dependencyRoot, '--') + $licensePaths) `
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
   $tesseractExtract = Invoke-WatchedProcess -FilePath $tar `
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
     $dependencies = $inspection.StdOut -split "`r?`n" |
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
    '', '== Verified MSYS2 package licenses =='
  )
  $notices += @($msys2LicenseNotices | ForEach-Object { $_ })
  $notices = $notices -join [Environment]::NewLine
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
