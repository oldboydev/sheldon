$description = [ordered]@{
  id = 'fixture.powershell'; name = 'PowerShell fixture'; version = '1.0.0'; protocolVersion = '1'
  license = 'MIT'; capabilities = @('fixture'); priority = 10; platforms = @('win32')
  permissions = [ordered]@{ network = $false; cookies = $false }; dependencies = @()
}

function Write-Response([string]$RequestId, [string]$Status, $Body) {
  $response = [ordered]@{ protocolVersion = '1'; requestId = $RequestId; status = $Status }
  foreach ($key in $Body.Keys) { $response[$key] = $Body[$key] }
  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 20))
}

$active = $null
while (($line = [Console]::In.ReadLine()) -ne $null) {
  $request = $line | ConvertFrom-Json
  if ($request.operation -eq 'cancel') {
    Write-Response $request.requestId 'success' ([ordered]@{ result = [ordered]@{} })
    if ($null -ne $active -and $active.requestId -eq $request.payload.targetRequestId) {
      $partial = Join-Path $active.payload.temporaryDirectory 'partial.md'
      if (Test-Path $partial) { Remove-Item -LiteralPath $partial -Force }
      Write-Response $active.requestId 'cancelled' ([ordered]@{ error = [ordered]@{ code = 'PLUGIN_CANCELLED'; message = 'Cancelled by fixture.' } })
    }
    break
  }
  if ($request.operation -eq 'describe') {
    Write-Response $request.requestId 'success' ([ordered]@{ result = $description })
    break
  }
  if ($request.operation -eq 'probe') {
    $supported = $request.payload.input.kind -eq 'fixture'
    Write-Response $request.requestId 'success' ([ordered]@{ result = [ordered]@{ supported = $supported; confidence = $(if ($supported) { 90 } else { 0 }); reason = $(if ($supported) { 'supported' } else { 'unsupported' }) } })
    break
  }
  if ($request.operation -eq 'healthcheck') {
    [Console]::Error.WriteLine('powershell fixture healthy')
    Write-Response $request.requestId 'success' ([ordered]@{ result = [ordered]@{ checks = @([ordered]@{ id = 'powershell-health'; severity = 'info'; message = 'healthy' }) } })
    break
  }
  if ($request.operation -eq 'ingest') {
    $active = $request
    if ($request.payload.input.wait -eq $true) {
      [IO.File]::WriteAllText((Join-Path $request.payload.temporaryDirectory 'partial.md'), 'partial')
      continue
    }
    $content = "# PowerShell fixture`n"
    $bytes = [Text.Encoding]::UTF8.GetBytes($content)
    [IO.File]::WriteAllBytes((Join-Path $request.payload.temporaryDirectory 'content.md'), $bytes)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = -join ($hasher.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) }
    finally { $hasher.Dispose() }
    Write-Response $request.requestId 'success' ([ordered]@{ result = @([ordered]@{ id = 'content'; role = 'normalized'; path = 'content.md'; mediaType = 'text/markdown'; bytes = $bytes.Length; sha256 = $hash }) })
    break
  }
}
