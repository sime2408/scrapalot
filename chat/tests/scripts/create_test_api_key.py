"""
Script to create a test API key for E2E testing.
This script generates an API key and stores it in the database.
"""

from datetime import UTC, datetime
import hashlib

# Database configuration (matching your docker setup)
# Use environment variables if available, otherwise default to localhost
import os
from pathlib import Path
import secrets
import sys
import uuid

from passlib.context import CryptContext
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

POSTGRES_HOST = os.getenv("POSTGRES_HOST", "localhost")
POSTGRES_PORT = int(os.getenv("POSTGRES_PORT", "15432"))
POSTGRES_USER = os.getenv("POSTGRES_USER", "scrapalot")
POSTGRES_PASSWORD = os.getenv("POSTGRES_PASSWORD", "scrapalot")
POSTGRES_DB = os.getenv("POSTGRES_DB", "scrapalot")

DATABASE_URL = f"postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{POSTGRES_HOST}:{POSTGRES_PORT}/{POSTGRES_DB}"

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def generate_api_key():
    """
    Generate a new API key with the format: scp-xxxxxxxxxxxxxxxxxxxx

    Returns:
        tuple: (full_key, key_hash, key_prefix)
    """
    # Generate 20 random characters (alphanumeric)
    random_part = secrets.token_urlsafe(15)[:20]  # Get exactly 20 chars

    # Create full key with prefix
    full_key = f"scp-{random_part}"

    # Create SHA256 hash for storage
    key_hash = hashlib.sha256(full_key.encode()).hexdigest()

    # Create a prefix for display (first 8 chars: scp-xxxx)
    key_prefix = full_key[:8]

    return full_key, key_hash, key_prefix


def create_test_user(session):
    """Create a test user if it doesn't exist."""
    # Check if a test user exists
    query = text("SELECT id, username FROM users WHERE email = :email")
    result = session.execute(query, {"email": "test@scrapalot.com"}).fetchone()

    if result:
        print(f"✓ Test user already exists: {result.username} (id: {result.id})")
        return str(result.id)

    # Create a test user
    user_id = str(uuid.uuid4())
    insert_query = text("""
        INSERT INTO users (id, username, email, password, role, is_active, created_at, updated_at)
        VALUES (:id, :username, :email, :password, :role, :is_active, :created_at, :updated_at)
    """)

    # Hash the password "test123"
    hashed_password = pwd_context.hash("test123")

    session.execute(
        insert_query,
        {
            "id": user_id,
            "username": "test_user",
            "email": "test@scrapalot.com",
            "password": hashed_password,
            "role": "user",
            "is_active": True,
            "created_at": datetime.now(UTC),
            "updated_at": datetime.now(UTC),
        },
    )
    session.commit()

    print(f"✓ Created test user: test_user (id: {user_id})")
    return user_id


def create_api_key_record(session, user_id):
    """Create an API key for the test user."""
    # Check if an API key already exists
    query = text("SELECT key_prefix, name FROM api_keys WHERE user_id = :user_id AND is_active = true")
    result = session.execute(query, {"user_id": user_id}).fetchone()

    if result:
        print(f"✓ Test API key already exists: {result.key_prefix}... ({result.name})")
        print("⚠ Cannot retrieve the full key - it's hashed in the database")
        print("⚠ You must create a new key or use the previously saved key")
        return None

    # Generate a new API key
    full_key, key_hash, key_prefix = generate_api_key()

    # Insert API key
    insert_query = text("""
        INSERT INTO api_keys (id, user_id, key_hash, key_prefix, name, is_active, created_at, updated_at)
        VALUES (:id, :user_id, :key_hash, :key_prefix, :name, :is_active, :created_at, :updated_at)
    """)

    session.execute(
        insert_query,
        {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "key_hash": key_hash,
            "key_prefix": key_prefix,
            "name": "E2E Test Key",
            "is_active": True,
            "created_at": datetime.now(UTC),
            "updated_at": datetime.now(UTC),
        },
    )
    session.commit()

    print(f"✓ Created API key: {key_prefix}... (E2E Test Key)")
    return full_key


def main():
    """Main function to create test user and API key."""
    print("=" * 80)
    print("SCRAPALOT API KEY GENERATION")
    print("=" * 80)
    print(f"Database: {DATABASE_URL}")
    print("=" * 80)

    try:
        # Create a database engine
        engine = create_engine(DATABASE_URL)
        SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
        session = SessionLocal()

        # Create a test user
        user_id = create_test_user(session)

        # Create an API key
        full_key = create_api_key_record(session, user_id)

        if full_key:
            print("=" * 80)
            print("SUCCESS - API KEY CREATED")
            print("=" * 80)
            print(f"API Key: {full_key}")
            print("=" * 80)
            print("⚠ IMPORTANT: Save this key now - it will NOT be shown again!")
            print("=" * 80)
            print("\nUsage in tests:")
            print(f'headers = {{"X-API-Key": "{full_key}"}}')
            print("# OR")
            print(f'headers = {{"Authorization": "Bearer {full_key}"}}')
            print("=" * 80)

            # Save to file for test script
            api_key_file = Path(__file__).parent / ".test_api_key"
            # noinspection PyTypeChecker
            api_key_file.write_text(full_key)
            print(f"\n✓ API key saved to: {api_key_file}")
            print("  This file is for testing purposes only - do not commit to git!")
        else:
            print("=" * 80)
            print("API KEY ALREADY EXISTS")
            print("=" * 80)
            print("If you need a new key, delete the old one first or use the existing key.")

            # Check if key file exists
            api_key_file = Path(__file__).parent / ".test_api_key"
            if api_key_file.exists():
                print(f"\n✓ Existing API key found in: {api_key_file}")
                existing_key = api_key_file.read_text().strip()
                print(f"  Key: {existing_key}")
            else:
                print("\n⚠ No API key file found - you need to retrieve the key manually")

        session.close()

    except Exception as e:
        print(f"\n✗ Error: {str(e)}")
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
