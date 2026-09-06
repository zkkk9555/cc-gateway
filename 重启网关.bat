@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在重启 cc-gateway...
set /a tries=0
:killloop
rem 停止:整树击杀守护循环 + 击杀 3050 监听进程,直到端口空闲(最多 5 轮)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match '--bg' } | ForEach-Object { Write-Host ('stop daemon tree ' + $_.ProcessId); taskkill /PID $($_.ProcessId) /T /F | Out-Null } ; $p = Get-NetTCPConnection -LocalPort 3050 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { Write-Host ('stop gateway ' + $p); taskkill /PID $p /T /F | Out-Null } else { Write-Host 'no listener on 3050' }"
ping -n 2 127.0.0.1 >nul
netstat -ano 2>nul | findstr ":3050" | findstr "LISTEN" >nul 2>&1
if %errorlevel% neq 0 goto launch
set /a tries+=1
if %tries% lss 5 goto killloop
echo 停止失败,仍有进程占用 3050,请手动检查
exit /b 1
:launch
echo 正在启动(隐藏窗口守护)...
powershell -NoProfile -Command "Start-Process -FilePath '%~dp0启动网关.bat' -ArgumentList '--bg' -WindowStyle Hidden"
if "%~1" neq "--no-browser" start "" "http://127.0.0.1:3050/"
ping -n 3 127.0.0.1 >nul
netstat -ano 2>nul | findstr ":3050" | findstr "LISTEN" >nul 2>&1
if %errorlevel% equ 0 (echo 重启完成,网关已监听 3050) else (echo 网关启动中,稍候访问 http://127.0.0.1:3050/ )
exit /b 0
