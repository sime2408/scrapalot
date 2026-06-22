"""
RECOMMENDED: Helper script to create Alembic migrations with sequential numeric revision IDs.

IMPORTANT: Use this script instead of `alembic revision` to ensure sequential numbering!

Usage:
    python alembic/create_migration.py "Description of migration"
    python alembic/create_migration.py "Description of migration" --autogenerate

This script:
1. Finds the latest migration number (e.g., 019)
2. Creates a new migration with the next sequential number (e.g., 020)
3. Uses the numeric ID format: NNN_description.py
4. Sets revision='NNN' and down_revision='NNN-1'

Examples:
    python alembic/create_migration.py "Add user preferences"
    python alembic/create_migration.py "Update document schema" --autogenerate

Why not use `alembic revision`?
    - Alembic generates random hash IDs by default (e.g., '63c1b149562b')
    - This project uses sequential numbers (001, 002, 003...) for better organization
    - This script ensures proper numbering

Note:
    - The env.py hook provides safety checks during autogenerate
    - But it cannot control revision IDs during file generation
    - Always use this script for new migrations
"""

from datetime import datetime
from pathlib import Path
import re
import subprocess
import sys


def get_latest_migration_number(versions_dir: Path) -> int:
    """Get the latest migration number from existing migration files."""
    max_num = 0

    for file in versions_dir.glob("*.py"):
        # Match files like: 001_description.py, 012_description.py
        match = re.match(r"(\d{3})_.*\.py$", file.name)
        if match:
            num = int(match.group(1))
            max_num = max(max_num, num)

    return max_num


def slugify(text: str) -> str:
    """Convert description to a slug for filename."""
    # Remove special characters and convert to lowercase
    slug = re.sub(r"[^\w\s-]", "", text.lower())
    # Replace spaces and underscores with underscores
    slug = re.sub(r"[-\s]+", "_", slug)
    return slug


def create_migration(description: str, autogenerate: bool = False):
    """Create a new migration with sequential numeric ID."""

    # Get paths
    script_dir = Path(__file__).parent
    versions_dir = script_dir / "versions"

    if not versions_dir.exists():
        print(f"Error: Versions directory not found: {versions_dir}")
        sys.exit(1)

    # Get next migration number
    latest_num = get_latest_migration_number(versions_dir)
    next_num = latest_num + 1
    revision_id = f"{next_num:03d}"
    down_revision = f"{latest_num:03d}" if latest_num > 0 else None

    print(f"Creating migration {revision_id}: {description}")
    print(f"  Previous migration: {down_revision or 'None (initial)'}")

    # Create slug for filename
    slug = slugify(description)
    filename = f"{revision_id}_{slug}.py"
    filepath = versions_dir / filename

    # Check if file already exists
    if filepath.exists():
        print(f"Error: Migration file already exists: {filepath}")
        sys.exit(1)

    # Generate migration content
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")

    if autogenerate:
        print("  Using autogenerate mode")
        # Use alembic's autogenerate, then we'll fix the revision IDs
        temp_result = subprocess.run(
            ["alembic", "revision", "--autogenerate", "-m", description], capture_output=True, text=True, cwd=script_dir.parent
        )

        if temp_result.returncode != 0:
            print("Error running alembic autogenerate:")
            print(temp_result.stderr)
            sys.exit(1)

        # Find the generated file (will have a hash-based name)
        generated_files = sorted(versions_dir.glob("*.py"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not generated_files:
            print("Error: No migration file was generated")
            sys.exit(1)

        temp_file = generated_files[0]

        # Read the generated content
        content = temp_file.read_text()

        # Fix the revision IDs in the content
        content = re.sub(r"revision: str = '[^']*'", f"revision: str = '{revision_id}'", content)
        content = re.sub(
            r"down_revision: Union\[str, None\] = '[^']*'",
            f"down_revision: Union[str, None] = '{down_revision}'" if down_revision else "down_revision: Union[str, None] = None",
            content,
        )

        # Fix the revision ID comment at the top
        content = re.sub(r"Revision ID: [^\n]+", f"Revision ID: {revision_id}", content)
        content = re.sub(r"Revises: [^\n]+", f"Revises: {down_revision}" if down_revision else "Revises: ", content)

        # Delete the temp file and create the properly named one
        temp_file.unlink()
        filepath.write_text(content)

        print("  Generated migration with autogenerate")
    else:
        # Create empty migration template
        template = f'''"""{description}

Revision ID: {revision_id}
Revises: {down_revision or ""}
Create Date: {timestamp}

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '{revision_id}'
down_revision: Union[str, None] = '{down_revision}' if down_revision else None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    pass
    # ### end Alembic commands ###


def downgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    pass
    # ### end Alembic commands ###
'''

        filepath.write_text(template)
        print("  Created empty migration template")

    print(f"\nSuccess! Migration created: {filepath}")
    print("\nNext steps:")
    print(f"  1. Edit the migration file: {filepath}")
    print("  2. Add your schema changes in upgrade() and downgrade()")
    print("  3. Test the migration: alembic upgrade head")
    print("  4. Test rollback: alembic downgrade -1")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    description = sys.argv[1]
    autogenerate = "--autogenerate" in sys.argv or "-a" in sys.argv

    create_migration(description, autogenerate)


if __name__ == "__main__":
    main()
