@echo off
setlocal enabledelayedexpansion

:: Set current directory to project root
cd /d "%~dp0"

title Collaborative AI Coding Platform - Launcher

echo ========================================================================
echo   COLLABORATIVE AI CODING PLATFORM - ONE-CLICK LAUNCHER
echo ========================================================================
echo.

:: 1. Check Node.js in PATH
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js was not found in your system PATH.
    echo Please install Node.js version 20.0.0 or higher from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: 2. Check npm in PATH
where npm >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm was not found in your system PATH.
    echo Please ensure npm is installed alongside Node.js.
    echo.
    pause
    exit /b 1
)

:: 3. Check node version - Node 20+
for /f "tokens=1" %%v in ('node -v') do set NODE_VERSION=%%v
echo [CHECK] Detected Node.js: !NODE_VERSION!

:: 4. Check dependencies installed
if not exist "node_modules\" (
    echo [INFO] Dependencies not found. Installing workspace packages...
    call npm install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Failed to install npm dependencies. Check your network or permissions.
        pause
        exit /b 1
    )
)

:: 5. Ensure backend is built
if not exist "services\collab-server\dist\server.js" (
    echo [INFO] Backend build artifacts not found. Compiling TypeScript packages...
    call npm run build
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] TypeScript compilation failed. Fix compilation errors before launching.
        pause
        exit /b 1
    )
)

:: 6. Check Environment and Database Mode
set DB_MODE=IN-MEMORY [Development Mode]
set DB_IS_DURABLE=0

if exist ".env" (
    findstr /i "DATABASE_URL" .env >nul 2>&1
    if !ERRORLEVEL! equ 0 (
        set DB_MODE=PostgreSQL [Durable]
        set DB_IS_DURABLE=1
        echo [CONFIG] .env loaded with PostgreSQL persistence configured.
    ) else (
        echo [CONFIG] .env found but DATABASE_URL is not set.
    )
)

if !DB_IS_DURABLE! equ 0 (
    echo [NOTICE] -------------------------------------------------------------
    echo   Running with IN-MEMORY storage [Development Mode].
    echo   WARNING: Changes and events will NOT persist across server restarts.
    echo   To enable durable PostgreSQL storage, configure DATABASE_URL in .env
    echo ---------------------------------------------------------------------
)

:: 7. Check Ports (4000 for backend, 5173 for dashboard)
echo [CHECK] Checking port availability (Backend: 4000, Dashboard: 5173)...
for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\check-ports.ps1"') do set PORT_STATUS=%%i

if "!PORT_STATUS!"=="ALREADY_RUNNING" (
    echo.
    echo [WARNING] Collaborative Platform services are ALREADY RUNNING!
    echo   Dashboard: http://127.0.0.1:5173
    echo   Backend:   http://127.0.0.1:4000/health
    echo.
    echo Opening dashboard in default browser...
    start http://127.0.0.1:5173
    echo To stop running services, run: stop-collab.bat
    echo.
    if "%1" neq "--nopause" if "%1" neq "--non-interactive" pause
    exit /b 0
)

if "!PORT_STATUS!"=="CONFLICT_BACKEND_PORT_4000" (
    echo.
    echo [ERROR] Port 4000 is occupied by another process.
    echo Please terminate the conflicting process or run stop-collab.bat before restarting.
    echo.
    pause
    exit /b 1
)

if "!PORT_STATUS!"=="CONFLICT_FRONTEND_PORT_5173" (
    echo.
    echo [ERROR] Port 5173 is occupied by another process.
    echo Please terminate the conflicting process or run stop-collab.bat before restarting.
    echo.
    pause
    exit /b 1
)

:: 8. Start Services in Separate Terminals
echo.
echo [START] Launching Collab Backend Server (Port 4000)...
start "Collab Backend Server [Port 4000]" /D "%~dp0" cmd /k "npm run --workspace=@collab/collab-server start"

echo [START] Launching Collab Web Dashboard (Port 5173)...
start "Collab Web Dashboard [Port 5173]" /D "%~dp0" cmd /k "npm run --workspace=@collab/dashboard dev"

:: 9. Wait for Health Probe and Readiness
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\wait-for-services.ps1" -BackendHealthUrl "http://127.0.0.1:4000/health" -DashboardUrl "http://127.0.0.1:5173" -TimeoutSeconds 35
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] One or more services failed readiness checks within the timeout.
    echo Please review the service console windows for stack traces or error logs.
    echo.
    pause
    exit /b 1
)

:: 10. Open Browser & Print Summary
start http://127.0.0.1:5173

echo.
echo ========================================================================
echo   COLLABORATIVE AI CODING PLATFORM IS ONLINE!
echo ========================================================================
echo.
echo   Web Dashboard:      http://127.0.0.1:5173
echo   Backend Health:     http://127.0.0.1:4000/health
echo   WebSocket Gateway:  ws://127.0.0.1:4000/ws
echo   Database Storage:   !DB_MODE!
echo.
echo   Service terminal windows are running in the background. Keep them open.
echo   To safely stop all services, run: stop-collab.bat
echo ========================================================================
echo.
if "%1" neq "--nopause" if "%1" neq "--non-interactive" (
    echo Press any key to exit this launcher window - services will remain running.
    pause >nul
)
exit /b 0
