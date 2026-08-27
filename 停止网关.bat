@echo off
chcp 65001 >nul
echo 正在停止 cc-gateway (端口 3050)...
powershell -NoProfile -Command "$p = Get-NetTCPConnection -LocalPort 3050 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force; Write-Host ('已停止 PID ' + $p) } else { Write-Host '3050 端口无进程' }"
echo.
echo 网关已关闭，5 秒后自动退出
for /l %%i in (5,-1,1) do (
  echo   %%i ...
  ping -n 2 127.0.0.1 >nul
)
exit
