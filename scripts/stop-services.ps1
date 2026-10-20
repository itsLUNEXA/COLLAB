<#
.SYNOPSIS
    Gracefully stops Collab Backend and Dashboard processes by port detection.
#>

param(
    [int[]]$Ports = @(4000, 5173)
)

Write-Host "Stopping Collaborative Platform services on ports $($Ports -join ', ')..." -ForegroundColor Cyan

$stoppedCount = 0

foreach ($port in $Ports) {
    try {
        $connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($connections) {
            $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
            foreach ($procId in $pids) {
                if ($procId -and $procId -ne 0) {
                    try {
                        $proc = Get-Process -Id $procId -ErrorAction Stop
                        Write-Host "  Stopping process $($proc.ProcessName) (PID: $procId) on port $port..." -ForegroundColor Yellow
                        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
                        $stoppedCount++
                    } catch {
                        Write-Warning "Failed to stop process PID $procId : $_"
                    }
                }
            }
        } else {
            Write-Host "  [OK] No service listening on port $port" -ForegroundColor DarkGray
        }
    } catch {
        Write-Warning "Could not query port $port : $_"
    }
}

# Also stop any running companion daemon processes
try {
    $companions = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and ($_.CommandLine -like "*companion*cli.js*" -or $_.CommandLine -like "*collab-companion*")
    }
    foreach ($comp in $companions) {
        Write-Host "  Stopping Companion Daemon (PID: $($comp.ProcessId))..." -ForegroundColor Yellow
        Stop-Process -Id $comp.ProcessId -Force -ErrorAction SilentlyContinue
        $stoppedCount++
    }
} catch {
    # Ignore CIM errors if any
}

if ($stoppedCount -gt 0) {
    Write-Host "Successfully stopped $stoppedCount process(es)." -ForegroundColor Green
} else {
    Write-Host "No running Collab services found." -ForegroundColor Gray
}
