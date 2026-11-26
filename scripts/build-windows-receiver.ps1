$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$port = 31847
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$receiverSource = Join-Path $tempRoot "omnisync_windows_receiver.py"
$serverStdout = Join-Path $tempRoot "omnisync-build-server.out.log"
$serverStderr = Join-Path $tempRoot "omnisync-build-server.err.log"
$serverProcess = $null

$env:PORT = "$port"
$env:NODE_ENV = "production"
$env:ELECTRON_MAIN_PROCESS = "true"
$env:APP_ROOT_DIR = $repoRoot
$env:APP_DIST_DIR = Join-Path $repoRoot "dist"
$env:APP_PUBLIC_DIR = Join-Path $repoRoot "public"
$env:APP_DATA_DIR = Join-Path $tempRoot "omnisync-build-data"

New-Item -ItemType Directory -Force -Path $env:APP_DATA_DIR | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot "receiver-dist") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot "receiver-build") | Out-Null

try {
  Write-Host "Starting temporary local relay to generate the receiver source..."
  $serverProcess = Start-Process -FilePath "node" -ArgumentList "scripts/start-build-server.cjs" -WorkingDirectory $repoRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $serverStdout -RedirectStandardError $serverStderr

  $healthy = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if ($serverProcess.HasExited) {
      throw "Temporary relay server exited early. Output: $serverStdout $serverStderr"
    }
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 2
      if ($health.ok) {
        $healthy = $true
        break
      }
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $healthy) {
    throw "Temporary relay server did not become healthy. Output: $serverStdout $serverStderr"
  }

  Write-Host "Generating the Windows receiver source from the same server implementation used by the app..."
  Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/download/windows-receiver?pin=123456" -OutFile $receiverSource -UseBasicParsing
  if (-not (Test-Path $receiverSource) -or (Get-Item $receiverSource).Length -lt 10000) {
    throw "Generated receiver source is missing or unexpectedly small."
  }

  Write-Host "Compiling a self-contained Windows receiver (Python runtime and packages included)..."
  $distPath = Join-Path $repoRoot "receiver-dist"
  $workPath = Join-Path $repoRoot "receiver-build"
  python -m PyInstaller --clean --noconfirm --onedir --console --name "OmniSync-Windows-Receiver" --distpath $distPath --workpath $workPath --specpath $workPath --collect-all websockets --collect-all vgamepad $receiverSource
  if ($LASTEXITCODE -ne 0) {
    throw "PyInstaller failed with exit code $LASTEXITCODE."
  }

  $receiverExe = Join-Path $distPath "OmniSync-Windows-Receiver/OmniSync-Windows-Receiver.exe"
  if (-not (Test-Path $receiverExe) -or (Get-Item $receiverExe).Length -lt 1000000) {
    throw "The compiled Windows receiver executable was not produced."
  }

  Write-Host "Checking the compiled receiver executable..."
  & $receiverExe --help | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "The compiled receiver failed its --help smoke test."
  }

  Write-Host "Bundled receiver ready: $receiverExe"
}
finally {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
