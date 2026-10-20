<#
.SYNOPSIS
    Health and readiness probe for Collab Platform backend and dashboard.
#>

param(
    [string]$BackendHealthUrl = "http://127.0.0.1:4000/health",
    [string]$DashboardUrl = "http://127.0.0.1:5173",
    [int]$TimeoutSeconds = 30
)

$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$backendReady = $false
$dashboardReady = $false

Write-Host "Waiting for services to become ready (Timeout: ${TimeoutSeconds}s)..." -ForegroundColor Cyan

while ($stopwatch.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    if (-not $backendReady) {
        try {
            $resp = Invoke-RestMethod -Uri $BackendHealthUrl -Method Get -TimeoutSec 2 -ErrorAction Stop
            if ($resp.status -eq "ok") {
                $backendReady = $true
                Write-Host "  [+] Collab Backend is HEALTHY at $BackendHealthUrl" -ForegroundColor Green
            }
        } catch {
            # Still waiting
        }
    }

    if (-not $dashboardReady) {
        try {
            $resp = Invoke-WebRequest -Uri $DashboardUrl -Method Get -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                $dashboardReady = $true
                Write-Host "  [+] Web Dashboard is READY at $DashboardUrl" -ForegroundColor Green
            }
        } catch {
            # Still waiting
        }
    }

    if ($backendReady -and $dashboardReady) {
        $stopwatch.Stop()
        Write-Host "All services initialized successfully in $([math]::Round($stopwatch.Elapsed.TotalSeconds, 1))s." -ForegroundColor Green
        exit 0
    }

    Start-Sleep -Milliseconds 600
}

$stopwatch.Stop()
Write-Host ""
Write-Host "========================================================================" -ForegroundColor Red
Write-Host "[ERROR] Timeout waiting for services to initialize within ${TimeoutSeconds}s." -ForegroundColor Red
if (-not $backendReady) {
    Write-Host "  [-] Backend did not respond on $BackendHealthUrl" -ForegroundColor Yellow
}
if (-not $dashboardReady) {
    Write-Host "  [-] Dashboard did not respond on $DashboardUrl" -ForegroundColor Yellow
}
Write-Host "Please check the individual service terminal windows for error output." -ForegroundColor Red
Write-Host "========================================================================" -ForegroundColor Red
exit 1
