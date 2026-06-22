"""
Upload test books to the test collection via Gateway API.
Waits for processing to complete and verifies embeddings were created.

Usage:
    python upload_test_books.py [--collection-id <id>]
"""

import os
import sys
import time

import psycopg2
import psycopg2.extras
import requests

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://scrapalot-gw:8080/api/v1")
POSTGRES_HOST = os.environ.get("POSTGRES_HOST", "pgvector")
POSTGRES_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "scrapalot")

# Login credentials
USERNAME = "admin"
PASSWORD = os.getenv("TEST_PASSWORD", "admin123")

BOOKS = [
    "the_art_of_strategy.pdf",
    "meditations_on_leadership.pdf",
    "principles_of_naval_warfare.pdf",
]

BOOKS_DIR = os.path.dirname(os.path.abspath(__file__))


def get_db_connection():
    return psycopg2.connect(
        host=POSTGRES_HOST,
        port=5432,
        dbname="scrapalot",
        user="scrapalot",
        password=POSTGRES_PASSWORD,
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


def login(session):
    """Authenticate and get JWT token."""
    response = session.post(
        f"{GATEWAY_URL}/auth/login",
        json={"usernameOrEmail": USERNAME, "password": PASSWORD},
    )
    if response.status_code != 200:
        print(f"Login failed: {response.status_code} {response.text}")
        sys.exit(1)

    data = response.json()
    token = data.get("access_token") or data.get("token")
    session.headers.update({"Authorization": f"Bearer {token}"})
    print(f"Logged in as {USERNAME}")
    return session


def get_collection_id(conn):
    """Get the first collection ID from the database."""
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM langchain_pg_collection ORDER BY name LIMIT 1")
    row = cursor.fetchone()
    cursor.close()
    if not row:
        print("No collections found!")
        sys.exit(1)
    return row["name"]


def upload_book(session, collection_id, book_filename):
    """Upload a single book and return document_id."""
    filepath = os.path.join(BOOKS_DIR, book_filename)
    if not os.path.exists(filepath):
        print(f"  File not found: {filepath}")
        return None

    upload_url = f"{GATEWAY_URL}/documents/upload"
    print(f"  Uploading {book_filename} to collection {collection_id}...")

    with open(filepath, "rb") as f:
        response = session.post(
            upload_url,
            files={"file": (book_filename, f, "application/pdf")},
            data={"collectionId": collection_id, "autoProcess": "true"},
            timeout=120,
        )

    if response.status_code == 409:
        print(f"  Document {book_filename} already exists, skipping")
        return "exists"

    if response.status_code not in (200, 201):
        print(f"  Upload failed: {response.status_code} {response.text}")
        return None

    data = response.json()
    doc_id = data.get("document_id") or data.get("id")
    job_id = data.get("job_id")
    print(f"  Uploaded: document_id={doc_id}, job_id={job_id}")
    return doc_id


def wait_for_processing(conn, document_id, max_wait=300):
    """Poll processing status until complete."""
    elapsed = 0
    poll_interval = 10

    while elapsed < max_wait:
        time.sleep(poll_interval)
        elapsed += poll_interval

        cursor = conn.cursor()
        cursor.execute(
            "SELECT processing_status, processing_progress FROM documents WHERE id = %s",
            (document_id,),
        )
        row = cursor.fetchone()
        cursor.close()

        if not row:
            print(f"  Document {document_id} not found in DB")
            continue

        status = row["processing_status"]
        progress = row["processing_progress"] or 0
        print(f"  Status: {status} ({progress:.0f}%) [{elapsed}s/{max_wait}s]")

        if status in ("completed", "done"):
            return True
        if status in ("failed", "error"):
            print(f"  Processing FAILED for {document_id}")
            return False

    print(f"  Timeout after {max_wait}s")
    return False


def verify_embeddings(conn, collection_id):
    """Show embedding stats per document."""
    cursor = conn.cursor()
    cursor.execute(
        """SELECT cmetadata->>'file_name' as file_name,
                  cmetadata->>'document_id' as doc_id,
                  COUNT(*) as chunks
           FROM langchain_pg_embedding
           WHERE collection_id = (
               SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1
           )
           GROUP BY file_name, doc_id
           ORDER BY file_name""",
        (collection_id,),
    )
    rows = cursor.fetchall()
    cursor.close()

    print("\nEmbedding summary:")
    total = 0
    for r in rows:
        print(f"  {r['file_name']}: {r['chunks']} chunks (doc_id: {str(r['doc_id'])[:8]}...)")
        total += r["chunks"]
    print(f"  Total: {total} chunks across {len(rows)} documents")
    return rows


def verify_neo4j():
    """Check Neo4j for cross-book entities."""
    try:
        from neo4j import GraphDatabase

        neo4j_password = os.environ.get("NEO4J_PASSWORD", "neo4j")
        driver = GraphDatabase.driver("bolt://neo4j:7687", auth=("neo4j", neo4j_password))
        with driver.session() as session:
            # Count books
            result = session.run("MATCH (b:Book) RETURN count(b) as count")
            book_count = result.single()["count"]

            # Count entities
            result = session.run("MATCH (e) WHERE e.canonical_name IS NOT NULL RETURN count(e) as count")
            entity_count = result.single()["count"]

            # Count cross-book entities (entities linked to multiple books)
            result = session.run(
                """MATCH (b:Book)-[:HAS_CHAPTER]->()-[:HAS_SECTION]->()-[:CONTAINS]->(c:Chunk)
                   WITH c, collect(DISTINCT b.id) as book_ids
                   WHERE size(book_ids) > 1
                   RETURN count(c) as cross_chunks"""
            )
            record = result.single()
            cross_chunks = record["cross_chunks"] if record else 0

            print("\nNeo4j summary:")
            print(f"  Books: {book_count}")
            print(f"  Entities: {entity_count}")
            print(f"  Cross-book chunks: {cross_chunks}")

        driver.close()
    except Exception as e:
        print(f"\nNeo4j check failed: {e}")


def main():
    collection_id = None
    if "--collection-id" in sys.argv:
        idx = sys.argv.index("--collection-id")
        collection_id = sys.argv[idx + 1]

    conn = get_db_connection()

    if not collection_id:
        collection_id = get_collection_id(conn)
    print(f"Using collection: {collection_id}")

    session = requests.Session()
    login(session)

    document_ids = []
    for book in BOOKS:
        doc_id = upload_book(session, collection_id, book)
        if doc_id and doc_id != "exists":
            document_ids.append(doc_id)
        elif doc_id == "exists":
            document_ids.append("exists")

    # Wait for all new uploads to process
    print("\nWaiting for processing...")
    for doc_id in document_ids:
        if doc_id and doc_id != "exists":
            print(f"\nProcessing document {doc_id}...")
            success = wait_for_processing(conn, doc_id, max_wait=300)
            if not success:
                print(f"WARNING: Document {doc_id} did not complete processing")

    verify_embeddings(conn, collection_id)
    verify_neo4j()

    conn.close()
    print("\nDone!")


if __name__ == "__main__":
    main()
