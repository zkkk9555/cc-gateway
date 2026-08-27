@echo off
title cc-gateway
cd /d "%~dp0"
echo ========================================
echo   cc-gateway starting...
echo   Close this window to stop
echo   Ctrl+C to stop
echo   Auto-restart on crash
echo ========================================
echo.
:restart
node gateway.mjs
echo.
echo [%date% %time%] Process exited, restarting in 3s...
timeout /t 3 /nobreak >nul
goto restart
