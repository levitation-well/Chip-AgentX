@echo off
setlocal

title AgentX Server

set "HOST=127.0.0.1"
set "PORT=3000"

echo ========================================
echo   AgentX Server Starting...
echo ========================================
echo.
echo URL: http://%HOST%:%PORT%
echo Press Ctrl+C to stop
echo.

cd /d "%~dp0"

node bin\agentx server --host %HOST% --port %PORT%

echo.
echo Server stopped.
pause

endlocal
