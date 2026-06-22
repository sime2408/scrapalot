#!/bin/bash
# Creates the second database used by the Kotlin backend. The first (scrapalot, for the
# Python AI backend) is created by POSTGRES_DB. Runs once on first cluster init.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    SELECT 'CREATE DATABASE scrapalot_backend'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'scrapalot_backend')\gexec
EOSQL
echo "init-databases: ensured 'scrapalot' and 'scrapalot_backend' exist"
