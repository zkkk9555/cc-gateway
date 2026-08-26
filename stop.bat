@echo off
echo Stopping cc-gateway...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3050 ^| findstr LISTENING') do (
    echo Killing PID %%a
    taskkill /PID %%a /F >nul 2>&1
)
echo Done.
timeout /t 2 >nul
