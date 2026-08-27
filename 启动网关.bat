@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem 双击时：以隐藏窗口重启自身
if not "%~1"==\"--bg\" (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '--bg' -WindowStyle Hidden"
  exit /b
)
rem ---- 以下在隐藏窗口内执行 ----
echo [%date% %time%] cc-gateway starting...
start "" "http://127.0.0.1:3050/"
:restart
node gateway.mjs
echo [%date% %time%] Process exited.
netstat -ano 2>nul | findstr ":3050" | findstr "LISTEN" >nul 2>&1
if %errorlevel% equ 0 (
  echo Port 3050 still in use, another instance running. Exiting.
  exit /b
)
echo Restarting in 3s...
timeout /t 3 /nobreak >nul
goto restart
