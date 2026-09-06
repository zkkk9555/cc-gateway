@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem ── cc-gateway 启动脚本(守护模式)──
rem 已在运行 → 提示并直接打开管理面板
netstat -ano 2>nul | findstr ":3050" | findstr "LISTEN" >nul 2>&1
if %errorlevel% equ 0 (
  echo cc-gateway 已在运行,直接打开管理面板...
  if "%~1" neq "--no-browser" start "" "http://127.0.0.1:3050/"
  ping -n 3 127.0.0.1 >nul
  exit /b 0
)
rem 未运行 → 以隐藏窗口重启自身进入守护循环(--no-browser 供自动化测试)
if "%~1" neq "--bg" (
  if "%~1" neq "--no-browser" start "" "http://127.0.0.1:3050/"
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '--bg' -WindowStyle Hidden"
  exit /b
)
rem ---- 以下为隐藏守护窗口:进程退出后自动拉起 ----
echo [%date% %time%] cc-gateway starting...
:restart
node gateway.mjs
echo [%date% %time%] Process exited.
netstat -ano 2>nul | findstr ":3050" | findstr "LISTEN" >nul 2>&1
if %errorlevel% equ 0 (
  echo Port 3050 still in use, another instance running. Exiting.
  exit /b
)
echo Restarting in 3s...
ping -n 4 127.0.0.1 >nul
goto restart
