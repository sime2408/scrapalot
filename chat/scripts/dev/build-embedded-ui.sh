#!/bin/bash

# Build and embed UI script for standalone deployment
# This script builds the React UI and copies it to the backend static folder

set -e  # Exit on any error

echo "🚀 Building embedded UI for standalone deployment..."

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(dirname "$SCRIPT_DIR")"
UI_DIR="$(dirname "$BACKEND_DIR")/scrapalot-ui"
STATIC_DIR="$BACKEND_DIR/static"

echo "📁 Directories:"
echo "   Backend: $BACKEND_DIR"
echo "   UI: $UI_DIR"
echo "   Static: $STATIC_DIR"

# Check if UI directory exists
if [ ! -d "$UI_DIR" ]; then
    echo "❌ UI directory not found: $UI_DIR"
    exit 1
fi

# Navigate to UI directory and build
echo "📦 Building React UI..."
cd "$UI_DIR"

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📥 Installing UI dependencies..."
    npm install
fi

# Build the UI
echo "🔨 Building production UI..."
npm run build

# Create static directory if it doesn't exist
if [ ! -d "$STATIC_DIR" ]; then
    echo "📁 Creating static directory..."
    mkdir -p "$STATIC_DIR"
fi

# Clean existing static files
echo "🧹 Cleaning existing static files..."
rm -rf "$STATIC_DIR"/*

# Copy built UI to static directory
echo "📋 Copying UI build to static directory..."
cp -r "$UI_DIR/dist/"* "$STATIC_DIR/"

echo "UI successfully embedded into backend!"
echo "📊 Static directory contents:"
ls -la "$STATIC_DIR"

echo ""
echo "🎉 Embedded UI build complete!"
echo "   The backend now contains the complete UI and can be deployed as a standalone application."
echo "   Start the backend server and access the UI at: http://localhost:8090"
