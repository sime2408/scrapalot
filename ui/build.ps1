# Production build and deploy script for scrapalot.app
$ErrorActionPreference = "Stop"

# Get the directory where this script is located
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$UIPath = $ScriptDir
$BackendStaticPath = Join-Path (Split-Path -Parent $ScriptDir) "scrapalot-chat\static"
$DistPath = Join-Path $UIPath "dist"

Write-Host "Building for production deployment..." -ForegroundColor Green
Write-Host "UI Path: $UIPath" -ForegroundColor Cyan
Write-Host "Backend Static Path: $BackendStaticPath" -ForegroundColor Cyan

Set-Location $UIPath

# Clean previous build
if (Test-Path $DistPath) {
    Remove-Item -Path $DistPath -Recurse -Force
    Write-Host "Cleaned previous build" -ForegroundColor Yellow
}

# Set NODE_ENV and build for production
Write-Host "Running production build..." -ForegroundColor Cyan
$env:NODE_ENV = "production"
npm run build

if ($LASTEXITCODE -eq 0) {
    Write-Host "Build successful! Deploying to backend static folder..." -ForegroundColor Green
    
    # Clean backend static folder
    if (Test-Path $BackendStaticPath) {
        Remove-Item -Path "$BackendStaticPath\*" -Recurse -Force
        Write-Host "Cleaned backend static folder" -ForegroundColor Yellow
    }
    
    # Copy built files
    Copy-Item -Path "$DistPath\*" -Destination $BackendStaticPath -Recurse -Force
    Write-Host "Production deploy completed successfully!" -ForegroundColor Green
    Write-Host "Frontend will use API URL: https://scrapalot.app/api/v1" -ForegroundColor Cyan
} else {
    Write-Host "Build failed!" -ForegroundColor Red
    exit 1
}
