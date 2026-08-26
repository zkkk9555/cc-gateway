@echo off
title cc-gateway
cd /d "%~dp0"
echo ========================================
echo   cc-gateway starting...
echo   Close this window to stop
echo   Press Ctrl+C to stop
echo ========================================
echo.
node gateway.mjs
pause
