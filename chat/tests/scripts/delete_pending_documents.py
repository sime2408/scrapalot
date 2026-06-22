"""
Delete all pending documents and their associated jobs.
"""

import sys

import psycopg2

# Fix Windows encoding for emojis
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

DB_CONFIG = {"host": "localhost", "port": 15432, "database": "scrapalot", "user": "scrapalot", "password": "scrapalot"}


def delete_pending_documents():
    """Delete all pending documents and jobs."""
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()

    # Get count before deletion
    cur.execute("SELECT COUNT(*) FROM documents WHERE processing_status = 'pending'")
    doc_count = cur.fetchone()[0]

    cur.execute("SELECT COUNT(*) FROM jobs WHERE status = 'pending'")
    job_count = cur.fetchone()[0]

    print("=" * 80)
    print("DELETE PENDING DOCUMENTS AND JOBS")
    print("=" * 80)
    print("\nFound:")
    print(f"  - {doc_count} pending documents")
    print(f"  - {job_count} pending jobs")

    if doc_count == 0 and job_count == 0:
        print("\n✓ No pending items to delete")
        cur.close()
        conn.close()
        return

    # Delete jobs first (due to foreign key constraints)
    print(f"\nDeleting {job_count} pending jobs...")
    cur.execute("DELETE FROM jobs WHERE status = 'pending'")
    deleted_jobs = cur.rowcount

    # Delete documents
    print(f"Deleting {doc_count} pending documents...")
    cur.execute("DELETE FROM documents WHERE processing_status = 'pending'")
    deleted_docs = cur.rowcount

    conn.commit()

    print("\n✓ Deleted:")
    print(f"  - {deleted_docs} documents")
    print(f"  - {deleted_jobs} jobs")
    print("=" * 80)

    cur.close()
    conn.close()


if __name__ == "__main__":
    try:
        delete_pending_documents()
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback

        traceback.print_exc()
        exit(1)
