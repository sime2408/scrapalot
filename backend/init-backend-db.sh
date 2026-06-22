#!/bin/bash
# PostgreSQL Initialization Script for Scrapalot Backend
# Creates the 'scrapalot' schema required by Liquibase migrations

set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Create scrapalot schema
    CREATE SCHEMA IF NOT EXISTS scrapalot;

    -- Grant privileges to database user
    GRANT ALL PRIVILEGES ON SCHEMA scrapalot TO $POSTGRES_USER;

    -- Set search path to include scrapalot schema
    ALTER DATABASE $POSTGRES_DB SET search_path TO scrapalot, public;

    -- Log initialization
    SELECT 'Scrapalot Backend database initialized successfully' AS status;
EOSQL

echo "✓ Scrapalot Backend database initialized"
echo "  - Schema: scrapalot"
echo "  - User: $POSTGRES_USER"
echo "  - Database: $POSTGRES_DB"
