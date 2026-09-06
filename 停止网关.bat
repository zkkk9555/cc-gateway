@echo off
chcp 65001 >nul
echo 正在停止 cc-gateway (端口 3050)...
set /a tries=0
:killloop
rem 每轮:整树击杀守护循环(cmd --bg 连同 node 子进程)+ 击杀 3050 监听进程,直到端口空闲(最多 5 轮)
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'cc-gateway' -and $_.CommandLine -match '--bg' } | ForEach-Object { Write-Host ('stop daemon tree ' + $_.ProcessId); taskkill /PID $($_.ProcessId) /T /F | Out-Null } ; $p = Get-NetTCPConnection -LocalPort 3050 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { Write-Host ('stop gateway ' + $p); taskkill /PID $p /T /F | Out-Null } else { Write-Host 'no listener on 3050' }"
ping -n 2 127.0.0.1 >nul
netstat -ano 2>nul | findstr ":3050" | findstr "LISTEN" >nul 2>&1
if %errorlevel% neq 0 goto stopped
set /a tries+=1
if %tries% lss 5 goto killloop
echo 停止失败,仍有进程占用 3050,请手动检查
exit /b 1
:stopped
echo 网关已停止
ping -n 3 127.0.0.1 >nul
exit /b 0
