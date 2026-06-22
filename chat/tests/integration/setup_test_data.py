"""
Test Data Setup Module

Automatically prepares test data for integration tests:
1. Checks if the test collection has document chunks
2. If not, uploads the test book (tests/books/art_of_war.pdf)
3. Waits for document processing to complete with proper chunking:
   - Enhanced Markdown chunking for context expansion (book → chapters → paragraphs)
   - Vectorized to pgvector
   - Optionally organized in Neo4j (if graph RAG enabled)
4. Stores IDs in .test_* files for reuse

This runs ONCE - subsequent test runs reuse existing data.
Only re-run if document parsing logic changes.

Required test book: tests/books/art_of_war.pdf
"""

import os
from pathlib import Path
import time

import requests

# Test resource files
TEST_DIR = Path(__file__).parent.parent
TEST_API_KEY_FILE = TEST_DIR / ".test_api_key"
TEST_USER_ID_FILE = TEST_DIR / ".test_user_id"
TEST_WORKSPACE_ID_FILE = TEST_DIR / ".test_workspace_id"
TEST_COLLECTION_ID_FILE = TEST_DIR / ".test_collection_id"
TEST_DOCUMENT_ID_FILE = TEST_DIR / ".test_document_id"

# Primary test book - must exist in tests/books/
TEST_BOOK_PATH = TEST_DIR / "books" / "art_of_war.pdf"
TEST_BOOK_NAME = "art_of_war.pdf"

# Chunking strategy for proper context expansion (book → chapters → paragraphs)
CHUNKING_STRATEGY = "enhanced_markdown"

# Environment-based API URL
ENVIRONMENT = os.getenv("ENVIRONMENT", "dev").lower()
if ENVIRONMENT == "prod":
    DEFAULT_API_BASE_URL = os.getenv("BACKEND_BASE_URL", "https://api.scrapalot.app") + "/api/v1"
else:
    DEFAULT_API_BASE_URL = "http://localhost:8090/api/v1"

API_BASE_URL = os.getenv("API_BASE_URL", DEFAULT_API_BASE_URL)


def load_test_credentials() -> tuple[str | None, str | None, str | None, str | None]:
    """Load test credentials from files."""
    api_key = TEST_API_KEY_FILE.read_text().strip() if TEST_API_KEY_FILE.exists() else None
    user_id = TEST_USER_ID_FILE.read_text().strip() if TEST_USER_ID_FILE.exists() else None
    workspace_id = TEST_WORKSPACE_ID_FILE.read_text().strip() if TEST_WORKSPACE_ID_FILE.exists() else None
    collection_id = TEST_COLLECTION_ID_FILE.read_text().strip() if TEST_COLLECTION_ID_FILE.exists() else None
    return api_key, user_id, workspace_id, collection_id


def get_authenticated_session(api_key: str) -> requests.Session:
    """Create authenticated session."""
    session = requests.Session()
    session.headers.update({"X-API-Key": api_key, "Accept": "application/json"})
    return session


def check_collection_has_chunks(session: requests.Session, collection_id: str) -> int:
    """Check if the collection has document chunks. Returns chunk count.

    Checks the langchain_pg_embedding table, which is where the actual chunks are stored.
    Falls back to API endpoint if database connection fails.
    """
    # First try direct database query for accurate count
    try:
        chunk_count = check_langchain_embeddings_count(collection_id)
        if chunk_count > 0:
            return chunk_count
    except Exception as e:
        print(f"Database check failed: {e}, falling back to API")

    # Fallback to API endpoint
    try:
        response = session.get(f"{API_BASE_URL}/collections/{collection_id}/summary", timeout=30)
        if response.status_code == 200:
            data = response.json()
            chunk_count = data.get("chunk_count", 0)
            return chunk_count
        elif response.status_code == 404:
            print(f"Collection {collection_id} not found")
            return 0
    except Exception as e:
        print(f"Error checking chunks: {e}")
    return 0


def check_langchain_embeddings_count(collection_id: str) -> int:
    """Check langchain_pg_embedding table for chunk count.

    This is where the actual chunks are stored, not document_chunks table.
    """
    import os

    try:
        import psycopg2
    except ImportError:
        return 0

    host = os.environ.get("POSTGRES_HOST", "aws-1-eu-central-1.pooler.supabase.com")
    port = os.environ.get("POSTGRES_PORT", "6543")
    user = os.environ.get("POSTGRES_USER", "postgres.slqspvtyrgzhanubcdtj")
    password = os.environ.get("POSTGRES_PASSWORD")
    database = os.environ.get("POSTGRES_DB", "postgres")

    if not password:
        return 0

    try:
        conn = psycopg2.connect(host=host, port=port, user=user, password=password, database=database, connect_timeout=10)
        cur = conn.cursor()

        # Count embeddings in langchain_pg_embedding linked to this collection
        cur.execute(
            """
            SELECT COUNT(*) FROM public.langchain_pg_embedding e
            JOIN public.langchain_pg_collection c ON e.collection_id = c.uuid
            WHERE c.name = %s
        """,
            (collection_id,),
        )
        count = cur.fetchone()[0]

        cur.close()
        conn.close()
        return count
    except Exception as e:
        print(f"Langchain embedding check error: {e}")
        return 0


def get_test_book() -> Path | None:
    """
    Get the test book from tests/books/art_of_war.pdf.
    This file must exist - it's not downloaded.
    """
    if TEST_BOOK_PATH.exists() and TEST_BOOK_PATH.stat().st_size > 1000:
        file_size = TEST_BOOK_PATH.stat().st_size
        print(f"Test book found: {TEST_BOOK_PATH} ({file_size / 1024:.1f} KB)")
        return TEST_BOOK_PATH

    print(f"ERROR: Test book not found at {TEST_BOOK_PATH}")
    print("The art_of_war.pdf file must exist in tests/books/")
    print("This file is required for RAG integration tests.")
    return None


def upload_document(session: requests.Session, collection_id: str, pdf_path: Path, user_id: str) -> str | None:
    """Upload a PDF document to the collection via the /documents/upload endpoint."""
    print(f"Uploading {pdf_path.name} to collection {collection_id}...")

    try:
        with open(pdf_path, "rb") as f:
            files = {"file": (pdf_path.name, f, "application/pdf")}
            data = {"collection_id": collection_id, "user_id": user_id}
            response = session.post(f"{API_BASE_URL}/documents/upload", files=files, data=data, timeout=300)

        if response.status_code in [200, 201]:
            result = response.json()
            job_id = result.get("job_id")
            print(f"Upload started, job_id: {job_id}")
            # Return job_id since document_id is not in response
            return job_id
        else:
            print(f"Upload failed: {response.status_code} - {response.text}")
            return None
    except Exception as e:
        print(f"Upload error: {e}")
        return None


def get_document_id_from_collection(session: requests.Session, collection_id: str, filename: str) -> str | None:
    """Get document ID by filename from collection documents."""
    try:
        # Correct endpoint: /documents/collection/{collection_id}
        response = session.get(f"{API_BASE_URL}/documents/collection/{collection_id}", timeout=30)
        if response.status_code == 200:
            data = response.json()
            # Response might be a list or have a 'documents' key
            documents = data if isinstance(data, list) else data.get("documents", [])
            for doc in documents:
                if filename in doc.get("filename", "") or filename in doc.get("title", ""):
                    return doc.get("id")
    except Exception as e:
        print(f"Error getting document ID: {e}")
    return None


def wait_for_processing(session: requests.Session, collection_id: str, document_id: str | None, max_wait: int = 300, poll_interval: int = 10) -> bool:
    """Wait for document processing to complete by checking chunk count."""
    print(f"Waiting for document processing (max {max_wait}s)...")

    start_time = time.time()
    while time.time() - start_time < max_wait:
        try:
            # Check chunks via collection endpoint
            chunk_count = check_collection_has_chunks(session, collection_id)
            elapsed = int(time.time() - start_time)
            print(f"  [{elapsed}s] Collection chunks: {chunk_count}")

            if chunk_count > 0:
                print(f"Processing complete! {chunk_count} chunks created.")
                return True

            # Also check document status if we have an ID
            if document_id:
                response = session.get(f"{API_BASE_URL}/documents/{document_id}", timeout=30)
                if response.status_code == 200:
                    data = response.json()
                    status = data.get("processing_status", "").lower()
                    if status in ["failed", "error"]:
                        error_msg = data.get("processing_error", "Unknown error")
                        print(f"Processing failed: {error_msg}")
                        return False
        except Exception as e:
            print(f"  Check error: {e}")

        time.sleep(poll_interval)

    print("Processing timeout!")
    return False


def create_test_workspace(session: requests.Session) -> str | None:
    """Create test workspace if it doesn't exist."""
    print("Creating test workspace...")
    try:
        response = session.post(
            f"{API_BASE_URL}/workspaces", json={"name": "Integration Test Workspace", "description": "Auto-created for integration tests"}, timeout=30
        )
        if response.status_code in [200, 201]:
            data = response.json()
            workspace_id = data.get("id")
            print(f"Created workspace: {workspace_id}")
            TEST_WORKSPACE_ID_FILE.write_text(workspace_id)
            return workspace_id
        else:
            print(f"Failed to create workspace: {response.text}")
    except Exception as e:
        print(f"Workspace creation error: {e}")
    return None


def create_test_collection(session: requests.Session, workspace_id: str) -> str | None:
    """
    Create the test collection with enhanced_markdown chunking strategy.
    This enables proper context expansion (book → chapters → paragraphs).
    """
    print(f"Creating test collection with {CHUNKING_STRATEGY} chunking...")
    try:
        response = session.post(
            f"{API_BASE_URL}/collections",
            json={
                "name": "Integration Test Collection",
                "description": "Auto-created for RAG integration tests with hierarchical chunking",
                "workspace_id": workspace_id,
                "chunking_strategy": CHUNKING_STRATEGY,  # Enable context expansion
            },
            timeout=30,
        )
        if response.status_code in [200, 201]:
            data = response.json()
            collection_id = data.get("id")
            print(f"Created collection: {collection_id} (chunking: {CHUNKING_STRATEGY})")
            TEST_COLLECTION_ID_FILE.write_text(collection_id)
            return collection_id
        else:
            print(f"Failed to create collection: {response.text}")
    except Exception as e:
        print(f"Collection creation error: {e}")
    return None


def setup_test_data() -> bool:
    """
    Main setup function. Ensures the test collection has chunked documents.
    Returns True if setup is ready, False otherwise.
    """
    print("\n" + "=" * 60)
    print("INTEGRATION TEST DATA SETUP")
    print("=" * 60)

    # Load credentials
    api_key, user_id, workspace_id, collection_id = load_test_credentials()

    if not api_key:
        print("ERROR: No API key found in tests/.test_api_key")
        return False

    session = get_authenticated_session(api_key)

    # Check if workspace exists, create if needed
    if not workspace_id:
        workspace_id = create_test_workspace(session)
        if not workspace_id:
            return False

    # Check if collection exists, create if needed
    if not collection_id:
        collection_id = create_test_collection(session, workspace_id)
        if not collection_id:
            return False

    # Check if collection already has chunks
    chunk_count = check_collection_has_chunks(session, collection_id)
    if chunk_count > 0:
        print(f"\nTest collection already has {chunk_count} chunks. Setup complete!")
        print("=" * 60 + "\n")
        return True

    print(f"\nCollection {collection_id} has no chunks. Setting up test data...")

    # Get test book (must exist in tests/books/)
    pdf_path = get_test_book()
    if not pdf_path:
        return False

    # Upload document (requires user_id)
    if not user_id:
        print("ERROR: No user_id found in tests/.test_user_id")
        return False

    job_id = upload_document(session, collection_id, pdf_path, user_id)
    if not job_id:
        return False

    # Get document ID from collection
    print("Getting document ID from collection...")
    time.sleep(2)  # Brief wait for document record to be created
    document_id = get_document_id_from_collection(session, collection_id, pdf_path.stem)
    if not document_id:
        print("WARNING: Could not get document ID, will check chunks directly")
    else:
        print(f"Document ID: {document_id}")
        TEST_DOCUMENT_ID_FILE.write_text(document_id)

    # Wait for processing (check chunks in collection)
    if not wait_for_processing(session, collection_id, document_id):
        return False

    # Verify chunks were created
    final_chunk_count = check_collection_has_chunks(session, collection_id)
    if final_chunk_count > 0:
        print(f"\nSetup complete! Collection has {final_chunk_count} chunks.")
        print("=" * 60 + "\n")
        return True
    else:
        print("\nWARNING: Processing completed but no chunks found.")
        return False


def verify_test_data_exists() -> tuple[bool, int]:
    """
    Quick check if test data exists without modifying anything.
    Returns (exists, chunk_count).
    """
    api_key, _, _, collection_id = load_test_credentials()

    if not api_key or not collection_id:
        return False, 0

    session = get_authenticated_session(api_key)
    chunk_count = check_collection_has_chunks(session, collection_id)

    return chunk_count > 0, chunk_count


def verify_supabase_data() -> dict:
    """
    Verify all test data exists in the Supabase database.
    Returns dict with verification results.

    Checks:
    - User exists in the users table
    - Workspace exists in the workspaces table
    - Collection exists in the collections table
    - Document exists in the documents table
    - Document has chunks in the document_chunks table
    """
    api_key, user_id, workspace_id, collection_id = load_test_credentials()

    results = {
        "user": {"id": user_id, "exists": False},
        "workspace": {"id": workspace_id, "exists": False},
        "collection": {"id": collection_id, "exists": False, "chunk_count": 0},
        "document": {"id": None, "exists": False, "filename": None},
        "all_valid": False,
    }

    if not api_key:
        print("ERROR: No API key configured")
        return results

    session = get_authenticated_session(api_key)

    # Check workspace
    if workspace_id:
        try:
            response = session.get(f"{API_BASE_URL}/workspaces/{workspace_id}", timeout=30)
            if response.status_code == 200:
                results["workspace"]["exists"] = True
                data = response.json()
                results["workspace"]["name"] = data.get("name")
        except Exception as e:
            print(f"Workspace check error: {e}")

    # Check collection and chunk count
    if collection_id:
        try:
            response = session.get(f"{API_BASE_URL}/collections/{collection_id}/summary", timeout=30)
            if response.status_code == 200:
                results["collection"]["exists"] = True
                data = response.json()
                results["collection"]["chunk_count"] = data.get("chunk_count", 0)
                results["collection"]["name"] = data.get("name")
        except Exception as e:
            print(f"Collection check error: {e}")

    # Check documents in collection
    if collection_id:
        try:
            response = session.get(f"{API_BASE_URL}/documents/collection/{collection_id}", timeout=30)
            if response.status_code == 200:
                data = response.json()
                documents = data if isinstance(data, list) else data.get("documents", [])
                for doc in documents:
                    if "art_of_war" in doc.get("filename", "").lower():
                        results["document"]["exists"] = True
                        results["document"]["id"] = doc.get("id")
                        results["document"]["filename"] = doc.get("filename")
                        break
        except Exception as e:
            print(f"Document check error: {e}")

    # Check user (via profile endpoint)
    try:
        response = session.get(f"{API_BASE_URL}/users/profile", timeout=30)
        if response.status_code == 200:
            results["user"]["exists"] = True
            data = response.json()
            results["user"]["email"] = data.get("email")
    except Exception as e:
        print(f"User check error: {e}")

    # Determine overall validity
    results["all_valid"] = (
        results["user"]["exists"]
        and results["workspace"]["exists"]
        and results["collection"]["exists"]
        and results["collection"]["chunk_count"] > 0
        and results["document"]["exists"]
    )

    return results


def print_test_data_status():
    """Print a summary of test data status."""
    print("\n" + "=" * 60)
    print("TEST DATA STATUS")
    print("=" * 60)

    # Check files
    print("\nTest Data Files:")
    files = [
        (".test_api_key", TEST_API_KEY_FILE),
        (".test_user_id", TEST_USER_ID_FILE),
        (".test_workspace_id", TEST_WORKSPACE_ID_FILE),
        (".test_collection_id", TEST_COLLECTION_ID_FILE),
        (".test_document_id", TEST_DOCUMENT_ID_FILE),
    ]
    for name, path in files:
        if path.exists():
            content = path.read_text().strip()[:36]
            print(f"  {name}: {content}...")
        else:
            print(f"  {name}: MISSING")

    # Check test book
    print("\nTest Book:")
    if TEST_BOOK_PATH.exists():
        size = TEST_BOOK_PATH.stat().st_size / 1024
        print(f"  {TEST_BOOK_PATH}: {size:.1f} KB")
    else:
        print(f"  {TEST_BOOK_PATH}: MISSING")

    # Check Supabase data
    print("\nSupabase Data:")
    results = verify_supabase_data()

    print(f"  User: {'OK' if results['user']['exists'] else 'MISSING'}")
    print(f"  Workspace: {'OK' if results['workspace']['exists'] else 'MISSING'}")
    print(f"  Collection: {'OK' if results['collection']['exists'] else 'MISSING'}")
    print(f"  Chunk Count: {results['collection'].get('chunk_count', 0)}")
    print(f"  Document: {'OK' if results['document']['exists'] else 'MISSING'}")

    print("\n" + "=" * 60)
    if results["all_valid"]:
        print("STATUS: ALL TEST DATA READY")
    else:
        print("STATUS: TEST DATA INCOMPLETE - Run setup first")
    print("=" * 60 + "\n")

    return results["all_valid"]


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "--status":
        # Just print status
        print_test_data_status()
    else:
        # Run setup
        success = setup_test_data()
        exit(0 if success else 1)
