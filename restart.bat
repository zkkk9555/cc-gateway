@echo off
echo Restarting cc-gateway...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3050 ^| findstr LISTENING') do (
    taskkill /PID %%a /F >nul 2>&1
)
echo Old process stopped.
timeout /t 2 >nul
echo Starting cc-gateway...
cd /d "%~dp0"
start "" cmd /c "node gateway.mjs"
timeout /t 3 >nul
echo cc-gateway restarted.
