#!/bin/bash
set -e

echo "Starting database initialization with user: $POSTGRES_USER, database: $POSTGRES_DB"

# Create additional databases if needed
psql -v ON_ERROR_STOP=0 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    -- Python backend database (RAG, AI, LLM)
    SELECT 'CREATE DATABASE scrapalot' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'scrapalot')\gexec
    GRANT ALL PRIVILEGES ON DATABASE scrapalot TO $POSTGRES_USER;

    -- Kotlin backend database (Auth, CRUD, Users, Workspaces, Collections, Notes, Settings)
    SELECT 'CREATE DATABASE scrapalot_backend' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'scrapalot_backend')\gexec
    GRANT ALL PRIVILEGES ON DATABASE scrapalot_backend TO $POSTGRES_USER;
EOSQL

# Create the vector extension in Python backend DB (use POSTGRES_USER since it has superuser-like perms from entrypoint)
psql -v ON_ERROR_STOP=0 --username "$POSTGRES_USER" --dbname "scrapalot" <<-EOSQL
    -- Enable pgvector extension for Python backend (needed for RAG embeddings)
    CREATE EXTENSION IF NOT EXISTS vector;
EOSQL

# Create scrapalot schema in Kotlin backend database
psql -v ON_ERROR_STOP=0 --username "$POSTGRES_USER" --dbname "scrapalot_backend" <<-EOSQL
    -- Create scrapalot schema for Kotlin backend (Liquibase will manage tables)
    CREATE SCHEMA IF NOT EXISTS scrapalot;
    GRANT ALL PRIVILEGES ON SCHEMA scrapalot TO $POSTGRES_USER;
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA scrapalot TO $POSTGRES_USER;
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA scrapalot TO $POSTGRES_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA scrapalot GRANT ALL ON TABLES TO $POSTGRES_USER;
    ALTER DEFAULT PRIVILEGES IN SCHEMA scrapalot GRANT ALL ON SEQUENCES TO $POSTGRES_USER;
EOSQL

echo "Database initialization completed successfully!"
echo "Created databases:"
echo "  - scrapalot (Python backend - RAG, AI, LLM)"
echo "  - scrapalot_backend (Kotlin backend - Auth, CRUD, Users)"
