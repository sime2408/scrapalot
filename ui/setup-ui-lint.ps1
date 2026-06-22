#!/usr/bin/env pwsh
<#
.SYNOPSIS
    PowerShell setup script for UI linting tools (Windows compatible)

.DESCRIPTION
    This script sets up the TypeScript/React linting environment on Windows systems.
    It handles package installation, pre-commit hooks, and initial configuration.

.PARAMETER Command
    The command to execute: setup, install, format, lint, check, fix, duplicates, unused, clean

.PARAMETER NoAutoCommit
    Disable automatic git staging and commit amendment

.EXAMPLE
    .\setup-ui-lint.ps1 setup              # Initial setup and configuration
    .\setup-ui-lint.ps1 install            # Install dependencies
    .\setup-ui-lint.ps1 format             # Format code with Prettier
    .\setup-ui-lint.ps1 lint               # Run all linting checks
    .\setup-ui-lint.ps1 check              # Check code quality (no fixes)
    .\setup-ui-lint.ps1 fix                # Auto-fix linting issues
    .\setup-ui-lint.ps1 duplicates         # Check for duplicate code
    .\setup-ui-lint.ps1 unused             # Check for unused imports
    .\setup-ui-lint.ps1 clean              # Clean temporary files
    .\setup-ui-lint.ps1 create-config      # Create configuration files
    .\setup-ui-lint.ps1 help               # Show help information
    .\setup-ui-lint.ps1 fix -NoAutoCommit  # Fix issues without auto-commit
#>

param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("setup", "install", "format", "lint", "check", "fix", "duplicates", "unused", "clean", "create-config", "help")]
    [string]$Command,

    [switch]$NoAutoCommit
)

# Set error handling
$ErrorActionPreference = "Continue"

# Colors for output
$Colors = @{
    Info = "Cyan"
    Success = "Green"
    Warning = "Yellow"
    Error = "Red"
}

function Write-Status {
    param(
        [string]$Message,
        [string]$Type = "Info"
    )

    $prefix = switch ($Type) {
        "Info" { "[*]" }
        "Success" { "[OK]" }
        "Warning" { "[WARN]" }
        "Error" { "[ERROR]" }
        default { "[*]" }
    }

    Write-Host "$prefix $Message" -ForegroundColor $Colors[$Type]
}

function Test-Command {
    param([string]$CommandName)

    try {
        Get-Command $CommandName -ErrorAction Stop | Out-Null
        return $true
    }
    catch {
        return $false
    }
}

function Invoke-UILintCommand {
    param(
        [string]$LintCommand,
        [switch]$PassNoAutoCommit
    )

    $args = @("ui_lint.js", $LintCommand)

    if ($PassNoAutoCommit -and $NoAutoCommit) {
        $args += "--no-auto-commit"
    }

    try {
        Write-Status "Running: node $($args -join ' ')" "Info"
        Write-Host "" # Add blank line for better readability
        
        # Execute with real-time output display
        & node @args
        $exitCode = $LASTEXITCODE
        
        Write-Host "" # Add blank line after command output
        return $exitCode -eq 0
    }
    catch {
        Write-Status "Failed to execute: node $($args -join ' ')" "Error"
        Write-Status "Error details: $($_.Exception.Message)" "Error"
        return $false
    }
}

function Install-Prerequisites {
    Write-Status "Checking prerequisites..." "Info"

    # Check for Node.js
    if (-not (Test-Command "node")) {
        Write-Status "Node.js is required but not installed." "Error"
        Write-Status "Please install Node.js from https://nodejs.org/" "Error"
        return $false
    }

    $nodeVersion = node --version
    Write-Status "Found Node.js version: $nodeVersion" "Success"

    # Check for package manager
    $packageManager = "npm"
    if (Test-Path "yarn.lock") {
        if (Test-Command "yarn") {
            $packageManager = "yarn"
            Write-Status "Detected yarn.lock and yarn command available" "Info"
        } else {
            Write-Status "Found yarn.lock but yarn not installed, using npm" "Warning"
        }
    }
    elseif (Test-Path "bun.lockb") {
        if (Test-Command "bun") {
            $packageManager = "bun"
            Write-Status "Detected bun.lockb and bun command available" "Info"
        } else {
            Write-Status "Found bun.lockb but bun not installed, using npm" "Warning"
            Write-Status "To install Bun: https://bun.sh/docs/installation" "Info"
        }
    }
    elseif (Test-Path "package-lock.json") {
        Write-Status "Detected package-lock.json, using npm" "Info"
    }

    Write-Status "Using package manager: $packageManager" "Info"

    # Check for Git
    if (-not (Test-Command "git")) {
        Write-Status "Git is required but not installed." "Error"
        Write-Status "Please install Git from https://git-scm.com/" "Error"
        return $false
    }

    Write-Status "All prerequisites satisfied" "Success"
    return $true
}

function Install-PythonPreCommit {
    Write-Status "Installing Python pre-commit (required for hooks)..." "Info"

    # Check if Python is available
    $pythonCmd = $null
    foreach ($py in @("python", "python3", "py")) {
        if (Test-Command $py) {
            $pythonCmd = $py
            break
        }
    }

    if (-not $pythonCmd) {
        Write-Status "Python is required for pre-commit hooks but not found." "Warning"
        Write-Status "Please install Python from https://python.org/" "Warning"
        Write-Status "Continuing without pre-commit hooks..." "Warning"
        return $false
    }

    try {
        & $pythonCmd -m pip install pre-commit
        Write-Status "Pre-commit installed successfully" "Success"
        return $true
    }
    catch {
        Write-Status "Failed to install pre-commit via pip" "Warning"
        Write-Status "You may need to install it manually: pip install pre-commit" "Warning"
        return $false
    }
}

function Test-UILintScript {
    if (-not (Test-Path "ui_lint.js")) {
        Write-Status "ui_lint.js not found in current directory" "Error"
        Write-Status "Please ensure you're running this script from the project root" "Error"
        return $false
    }
    return $true
}

# Main execution
Write-Status "UI Linting Setup Script for Windows" "Info"
Write-Status "=================================" "Info"

# Check if ui_lint.js exists
if (-not (Test-UILintScript)) {
    exit 1
}

# Install prerequisites for setup command
if ($Command -eq "setup") {
    if (-not (Install-Prerequisites)) {
        exit 1
    }

    # Install Python pre-commit
    Install-PythonPreCommit | Out-Null
}

# Execute the requested command
Write-Status "Executing command: $Command" "Info"

$success = switch ($Command) {
    "setup" {
        Invoke-UILintCommand "setup" -PassNoAutoCommit
    }
    "install" {
        Invoke-UILintCommand "install"
    }
    "format" {
        Invoke-UILintCommand "format"
    }
    "lint" {
        Invoke-UILintCommand "lint"
    }
    "check" {
        Invoke-UILintCommand "check"
    }
    "fix" {
        Invoke-UILintCommand "fix" -PassNoAutoCommit
    }
    "duplicates" {
        Invoke-UILintCommand "duplicates"
    }
    "unused" {
        Invoke-UILintCommand "unused"
    }
    "clean" {
        Invoke-UILintCommand "clean"
    }
    "create-config" {
        Invoke-UILintCommand "create-config"
    }
    "help" {
        Invoke-UILintCommand "help"
        $true
    }
    default {
        Write-Status "Unknown command: $Command" "Error"
        $false
    }
}

if ($success) {
    Write-Status "Command completed successfully" "Success"
    exit 0
} else {
    Write-Status "Command failed" "Error"
    exit 1
}
