"""
Gateway-First Integration Test Configuration

All tests hit the API Gateway (port 8080) which routes to:
- Kotlin Backend (port 8091) for CRUD operations
- Python Backend (port 8090) for AI operations (via Kotlin proxy)

Authentication: JWT via POST /api/v1/auth/login (not API keys)
No Python source imports - treats the system as a black box.

Environment Variables:
    GATEWAY_URL        - Gateway base URL (default: http://localhost:8080/api/v1)
    TEST_USERNAME      - Login username (default: admin)
    TEST_PASSWORD      - Login password (default: admin123)
    POSTGRES_HOST      - PostgreSQL host (default: localhost)
    POSTGRES_PORT      - PostgreSQL port for Python DB (default: 15432)
    POSTGRES_BACKEND_PORT - PostgreSQL port for Kotlin DB (default: 5433)
"""

import json
import logging
import os
from pathlib import Path
import time

import pytest
import requests

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    psycopg2 = None
    RealDictCursor = None

logger = logging.getLogger(__name__)

# =============================================================================
# Environment Configuration
# =============================================================================

ENVIRONMENT = os.getenv("ENVIRONMENT", "dev").lower()

if ENVIRONMENT == "prod":
    DEFAULT_GATEWAY_URL = os.getenv("GATEWAY_URL", "http://scrapalot-gw:8080") + "/api/v1"
    DEFAULT_PG_HOST = os.getenv("POSTGRES_HOST", "pgvector")
    DEFAULT_PG_PORT = os.getenv("POSTGRES_PORT", "5432")
    DEFAULT_PG_BACKEND_HOST = os.getenv("POSTGRES_BACKEND_HOST", "pgvector")
    DEFAULT_PG_BACKEND_PORT = os.getenv("POSTGRES_BACKEND_PORT", "5432")
else:
    DEFAULT_GATEWAY_URL = "http://localhost:8080/api/v1"
    DEFAULT_PG_HOST = "localhost"
    DEFAULT_PG_PORT = "15432"
    DEFAULT_PG_BACKEND_HOST = "localhost"
    DEFAULT_PG_BACKEND_PORT = "15432"

GATEWAY_URL = os.getenv("GATEWAY_URL", DEFAULT_GATEWAY_URL)
if not GATEWAY_URL.endswith("/api/v1"):
    GATEWAY_URL = GATEWAY_URL.rstrip("/") + "/api/v1"

TEST_USERNAME = os.getenv("TEST_USERNAME", "admin")
TEST_PASSWORD = os.getenv("TEST_PASSWORD", "admin123")
TIMEOUT = int(os.getenv("TEST_TIMEOUT", "300"))

# Python DB (scrapalot) - embeddings, server settings
PYTHON_DB_CONFIG = {
    "host": os.getenv("POSTGRES_HOST", DEFAULT_PG_HOST),
    "port": int(os.getenv("POSTGRES_PORT", DEFAULT_PG_PORT)),
    "database": os.getenv("POSTGRES_DB", "scrapalot"),
    "user": os.getenv("POSTGRES_USER", "scrapalot"),
    "password": os.getenv("POSTGRES_PASSWORD", "scrapalot"),
}

# Kotlin DB (scrapalot_backend) - users, workspaces, sessions, messages
KOTLIN_DB_CONFIG = {
    "host": os.getenv("POSTGRES_BACKEND_HOST", DEFAULT_PG_BACKEND_HOST),
    "port": int(os.getenv("POSTGRES_BACKEND_PORT", DEFAULT_PG_BACKEND_PORT)),
    "database": os.getenv("POSTGRES_BACKEND_DB", "scrapalot_backend"),
    "user": os.getenv("POSTGRES_BACKEND_USER", "scrapalot"),
    "password": os.getenv("POSTGRES_BACKEND_PASSWORD", "scrapalot"),
}


# =============================================================================
# NDJSON Streaming Helpers
# =============================================================================


def parse_ndjson(response_text: str) -> list[dict]:
    """Parse NDJSON response into list of packet dicts."""
    packets = []
    for line in response_text.strip().split("\n"):
        line = line.strip()
        if line:
            try:
                packets.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return packets


def get_packets_by_type(packets: list[dict], packet_type: str) -> list[dict]:
    """Filter packets by obj.type."""
    return [p for p in packets if p.get("obj", {}).get("type") == packet_type]


def get_accumulated_content(packets: list[dict]) -> str:
    """Concatenate all message_delta content."""
    deltas = get_packets_by_type(packets, "message_delta")
    return "".join(d["obj"].get("content", "") for d in deltas)


# =============================================================================
# Session-Scoped Fixtures
# =============================================================================


@pytest.fixture(scope="session")
def gateway_url() -> str:
    """Gateway API base URL."""
    return GATEWAY_URL


def _obtain_jwt_token(gateway_url: str) -> str:
    """Obtain a fresh JWT token by logging in via the gateway."""
    login_url = f"{gateway_url}/auth/login"
    response = requests.post(
        login_url,
        json={"username_or_email": TEST_USERNAME, "password": TEST_PASSWORD},
        timeout=30,
    )

    if response.status_code != 200:
        pytest.fail(f"Failed to login as '{TEST_USERNAME}' at {login_url}: {response.status_code} {response.text}")

    data = response.json()
    token = data.get("access_token")
    if not token:
        pytest.fail(f"Login response missing 'access_token': {data}")

    logger.info("JWT token obtained for user '%s'", TEST_USERNAME)
    return token


class AutoRefreshSession(requests.Session):
    """Session that auto-refreshes JWT token on 401 responses."""

    def __init__(self, gateway_url: str, token: str):
        super().__init__()
        self._gateway_url = gateway_url
        self.headers.update(
            {
                "Authorization": f"Bearer {token}",
                "Accept": "*/*",
            }
        )

    def request(self, method, url, **kwargs):
        response = super().request(method, url, **kwargs)
        if response.status_code == 401 and "expired" in response.text.lower():
            logger.info("JWT token expired, refreshing...")
            new_token = _obtain_jwt_token(self._gateway_url)
            self.headers["Authorization"] = f"Bearer {new_token}"
            response = super().request(method, url, **kwargs)
        return response


@pytest.fixture(scope="session")
def jwt_token(gateway_url) -> str:
    """
    Obtain JWT token by logging in via the gateway.
    POST /api/v1/auth/login with username_or_email + password.
    """
    return _obtain_jwt_token(gateway_url)


@pytest.fixture(scope="session")
def authenticated_session(jwt_token, gateway_url) -> requests.Session:
    """
    HTTP session with JWT Bearer token for authenticated requests.
    Auto-refreshes token on 401 (expired) responses.
    Content-Type is NOT preset - let requests determine it automatically.
    """
    return AutoRefreshSession(gateway_url, jwt_token)


# Keep api_base_url as alias for gateway_url (backward compatibility)
@pytest.fixture(scope="session")
def api_base_url(gateway_url) -> str:
    """Alias for gateway_url (backward compatibility with existing tests)."""
    return gateway_url


# =============================================================================
# Database Fixtures
# =============================================================================


@pytest.fixture(scope="session")
def python_db():
    """Connection to Python database (scrapalot) - embeddings, server settings."""
    if psycopg2 is None:
        pytest.skip("psycopg2 not available")

    try:
        conn = psycopg2.connect(
            host=PYTHON_DB_CONFIG["host"],
            port=PYTHON_DB_CONFIG["port"],
            database=PYTHON_DB_CONFIG["database"],
            user=PYTHON_DB_CONFIG["user"],
            password=PYTHON_DB_CONFIG["password"],
            connect_timeout=30,
        )
        yield conn
        conn.close()
    except Exception as e:
        pytest.skip(f"Could not connect to Python database: {e}")


@pytest.fixture(scope="session")
def kotlin_db():
    """Connection to Kotlin database (scrapalot_backend) - users, sessions, messages."""
    if psycopg2 is None:
        pytest.skip("psycopg2 not available")

    try:
        conn = psycopg2.connect(
            host=KOTLIN_DB_CONFIG["host"],
            port=KOTLIN_DB_CONFIG["port"],
            database=KOTLIN_DB_CONFIG["database"],
            user=KOTLIN_DB_CONFIG["user"],
            password=KOTLIN_DB_CONFIG["password"],
            connect_timeout=30,
        )
        yield conn
        conn.close()
    except Exception as e:
        pytest.skip(f"Could not connect to Kotlin database: {e}")


# Legacy alias
@pytest.fixture(scope="session")
def db_connection(python_db):
    """Legacy alias for python_db."""
    return python_db


@pytest.fixture(scope="function")
def py_cursor(python_db):
    """Cursor for Python database with dict results."""
    # noinspection PyTypeChecker
    cursor = python_db.cursor(cursor_factory=RealDictCursor)
    yield cursor
    cursor.close()


@pytest.fixture(scope="function")
def kt_cursor(kotlin_db):
    """Cursor for Kotlin database with dict results."""
    # noinspection PyTypeChecker
    cursor = kotlin_db.cursor(cursor_factory=RealDictCursor)
    yield cursor
    cursor.close()


# Legacy alias
@pytest.fixture(scope="function")
def db_cursor(py_cursor):
    """Legacy alias for py_cursor."""
    return py_cursor


# =============================================================================
# Test Resource Fixtures
# =============================================================================


@pytest.fixture(scope="session")
def test_user_id(authenticated_session, gateway_url) -> str:
    """Get the authenticated user's ID from /users/me."""
    response = authenticated_session.get(f"{gateway_url}/users/me", timeout=30)
    if response.status_code != 200:
        pytest.skip(f"Cannot get user profile: {response.status_code}")

    user_data = response.json()
    user_id = user_data.get("id")
    if not user_id:
        pytest.skip("User profile missing 'id' field")

    logger.info("Test user ID: %s", user_id)
    return str(user_id)


@pytest.fixture(scope="session")
def test_workspace(authenticated_session, gateway_url) -> dict:
    """
    Get the workspace for integration testing.
    Prefers 'Integration Test Workspace', falls back to default or first workspace.
    """
    response = authenticated_session.get(f"{gateway_url}/workspaces", timeout=30)
    if response.status_code != 200:
        pytest.skip(f"Cannot list workspaces: {response.status_code}")

    data = response.json()
    workspaces = data.get("workspaces", data) if isinstance(data, dict) else data

    if not isinstance(workspaces, list) or len(workspaces) == 0:
        pytest.skip("No workspaces available for testing")

    # Prefer "Integration Test Workspace" if it exists
    for ws in workspaces:
        if "integration" in ws.get("name", "").lower():
            logger.info("Using integration workspace: %s (%s)", ws.get("name"), ws.get("id"))
            return {"id": str(ws["id"]), "name": ws.get("name"), "slug": ws.get("slug")}

    # Fallback to first workspace
    ws = workspaces[0]
    logger.info("Using first workspace: %s (%s)", ws.get("name"), ws.get("id"))
    return {"id": str(ws["id"]), "name": ws.get("name", "Workspace"), "slug": ws.get("slug")}


@pytest.fixture(scope="session")
def test_collection(authenticated_session, gateway_url, test_workspace, python_db) -> dict:
    """
    Get the collection for integration testing.
    Prefers 'Integration Test Collection' or any collection with embeddings.
    If none exist, creates a test collection.
    """
    response = authenticated_session.get(
        f"{gateway_url}/collections",
        params={"workspaceId": test_workspace["id"]},
        timeout=30,
    )
    if response.status_code != 200:
        pytest.skip(f"Cannot list collections: {response.status_code}")

    data = response.json()
    collections = data.get("collections", data) if isinstance(data, dict) else data

    if isinstance(collections, list) and len(collections) > 0:
        col = None
        integration_col = None

        # First pass: find any collection with embeddings (preferred)
        try:
            cursor = python_db.cursor()
            for c in collections:
                cursor.execute(
                    "SELECT COUNT(*) FROM langchain_pg_embedding WHERE collection_id = ("
                    "SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1)",
                    (str(c["id"]),),
                )
                count = cursor.fetchone()[0]
                if count > 0:
                    col = c
                    logger.info("Found collection with %d embeddings: %s", count, c.get("name"))
                    break
                if "integration" in c.get("name", "").lower():
                    integration_col = c
            cursor.close()
        except Exception as e:
            logger.warning("Could not check embeddings: %s", e)
            python_db.rollback()

        # Fallback: "Integration Test" collection (even without embeddings)
        if not col and integration_col:
            col = integration_col

        # Fallback: first collection
        if not col:
            col = collections[0]
    else:
        # Create a test collection
        create_response = authenticated_session.post(
            f"{gateway_url}/collections",
            json={
                "name": "Integration Test Collection",
                "workspace_id": test_workspace["id"],
            },
            timeout=30,
        )
        if create_response.status_code not in [200, 201]:
            pytest.skip(f"Cannot create test collection: {create_response.status_code} {create_response.text}")
        col = create_response.json()
        logger.info("Created test collection: %s (%s)", col.get("name"), col.get("id"))

    collection_id = str(col["id"])
    logger.info("Using collection: %s (%s)", col.get("name"), collection_id)

    return {
        "id": collection_id,
        "name": col.get("name", "Test Collection"),
        "workspace_id": test_workspace["id"],
    }


# =============================================================================
# Pre-Test Cleanup Fixture
# =============================================================================

# IMPORTANT: Old test data must be cleaned before re-running the suite.
# Without cleanup, stale documents, embeddings, and Neo4j nodes accumulate
# across runs, causing duplicate Book nodes, ghost embeddings, and
# inconsistent test results. This fixture runs automatically at session start.


@pytest.fixture(scope="session")
def cleanup_old_test_data(python_db):
    """
    Remove stale test artifacts from previous integration test runs.

    Cleans:
    - Python DB: documents, embeddings, langchain collections for test collections

    Note: Neo4j graph is NOT wiped — it contains real graph data derived from
    processed documents and takes 15+ minutes to rebuild (entity extraction).
    Use _ensure_neo4j_graph() to rebuild if empty.

    Must run BEFORE test_document and sync_test_data_to_python_db.
    """
    cursor = python_db.cursor()
    try:
        # Find all test-related collections (created by test fixtures)
        cursor.execute(
            "SELECT collection_id FROM collection_workspace_map WHERE collection_name LIKE %s",
            ("%ntegration%",),
        )
        test_collections = [row[0] for row in cursor.fetchall()]

        if test_collections:
            for cid in test_collections:
                cid_str = str(cid)
                # Delete embeddings for this collection
                cursor.execute(
                    """DELETE FROM langchain_pg_embedding
                       WHERE collection_id = (
                           SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
                       )""",
                    (cid_str,),
                )
                # Delete langchain collection record
                cursor.execute("DELETE FROM langchain_pg_collection WHERE name = %s", (cid_str,))
                # Delete documents
                cursor.execute("DELETE FROM documents WHERE collection_id = %s", (cid_str,))

            # Delete collection_workspace_map entries
            cursor.execute(
                "DELETE FROM collection_workspace_map WHERE collection_name LIKE %s",
                ("%ntegration%",),
            )
            python_db.commit()
            logger.info("Cleaned test data for %d collections: %s", len(test_collections), test_collections)
        else:
            logger.info("No stale test collections found, skipping cleanup")

    except Exception as e:
        python_db.rollback()
        logger.warning("Cleanup failed (non-fatal): %s", e)
    finally:
        cursor.close()

    return True


# =============================================================================
# Python DB Sync Fixture
# =============================================================================


@pytest.fixture(scope="session")
def sync_test_data_to_python_db(python_db, test_user_id, test_workspace, test_collection, cleanup_old_test_data):
    """
    Ensure the test workspace and collection exist in the Python DB.
    The Kotlin DB is the source of truth (seeded via Liquibase), but Python's
    document upload endpoint checks collection permissions against its own DB.
    """
    cursor = python_db.cursor()
    try:
        user_id = test_user_id
        workspace_id = test_workspace["id"]
        collection_id = test_collection["id"]
        collection_name = test_collection["name"]
        workspace_name = test_workspace["name"]

        # Ensure collection_workspace_map entry exists (Python DB uses this instead
        # of separate workspaces/collections tables — those live in Kotlin DB only)
        cursor.execute(
            "SELECT collection_id FROM collection_workspace_map WHERE collection_id = %s",
            (collection_id,),
        )
        if not cursor.fetchone():
            cursor.execute(
                """INSERT INTO collection_workspace_map
                   (collection_id, workspace_id, owner_user_id, collection_name, workspace_name)
                   VALUES (%s, %s, %s, %s, %s)""",
                (collection_id, workspace_id, user_id, collection_name, workspace_name),
            )

        python_db.commit()
        logger.info(
            "Synced test data to Python DB: user=%s, workspace=%s, collection=%s",
            user_id,
            workspace_id,
            collection_id,
        )
    except Exception as e:
        python_db.rollback()
        logger.error("Failed to sync test data to Python DB: %s", e)
        raise
    finally:
        cursor.close()

    return True


# =============================================================================
# Neo4j Graph Helpers
# =============================================================================


def _ensure_neo4j_graph(document_id, collection_id, _workspace_id, _python_db):
    """Rebuild Neo4j graph hierarchy if the graph is empty.

    Triggers RebuildGraph via gRPC which creates hierarchy nodes
    (Workspace, Collection, Book, Chapter, Section, Chunk) synchronously
    and starts entity extraction in background. Does NOT wait for entity
    extraction to complete (takes 15+ minutes).
    """
    try:
        from neo4j import GraphDatabase

        neo4j_uri = os.getenv("NEO4J_URI")
        neo4j_password = os.getenv("NEO4J_PASSWORD", "neo4j")
        if not neo4j_uri:
            return

        driver = GraphDatabase.driver(neo4j_uri, auth=("neo4j", neo4j_password))
        with driver.session() as session:
            # Check for hierarchy nodes (Book), not just total count —
            # orphaned entity nodes can exist without hierarchy
            result = session.run("MATCH (b:Book) RETURN count(b) as count")
            book_count = result.single()["count"]
        driver.close()

        if book_count > 0:
            logger.info("Neo4j already has %d Book nodes, skipping graph rebuild", book_count)
            return

        logger.info("Neo4j has no Book nodes — rebuilding graph hierarchy for document %s", document_id)

        import grpc

        from src.main.grpc import admin_pb2, admin_pb2_grpc

        grpc_host = os.getenv("GRPC_HOST", "localhost")
        channel = grpc.insecure_channel(f"{grpc_host}:9091")
        stub = admin_pb2_grpc.AdminServiceStub(channel)

        request = admin_pb2.RebuildGraphRequest(
            user_id=os.getenv("TEST_USER_ID", "ad93054b-635b-47b0-b6f4-7c7e06989c4c"),
            collection_id=collection_id,
        )

        response = stub.RebuildGraph(request, timeout=120)
        logger.info("Graph rebuild: success=%s, message=%s", response.success, response.message)

        if not response.success:
            logger.warning("Graph rebuild failed: %s", response.message)
            return

        # Brief wait for hierarchy nodes to be committed to Neo4j
        time.sleep(3)

        driver = GraphDatabase.driver(neo4j_uri, auth=("neo4j", neo4j_password))
        with driver.session() as session:
            result = session.run("MATCH (n) RETURN count(n) as count")
            final_count = result.single()["count"]
        driver.close()
        logger.info("Neo4j graph rebuild complete: %d hierarchy nodes (entity extraction running in background)", final_count)

    except Exception as e:
        logger.warning("Could not ensure Neo4j graph: %s", e)


# =============================================================================
# Document Upload Fixture
# =============================================================================


@pytest.fixture(scope="session")
def test_document(authenticated_session, gateway_url, test_collection, python_db, sync_test_data_to_python_db):
    """
    Upload art_of_war.pdf to the test collection and wait for processing.
    Skips if embeddings already exist for this collection.
    Returns dict with document_id, collection_id, and embedding_count.
    """
    collection_id = test_collection["id"]

    # Check if embeddings already exist for this collection
    try:
        cursor = python_db.cursor()
        cursor.execute(
            "SELECT COUNT(*) FROM langchain_pg_embedding WHERE collection_id = (SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1)",
            (collection_id,),
        )
        count = cursor.fetchone()[0]
        cursor.close()
        if count > 0:
            logger.info("Collection %s already has %d embeddings, skipping upload", collection_id, count)
            # Look up the document_id so tests that need it can use it
            cursor2 = python_db.cursor()
            cursor2.execute(
                "SELECT id FROM documents WHERE collection_id = %s LIMIT 1",
                (collection_id,),
            )
            doc_row = cursor2.fetchone()
            cursor2.close()
            document_id = str(doc_row[0]) if doc_row else None

            # Ensure Neo4j graph hierarchy exists (cleanup_old_test_data wipes it)
            _ensure_neo4j_graph(
                document_id=document_id,
                collection_id=collection_id,
                workspace_id=test_collection.get("workspace_id", ""),
                python_db=python_db,
            )

            return {"document_id": document_id, "collection_id": collection_id, "embedding_count": count}
    except Exception as e:
        logger.warning("Could not check existing embeddings: %s", e)
        python_db.rollback()

    # Upload art_of_war.pdf via Gateway → Kotlin Backend → gRPC → Python
    pdf_path = Path(__file__).parent / "books" / "art_of_war.pdf"
    if not pdf_path.exists():
        pytest.skip(f"Test PDF not found: {pdf_path}")

    upload_url = f"{gateway_url}/documents/upload"
    logger.info("Uploading %s to collection %s via %s", pdf_path.name, collection_id, upload_url)
    with open(pdf_path, "rb") as f:
        response = authenticated_session.post(
            upload_url,
            files={"file": (pdf_path.name, f, "application/pdf")},
            data={"collectionId": collection_id, "autoProcess": "true"},
            timeout=120,
        )

    if response.status_code == 409:
        # Document already exists — delete it and retry
        logger.info("Document already exists in collection, deleting and re-uploading")
        cursor = python_db.cursor()
        cursor.execute(
            "DELETE FROM documents WHERE collection_id = %s AND filename = %s",
            (collection_id, pdf_path.name),
        )
        python_db.commit()
        cursor.close()

        with open(pdf_path, "rb") as f:
            response = authenticated_session.post(
                upload_url,
                files={"file": (pdf_path.name, f, "application/pdf")},
                data={"collectionId": collection_id, "autoProcess": "true"},
                timeout=120,
            )

    if response.status_code not in (200, 201):
        pytest.fail(f"Document upload failed: {response.status_code} {response.text}")

    upload_data = response.json()
    document_id = upload_data.get("document_id")
    job_id = upload_data.get("job_id")
    logger.info("Document uploaded: id=%s, job_id=%s", document_id, job_id)

    # Poll processing status until complete (5 min timeout)
    # Poll via DB since the job manager is in-memory and may not be reachable via gateway
    max_wait = 300
    poll_interval = 10
    elapsed = 0
    while elapsed < max_wait:
        time.sleep(poll_interval)
        elapsed += poll_interval

        try:
            cursor = python_db.cursor()
            cursor.execute(
                "SELECT processing_status, processing_progress FROM documents WHERE id = %s",
                (document_id,),
            )
            row = cursor.fetchone()
            cursor.close()

            if not row:
                logger.warning("Document %s not found in DB", document_id)
                continue

            status = row[0]
            progress = row[1] or 0
            logger.info("Processing status: %s (%.0f%%) [%ds/%ds]", status, progress, elapsed, max_wait)

            if status in ("completed", "done"):
                break
            if status in ("failed", "error"):
                pytest.fail(f"Document processing failed for {document_id}")
        except Exception as e:
            logger.warning("Status check error: %s", e)
            python_db.rollback()

    if elapsed >= max_wait:
        pytest.fail(f"Document processing timed out after {max_wait}s")

    # Verify embeddings were created
    try:
        cursor = python_db.cursor()
        cursor.execute(
            "SELECT COUNT(*) FROM langchain_pg_embedding WHERE collection_id = (SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1)",
            (collection_id,),
        )
        embedding_count = cursor.fetchone()[0]
        cursor.close()
        logger.info("Embeddings created: %d", embedding_count)
    except Exception as e:
        logger.warning("Could not verify embeddings: %s", e)
        python_db.rollback()
        embedding_count = 0

    return {
        "document_id": document_id,
        "collection_id": collection_id,
        "embedding_count": embedding_count,
    }


# =============================================================================
# AI Response Quality Helper
# =============================================================================


def assert_meaningful_content(content: str, min_length: int = 50, topic_keywords: list[str] = None):
    """Assert that AI-generated content is meaningful, not empty/generic."""
    assert content is not None, "Content is None"
    assert len(content) >= min_length, f"Content too short ({len(content)} chars, minimum {min_length}): {content[:100]}"

    if topic_keywords:
        content_lower = content.lower()
        matched = [kw for kw in topic_keywords if kw.lower() in content_lower]
        assert len(matched) >= 1, f"Content doesn't mention any expected keywords {topic_keywords}. Content: {content[:200]}"


def get_stream_end_packet(packets: list[dict]) -> dict:
    """Extract the stream_end packet from a packet list."""
    ends = get_packets_by_type(packets, "stream_end")
    return ends[0] if ends else {}


def get_citation_scores(packets: list[dict]) -> list[float]:
    """Extract citation relevance scores from citation_info packets."""
    citations = get_packets_by_type(packets, "citation_info")
    return [c["obj"]["score"] for c in citations if c.get("obj", {}).get("score") is not None]


def get_keyword_precision(content: str, expected_keywords: list[str]) -> float:
    """Calculate keyword precision: fraction of expected keywords found in content."""
    if not expected_keywords:
        return 1.0
    content_lower = content.lower()
    matched = sum(1 for kw in expected_keywords if kw.lower() in content_lower)
    return matched / len(expected_keywords)


# =============================================================================
# Neo4j Fixtures
# =============================================================================


@pytest.fixture(scope="session")
def neo4j_driver():
    """Connect to Neo4j graph database. Skip if unavailable."""
    try:
        from neo4j import GraphDatabase
    except ImportError:
        GraphDatabase = None
        pytest.skip("neo4j driver not installed")

    # Support NEO4J_URI (set in Docker) or fallback to NEO4J_HOST:NEO4J_PORT
    neo4j_uri = os.getenv("NEO4J_URI")
    if neo4j_uri:
        uri = neo4j_uri
    else:
        neo4j_host = os.getenv("NEO4J_HOST", "localhost")
        neo4j_port = os.getenv("NEO4J_PORT", "7687")
        uri = f"bolt://{neo4j_host}:{neo4j_port}"
    neo4j_password = os.getenv("NEO4J_PASSWORD", "neo4j")
    try:
        driver = GraphDatabase.driver(uri, auth=("neo4j", neo4j_password))
        driver.verify_connectivity()
        logger.info("Connected to Neo4j at %s", uri)
        yield driver
        driver.close()
    except Exception as e:
        pytest.skip(f"Cannot connect to Neo4j: {e}")


@pytest.fixture(scope="session", autouse=False)
def cleanup_neo4j(neo4j_driver):
    """Clean all nodes from Neo4j for a fresh test environment."""
    with neo4j_driver.session() as session:
        result = session.run("MATCH (n) RETURN count(n) as count")
        count = result.single()["count"]
        if count > 0:
            logger.info("Cleaning %d nodes from Neo4j", count)
            session.run("MATCH (n) DETACH DELETE n")
        else:
            logger.info("Neo4j already empty")
    return True


# =============================================================================
# Pytest Configuration
# =============================================================================


def pytest_configure(config):
    """Configure pytest with custom markers."""
    config.addinivalue_line("markers", "integration: mark test as integration test")
    config.addinivalue_line("markers", "requires_api: mark test as requiring API server")
    config.addinivalue_line("markers", "slow: mark test as slow running")
    config.addinivalue_line("markers", "database_required: mark test as requiring database")
    config.addinivalue_line("markers", "neo4j: mark test as requiring Neo4j")
    config.addinivalue_line("markers", "postgres: mark test as requiring PostgreSQL")
    config.addinivalue_line("markers", "redis: mark test as requiring Redis")


def pytest_collection_modifyitems(config, items):
    """Automatically mark integration tests."""
    del config  # unused; pluggy requires the `config` name to match hookspec
    for item in items:
        if "integration" in str(item.fspath):
            item.add_marker(pytest.mark.integration)
