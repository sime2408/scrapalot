#!/bin/bash
# Initialization script to create test API key on container startup
# This ensures API key persists across container restarts

set -e

echo "==================================================================="
echo "Scrapalot Test API Key Initialization"
echo "==================================================================="

# Wait for PostgreSQL to be ready
echo "[1/3] Waiting for PostgreSQL to be ready..."
until pg_isready -h pgvector -p 5432 -U scrapalot; do
  echo "  PostgreSQL is unavailable - sleeping"
  sleep 2
done
echo "  ✓ PostgreSQL is ready"

# Wait for migrations to complete
echo "[2/3] Waiting for database migrations..."
sleep 10
echo "  ✓ Migrations should be complete"

# Run the Python script to create/verify API key
echo "[3/3] Creating/verifying test API key..."
export POSTGRES_HOST=pgvector
export POSTGRES_PORT=5432
python /app/tests/create_test_api_key.py

echo "==================================================================="
echo "Test API Key Initialization Complete"
echo "==================================================================="
