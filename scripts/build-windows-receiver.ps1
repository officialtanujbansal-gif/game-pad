$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$port = 31847
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$serverStdout = Join-Path $tempRoot "omnisync-build-server.out.log"
$serverStderr = Join-Path $tempRoot "omnisync-build-server.err.log"
$serverProcess = $null
$receiverDir = Join-Path $repoRoot "receiver-dist"

$env:PORT = "$port"
$env:NODE_ENV = "production"
$env:ELECTRON_MAIN_PROCESS = "true"
$env:APP_ROOT_DIR = $repoRoot
$env:APP_DIST_DIR = Join-Path $repoRoot "dist"
$env:APP_PUBLIC_DIR = Join-Path $repoRoot "public"
$env:APP_DATA_DIR = Join-Path $tempRoot "omnisync-build-data"

New-Item -ItemType Directory -Force -Path $env:APP_DATA_DIR | Out-Null
New-Item -ItemType Directory -Force -Path $receiverDir | Out-Null

try {
  Write-Host "Starting temporary local relay to generate the receiver script and launcher..."
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

  Write-Host "Downloading generated Windows receiver Python script..."
  $pythonFile = Join-Path $receiverDir "redlinepad_windows_receiver.py"
  Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/download/windows-receiver?pin=123456" -OutFile $pythonFile -UseBasicParsing
  if (-not (Test-Path $pythonFile) -or (Get-Item $pythonFile).Length -lt 10000) {
    throw "Generated Python receiver is missing or unexpectedly small."
  }

  Write-Host "Downloading the matching Windows BAT launcher..."
  $launcherFile = Join-Path $receiverDir "Launch_RedlinePad_Windows.bat"
  Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/download/windows-launcher?pin=123456" -OutFile $launcherFile -UseBasicParsing
  if (-not (Test-Path $launcherFile) -or (Get-Item $launcherFile).Length -lt 500) {
    throw "Generated Windows launcher is missing or unexpectedly small."
  }

  $launcherText = Get-Content -Raw $launcherFile
  foreach ($required in @("OMNISYNC_AUTOSTART", "OMNISYNC_PIN", "OMNISYNC_RELAY", "vgamepad", "websockets", "redlinepad_windows_receiver.py", "--relay")) {
    if (-not $launcherText.Contains($required)) {
      throw "Generated Windows launcher is missing expected feature: $required"
    }
  }

  Write-Host "Receiver script and BAT launcher are ready for Electron extraResources."
  Write-Host "Python receiver: $pythonFile"
  Write-Host "BAT launcher: $launcherFile"
}
finally {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
