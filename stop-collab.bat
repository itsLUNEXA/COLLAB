@echo off
setlocal enabledelayedexpansion

title Stop Collaborative Platform
echo ========================================================================
echo Stopping Collaborative Platform Services...
echo ========================================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-services.ps1"

echo ========================================================================
echo Done. You may close this window.
echo ========================================================================
if "%1" neq "--nopause" pause
