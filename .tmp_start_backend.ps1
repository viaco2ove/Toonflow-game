$wd = 'D:\Users\viaco\tools\Toonflow-game\toonflow-game-app'
$outLog = Join-Path $wd 'backend.local.out.log'
$errLog = Join-Path $wd 'backend.local.err.log'
if (Test-Path $outLog) { Remove-Item $outLog -Force }
if (Test-Path $errLog) { Remove-Item $errLog -Force }
$cmd = 'set NODE_ENV=local&& set PREFER_PROCESS_ENV=1&& set PORT=60000&& set OSSURL=http://127.0.0.1:60000/&& set DB_PATH=C:\Users\viaco\AppData\Roaming\Electron\db.sqlite&& set UPLOAD_DIR=C:\Users\viaco\AppData\Roaming\Electron\uploads&& node_modules\.bin\tsx.cmd src/app.ts'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmd -WorkingDirectory $wd -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Write-Output 'STARTED'
