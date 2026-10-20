<#
.SYNOPSIS
    Pre-flight port availability and duplicate launch detection.
#>

param(
    [int]$BackendPort = 4000,
    [int]$FrontendPort = 5173
)

$backendConn = Get-NetTCPConnection -LocalPort $BackendPort -State Listen -ErrorAction SilentlyContinue
$frontendConn = Get-NetTCPConnection -LocalPort $FrontendPort -State Listen -ErrorAction SilentlyContinue

if ($backendConn -or $frontendConn) {
    # Probe to check if existing instance is already our Collab service
    $isCollab = $false
    try {
        $res = Invoke-RestMethod -Uri "http://127.0.0.1:${BackendPort}/health" -Method Get -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($res -and $res.service -eq "collab-server") {
            $isCollab = $true
        }
    } catch {
        # Not answering as collab-server
    }

    if ($isCollab) {
        Write-Host "ALREADY_RUNNING"
        exit 2
    } else {
        if ($backendConn) {
            Write-Host "CONFLICT_BACKEND_PORT_${BackendPort}"
        }
        if ($frontendConn) {
            Write-Host "CONFLICT_FRONTEND_PORT_${FrontendPort}"
        }
        exit 3
    }
}

Write-Host "PORTS_AVAILABLE"
exit 0
