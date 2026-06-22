# Function to kill processes by port number
function Kill-ProcessByPort {
    param(
        [Parameter(Mandatory=$true)]
        [int]$Port
    )

    $processInfo = netstat -ano | Select-String -Pattern "(:$Port)"

    if ($processInfo) {
        $processId = ($processInfo | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -Unique)

        foreach ($processIdValue in $processId) {
            if ($processIdValue -match '^\d+$') {
                $process = Get-Process -Id $processIdValue -ErrorAction SilentlyContinue
                if ($process) {
                    Write-Host "Killing process $($process.Name) (ID: $processIdValue) on port $Port"
                    Stop-Process -Id $processIdValue -Force
                }
            }
        }
    } else {
        Write-Host "No process found using port $Port"
    }
}

# Kill Python processes running run_service.py
Write-Host "Killing Python processes running run_service.py..."
Get-Process -Name python | Where-Object {$_.CommandLine -like '*run_service.py*'} | ForEach-Object {
    Write-Host "Killing process: $($_.Id) - $($_.CommandLine)"
    $_ | Stop-Process -Force
}

# Kill processes on specific ports
Kill-ProcessByPort -Port 8090
Kill-ProcessByPort -Port 8091

Write-Host "Process cleanup completed."
