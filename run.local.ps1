$ErrorActionPreference = "Stop"

chcp 65001 | Out-Null
[Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8
$OutputEncoding = [Console]::OutputEncoding

if (-not $env:NODE_ENV) { $env:NODE_ENV = "local" }
$env:PREFER_PROCESS_ENV = "1"
if (-not $env:PORT) { $env:PORT = "60002" }
if (-not $env:OSSURL) { $env:OSSURL = "http://127.0.0.1:$($env:PORT)/" }

$newDbPath = Join-Path $env:APPDATA "Toonflow\db.sqlite"
$newUploadDir = Join-Path $env:APPDATA "Toonflow\uploads"
$legacyDbPath = Join-Path $env:APPDATA "Electron\db.sqlite"
$legacyUploadDir = Join-Path $env:APPDATA "Electron\uploads"

if (-not $env:DB_PATH) {
  if (Test-Path $legacyDbPath) {
    $env:DB_PATH = $legacyDbPath
    Write-Host "[win-run] detected legacy DB, reusing: $legacyDbPath"
  } elseif (Test-Path $newDbPath) {
    $env:DB_PATH = $newDbPath
  } else {
    $env:DB_PATH = $newDbPath
  }
}

if (-not $env:UPLOAD_DIR) {
  if (Test-Path $legacyUploadDir) {
    $env:UPLOAD_DIR = $legacyUploadDir
    Write-Host "[win-run] detected legacy uploads, reusing: $legacyUploadDir"
  } elseif (Test-Path $newUploadDir) {
    $env:UPLOAD_DIR = $newUploadDir
  } else {
    $env:UPLOAD_DIR = $newUploadDir
  }
}

Write-Host "[win-run] NODE_ENV=$($env:NODE_ENV)"
Write-Host "[win-run] PORT=$($env:PORT)"
Write-Host "[win-run] DB_PATH=$($env:DB_PATH)"
Write-Host "[win-run] UPLOAD_DIR=$($env:UPLOAD_DIR)"

yarn local:gui
