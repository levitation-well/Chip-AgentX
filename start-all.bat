@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "HOST=127.0.0.1"
set "PORT=3002"
set "PROJECT_DIR=%~dp0"

echo ========================================
echo   AgentX Server Starting...
echo ========================================
echo.
echo URL: http://%HOST%:%PORT%
echo Project: %PROJECT_DIR%
echo.

where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] 'node' not found in PATH. Please install Node.js ^>= 20.
    pause
    exit /b 1
)

if not exist "%PROJECT_DIR%dist\cli\index.js" (
    echo [ERROR] dist/cli/index.js not found.
    echo Run: npm run build
    pause
    exit /b 1
)

echo [1/4] Checking port %PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% .*LISTENING" ^| findstr "127.0.0.1:%PORT%"') do (
    set "OLD_PID=%%a"
)

if defined OLD_PID (
    echo [WARN] Port %PORT% is in use by PID %OLD_PID%.
    echo        Attempting to stop the old server...

    taskkill /PID %OLD_PID% /F >nul 2>&1

    echo        Waiting for port to be released...
    for /L %%i in (1,1,10) do (
        netstat -ano ^| findstr ":%PORT% .*LISTENING" ^| findstr "127.0.0.1:%PORT%" >nul 2>&1
        if !ERRORLEVEL! neq 0 goto :port_cleared
        timeout /t 1 /nobreak >nul
    )

    netstat -ano ^| findstr ":%PORT% .*LISTENING" ^| findstr "127.0.0.1:%PORT%" >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        echo [ERROR] Could not free port %PORT%. Another process may be using it.
        echo        Try: taskkill /PID %OLD_PID% /F
        echo        Or close the 'AgentX Server' window manually.
        pause
        exit /b 1
    )
)

:port_cleared
echo [2/4] Port %PORT% is free.

echo [3/4] Starting server...
start "AgentX Server" cmd /k "cd /d "%PROJECT_DIR%" && node bin\agentx server --host %HOST% --port %PORT%"

echo [4/4] Waiting for server to start (5s)...
timeout /t 5 /nobreak >nul

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% .*LISTENING" ^| findstr "127.0.0.1:%PORT%"') do (
    echo Server started on PID %%a.
)

powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://%HOST%:%PORT%/sessions' -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop; Write-Host 'Health check: OK' } catch { Write-Host ('Health check: FAILED - ' + $_.Exception.Message) }"

echo.
echo Server is running at http://%HOST%:%PORT%/home
echo Opening browser...
start "" "http://%HOST%:%PORT%/home"

echo.
echo Done. Close the 'AgentX Server' window to stop the server.
pause
endlocal
