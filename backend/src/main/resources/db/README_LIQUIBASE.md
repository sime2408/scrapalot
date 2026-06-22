# Liquibase Database Migrations - Scrapalot Backend

## Overview

This directory contains Liquibase database migrations for the Scrapalot Spring Boot backend. The migrations are based on the Alembic migrations from the Python backend (`scrapalot-chat`) to maintain schema compatibility.

## Directory Structure

```
db/
├── README_LIQUIBASE.md          # This file
├── changelog/
│   ├── db.changelog-master.yaml # Master changelog (includes all migrations)
│   └── changes/                 # Individual migration changesets
│       ├── 001-initial-schema-users.yaml
│       ├── 002-initial-schema-workspaces.yaml
│       ├── 003-initial-schema-collections.yaml
│       ├── 004-initial-schema-documents.yaml
│       ├── 005-initial-schema-sessions.yaml
│       ├── 006-initial-schema-messages.yaml
│       ├── 007-initial-schema-settings.yaml
│       ├── 008-initial-schema-jobs.yaml
│       ├── 010-ai-providers.yaml (stub)
│       ├── 020-connectors.yaml (stub)
│       ├── 021-notes-collaboration.yaml
│       └── 030-seed-data.yaml (stub)
```

## Configuration

### application.yaml

```yaml
spring:
  jpa:
    hibernate:
      ddl-auto: validate  # Liquibase manages schema, Hibernate validates

  liquibase:
    enabled: true
    change-log: classpath:/db/changelog/db.changelog-master.yaml
    default-schema: scrapalot
    liquibase-schema: public  # Where Liquibase metadata tables live
    drop-first: false  # DANGER: Only set to true in development
    contexts: dev,prod
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LIQUIBASE_ENABLED` | `true` | Enable/disable Liquibase |
| `HIBERNATE_DDL_AUTO` | `validate` | Hibernate schema validation mode |
| `LIQUIBASE_DEFAULT_SCHEMA` | `scrapalot` | Default schema for migrations |
| `LIQUIBASE_SCHEMA` | `public` | Schema for Liquibase metadata tables |
| `LIQUIBASE_DROP_FIRST` | `false` | Drop all objects before running migrations (dev only!) |
| `LIQUIBASE_CONTEXTS` | `dev,prod` | Active contexts for conditional migrations |

## Migration Naming Convention

Migrations follow this naming pattern:

```
NNN-description.yaml
```

- `000-099`: Core schema (matching Alembic 00001)
- `100-199`: Extensions and features (matching Alembic 00002-00004)
- `900-999`: Spring Boot specific tables (if needed)

## Alembic Compatibility

This Liquibase setup mirrors the Alembic migrations from the Python backend:

| Alembic Migration | Liquibase Changesets | Tables |
|-------------------|----------------------|--------|
| `00001_initial_schema.py` | `001-008` | users, workspaces, collections, documents, sessions, messages, settings, jobs |
| `00002_ai_providers.py` | `010` (stub) | model_providers, model_provider_models |
| `00003_subscriptions_billing.py` | N/A | Python-only |
| `00004_connectors_notes.py` | `020-021` | connectors (stub), notes (full) |
| `00005_rag_vectors.py` | N/A | Python-only (pgvector) |
| `00006_indexes.py` | N/A | Python-only |
| `00007_seed_data.py` | `030` (stub) | Seed data |

## Running Migrations

### Automatically on Startup

Migrations run automatically when the Spring Boot application starts (if `LIQUIBASE_ENABLED=true`).

### Manually with Liquibase CLI

```bash
# Update database to latest version
liquibase update

# Show pending changesets
liquibase status

# Generate SQL without executing
liquibase updateSQL

# Rollback last changeset
liquibase rollback --count=1

# Rollback to specific tag
liquibase rollback --tag=v1.0.0
```

### Using Gradle Plugin

Add to `build.gradle.kts`:

```kotlin
plugins {
    id("org.liquibase.gradle") version "2.2.0"
}

liquibase {
    activities.register("main") {
        arguments = mapOf(
            "changeLogFile" to "src/main/resources/db/changelog/db.changelog-master.yaml",
            "url" to "jdbc:postgresql://localhost:5432/scrapalot_backend",
            "username" to "scrapalot",
            "password" to "scrapalot123",
            "defaultSchemaName" to "scrapalot"
        )
    }
}
```

Then run:

```bash
./gradlew update
./gradlew status
./gradlew rollback -PliquibaseCommandValue=1
```

## Creating New Migrations

### Step 1: Create Changeset File

Create a new YAML file in `changes/` directory:

```yaml
# Migration NNN: Description
# Purpose: What this migration does

databaseChangeLog:
  - changeSet:
      id: NNN-create-my-table
      author: your-name
      labels: feature,category
      preConditions:
        - onFail: MARK_RAN
        - not:
            - tableExists:
                schemaName: scrapalot
                tableName: my_table
      changes:
        - createTable:
            schemaName: scrapalot
            tableName: my_table
            columns:
              - column:
                  name: id
                  type: UUID
                  constraints:
                    primaryKey: true
              # ... more columns

      rollback:
        - dropTable:
            schemaName: scrapalot
            tableName: my_table
```

### Step 2: Add to Master Changelog

Edit `db.changelog-master.yaml`:

```yaml
- include:
    file: db/changelog/changes/NNN-description.yaml
    context: dev,prod
```

### Step 3: Test Migration

```bash
# Start application and check logs
./gradlew bootRun

# Or run Liquibase directly
liquibase status
liquibase update
```

## Best Practices

### 1. Always Include Rollback

```yaml
changes:
  - createTable: ...

rollback:
  - dropTable: ...
```

### 2. Use Preconditions

```yaml
preConditions:
  - onFail: MARK_RAN
  - not:
      - tableExists:
          tableName: my_table
```

### 3. Schema-Aware Table Names

Always use `schemaName: scrapalot` for application tables.

### 4. Contexts for Environment-Specific Migrations

```yaml
changeSet:
  id: dev-only-seed-data
  context: dev  # Only runs in development
```

### 5. Labels for Organization

```yaml
changeSet:
  labels: core,users  # Helps filter and organize migrations
```

## Troubleshooting

### Migration Failed Midway

Liquibase tracks changesets in `databasechangelog` table. If a migration fails:

```sql
-- View applied changesets
SELECT * FROM public.databasechangelog ORDER BY dateexecuted DESC;

-- View locked changesets
SELECT * FROM public.databasechangeloglock;

-- Release lock (if stuck)
UPDATE public.databasechangeloglock SET locked = FALSE;
```

### Reset Liquibase State (Development Only)

```sql
-- DANGER: Deletes all migration history
DROP TABLE public.databasechangelog CASCADE;
DROP TABLE public.databasechangeloglock CASCADE;

-- Liquibase will recreate tables and run all migrations on next startup
```

### Rollback a Specific Changeset

```bash
# Rollback by count
liquibase rollback --count=1

# Rollback to specific date
liquibase rollback --date=2025-12-01

# Rollback to tag
liquibase rollback --tag=v1.0.0
```

## Database Compatibility

This Liquibase setup supports:

- **PostgreSQL 12+** (primary target)
- **SQLite** (limited support, see notes below)

### PostgreSQL-Specific Features

- JSONB columns
- UUID type with `gen_random_uuid()`
- Schema support (`scrapalot` schema)
- Advanced indexing (GiST, GIN)

### SQLite Compatibility Notes

To support SQLite (for testing):

- Replace `JSONB` with `TEXT`
- Replace `UUID` with `TEXT`
- Replace `TIMESTAMP WITH TIME ZONE` with `TEXT`
- Remove schema prefixes

Use Liquibase contexts to handle database-specific migrations:

```yaml
- changeSet:
    id: postgres-only-feature
    dbms: postgresql
    changes: ...
```

## Monitoring

### Check Migration Status

```sql
-- View all applied migrations
SELECT id, author, filename, dateexecuted, orderexecuted
FROM public.databasechangelog
ORDER BY dateexecuted DESC;

-- Count applied changesets
SELECT COUNT(*) FROM public.databasechangelog;
```

### Application Logs

```
INFO  liquibase.changelog : Reading from scrapalot.databasechangelog
INFO  liquibase.lockservice : Successfully acquired change log lock
INFO  liquibase.changelog : ChangeSet db/changelog/changes/001-initial-schema-users.yaml::001-create-users-table::liquibase-auto ran successfully
...
```

## References

- [Liquibase Documentation](https://docs.liquibase.com/)
- [Liquibase Best Practices](https://docs.liquibase.com/concepts/bestpractices.html)
- [Spring Boot Liquibase Integration](https://docs.spring.io/spring-boot/docs/current/reference/html/howto.html#howto.data-initialization.migration-tool)
- [Alembic Migrations](../../../../../scrapalot-chat/alembic/versions/) - Python backend reference

## Version History

- **v1.0.0** (2025-12-07): Initial Liquibase setup based on Alembic migrations
  - Core schema migrations (001-008)
  - Notes collaboration (021)
  - Stub files for AI providers, connectors, seed data
