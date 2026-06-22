# Alembic Migrations Guide

This directory contains database migrations for the Scrapalot backend. Migrations are managed using [Alembic](https://alembic.sqlalchemy.org/).

## Migration Numbering System

This project uses **sequential numeric revision IDs** (001, 002, 003, etc.) instead of Alembic's default hash-based IDs.

**File naming convention**: `NNN_description.py`
- `001_initial_schema.py`
- `002_ai_providers.py`
- `012_remove_soft_delete_from_notes.py`

**Revision IDs**: `'001'`, `'002'`, `'012'`, etc.

## Creating New Migrations

### ALWAYS Use the Helper Script

**IMPORTANT**: Always use `create_migration.py` instead of `alembic revision` to ensure sequential numbering!

```bash
# Create an empty migration template
python alembic/create_migration.py "Add user preferences table"

# Create a migration with autogenerate
python alembic/create_migration.py "Update document schema" --autogenerate
```

The script will:
1. Find the latest migration number (e.g., 019)
2. Create the next migration (e.g., 020)
3. Use proper filename: `020_add_user_preferences_table.py`
4. Set revision IDs: `revision='020'`, `down_revision='019'`

### ❌ Don't Use These Commands

```bash
# ❌ BAD: Generates random hash IDs (e.g., '63c1b149562b')
alembic revision -m "description"
alembic revision --autogenerate -m "description"
```

**Why not use `alembic revision`?**
- Alembic generates random hash-based revision IDs by default
- This project uses sequential numbers (001, 002, 003...) for better organization
- The `process_revision_directives` hook in `env.py` only works during migration execution, not file generation
- Using `create_migration.py` ensures proper numbering every time

## Applying Migrations

```bash
# Apply all pending migrations
alembic upgrade head

# Apply one migration at a time
alembic upgrade +1

# Rollback one migration
alembic downgrade -1

# Rollback to specific version
alembic downgrade 010
```

## Checking Migration Status

```bash
# Show current migration version
alembic current

# Show migration history
alembic history

# Show pending migrations
alembic history --verbose
```

## Why Database Gets Out of Sync

The database schema can become out of sync with your models when:

### 1. **Migrations Not Applied**
- New migration files exist but haven't been run
- Running on a different database (dev vs prod)
- Fresh database that needs all migrations applied

**Solution**: Always run `alembic upgrade head` after pulling new code

### 2. **Model Changes Without Migrations**
- You modify a model in `src/main/models/`
- But forget to create a migration file
- SQLAlchemy expects columns that don't exist in the database

**Solution**: Create a migration after every model change

### 3. **Manual Database Changes**
- Direct SQL changes to the database
- Schema modifications outside of Alembic
- Database restored from an old backup

**Solution**: Always use migrations for schema changes

### 4. **Inheritance Issues** (like we just fixed!)
- Models inherit fields from `BaseModel` (like `created_at`, `updated_at`)
- But migrations don't create all inherited columns
- Example: `NoteVersion` inherited `updated_at` from `BaseModel`, but migration 004 only created `created_at`

**Solution**:
- Explicitly override inherited fields if they shouldn't exist in DB
- Or ensure migrations create all inherited columns

## Autogenerate Safety Features

The `env.py` file now includes safety checks to prevent destructive autogenerate operations:

### Safety Check #1: Drop Operation Limit
If autogenerate detects **more than 5 DROP operations**, it will:
1. ❌ Block the migration from being created
2. ⚠️ Show a detailed warning with recommended actions
3. 🛑 Raise an error explaining the issue

**Why?** Many DROP operations usually mean the database is significantly out of sync, not that you actually want to drop tables.

### Safety Check #2: Table Filtering
The `include_object` function filters out:
- `spatial_ref_sys` (PostGIS system table)
- `alembic_version` (Alembic's own table)

This prevents autogenerate from trying to manage tables it shouldn't.

### What to Do If Autogenerate is Blocked

```bash
# 1. Check current migration status
alembic current

# 2. Apply any pending migrations
alembic upgrade head

# 3. Now retry autogenerate
python alembic/create_migration.py "Your description" --autogenerate
```

If you genuinely need to drop many tables, create a **manual migration** instead of using autogenerate.

## Common Migration Patterns

### Adding a Column

```python
def upgrade() -> None:
    op.add_column('notes',
        sa.Column('priority', sa.Integer(), nullable=True)
    )

def downgrade() -> None:
    op.drop_column('notes', 'priority')
```

### Removing a Column

```python
def upgrade() -> None:
    op.drop_column('notes', 'is_deleted')
    op.drop_column('notes', 'deleted_at')

def downgrade() -> None:
    op.add_column('notes',
        sa.Column('is_deleted', sa.Boolean(),
                  server_default=sa.text("'false'"), nullable=False)
    )
    op.add_column('notes',
        sa.Column('deleted_at', sa.DateTime(), nullable=True)
    )
```

### Creating a Table

```python
def upgrade() -> None:
    op.create_table(
        'user_preferences',
        sa.Column('id', sa.String(36), nullable=False),
        sa.Column('user_id', sa.String(36), nullable=False),
        sa.Column('preference_key', sa.String(100), nullable=False),
        sa.Column('preference_value', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )

def downgrade() -> None:
    op.drop_table('user_preferences')
```

## Cross-Database Compatibility

Use the helpers in `alembic/db_utils.py` for cross-database compatibility:

```python
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent))
import db_utils

def upgrade() -> None:
    dialect_info = db_utils.get_dialect_info()

    # Create UUID column (works in both PostgreSQL and SQLite)
    uuid_col = db_utils.create_uuid_column("id", primary_key=True)

    # Create datetime column
    dt_col = db_utils.create_datetime_column("created_at")

    # Get JSON column type
    json_type = db_utils.get_json_column_type()

    # Check if table exists before creating
    if not db_utils.table_exists("my_table"):
        op.create_table(
            db_utils.get_table_name("my_table"),
            uuid_col,
            dt_col,
            sa.Column("data", json_type, nullable=True)
        )
```

## Best Practices

1. **Always test migrations both ways**
   ```bash
   alembic upgrade +1   # Test upgrade
   alembic downgrade -1 # Test downgrade
   alembic upgrade +1   # Apply again
   ```

2. **Review autogenerated migrations**
   - Autogenerate is helpful but not perfect
   - Always review and edit the generated migration
   - Add data migrations if needed

3. **One migration per logical change**
   - Don't combine unrelated schema changes
   - Makes rollbacks safer and more granular

4. **Test with both PostgreSQL and SQLite**
   - Use `db_utils.py` helpers for compatibility
   - Test migrations against both databases

5. **Never edit applied migrations**
   - Once a migration is applied to any database, don't edit it
   - Create a new migration to fix issues

## Troubleshooting

### "SQLALCHEMY_WARN_20" warnings
These are harmless SQLAlchemy 2.0 compatibility warnings. Ignore them.

### "Table already exists" error
The migration was already partially applied. Options:
- Rollback and try again: `alembic downgrade -1`
- Mark migration as applied: `alembic stamp head`
- Manually fix the database schema

### "Column does not exist" error during model loading
The database schema doesn't match the models. Usually means:
1. Migrations haven't been applied: Run `alembic upgrade head`
2. Model has fields that the migration didn't create
3. Model inherits fields from `BaseModel` that aren't in the database

### Autogenerate creates too many changes
The database is out of sync. Run `alembic upgrade head` first.

## Related Files

- `alembic.ini` - Alembic configuration
- `env.py` - Migration environment setup
- `db_utils.py` - Cross-database compatibility helpers
- `create_migration.py` - Helper script for creating migrations
- `versions/` - Migration files
- `script.py.mako` - Template for new migrations (if customized)

## See Also

- [Alembic Documentation](https://alembic.sqlalchemy.org/)
- [SQLAlchemy Documentation](https://www.sqlalchemy.org/)
- Project backend docs: `../docs/README_DATABASE_DESIGN.md`
