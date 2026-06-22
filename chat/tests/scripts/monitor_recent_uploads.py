"""
Monitor recently uploaded documents and wait for processing completion.
"""

import sys
import time

import psycopg2

# Fix Windows encoding for emojis
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")

DB_CONFIG = {"host": "localhost", "port": 15432, "database": "scrapalot", "user": "scrapalot", "password": "scrapalot"}


def get_recent_documents(minutes=10):
    """Get documents uploaded in the last N minutes."""
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()

    cur.execute(f"""
        SELECT id, title, processing_status, created_at
        FROM documents
        WHERE created_at > NOW() - INTERVAL '{minutes} minutes'
        ORDER BY created_at DESC
    """)

    docs = cur.fetchall()
    cur.close()
    conn.close()

    return docs


def monitor_processing(document_ids: list[str], timeout: int = 7200):
    """
    Monitor document processing progress.

    Args:
        document_ids: List of document IDs to monitor
        timeout: Maximum time to wait in seconds (default 2 hours)
    """
    conn = psycopg2.connect(**DB_CONFIG)
    start_time = time.time()
    check_interval = 30  # Check every 30 seconds

    print(f"\nMonitoring {len(document_ids)} documents...")
    print("=" * 80)

    completed = []
    failed = []
    last_completed_count = 0

    while time.time() - start_time < timeout:
        cur = conn.cursor()

        # Get status for all documents
        placeholders = ",".join(["%s"] * len(document_ids))
        cur.execute(
            f"""
            SELECT id, title, processing_status, processing_error,
                   document_hierarchy IS NOT NULL as has_hierarchy
            FROM documents
            WHERE id::text IN ({placeholders})
            ORDER BY created_at DESC
            """,
            tuple(document_ids),
        )
        results = cur.fetchall()
        cur.close()

        pending_count = 0
        processing_count = 0
        completed_count = 0
        failed_count = 0

        for doc_id, title, status, error, has_hierarchy in results:
            if status == "completed":
                if str(doc_id) not in completed:
                    completed.append(str(doc_id))
                    # Print when document completes
                    if len(completed) > last_completed_count:
                        hierarchy_status = "✓" if has_hierarchy else "⚠️ "
                        print(f"  {hierarchy_status} [{len(completed)}/{len(document_ids)}] {title[:65]}")
                        last_completed_count = len(completed)
                completed_count += 1
            elif status == "failed":
                if str(doc_id) not in failed:
                    failed.append(str(doc_id))
                    print(f"  ❌ Failed: {title[:60]} - {error}")
                failed_count += 1
            elif status == "processing":
                processing_count += 1
            else:
                pending_count += 1

        # Print progress summary
        elapsed_min = int((time.time() - start_time) / 60)
        elapsed_sec = int((time.time() - start_time) % 60)
        print(
            f"\n[{elapsed_min}m {elapsed_sec}s] Status: Pending={pending_count}, Processing={processing_count}, Completed={completed_count}, Failed={failed_count}"
        )
        print("=" * 80)

        # Check if all done
        if completed_count + failed_count == len(document_ids):
            print("\nAll documents processed!")
            break

        time.sleep(check_interval)

    conn.close()

    return {"completed": completed, "failed": failed, "total_time": time.time() - start_time}


def get_hierarchy_stats(document_ids: list[str]):
    """Get hierarchy extraction statistics."""
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()

    placeholders = ",".join(["%s"] * len(document_ids))
    cur.execute(
        f"""
        SELECT
            COUNT(*) as total_completed,
            COUNT(document_hierarchy) as with_hierarchy,
            AVG(page_count) as avg_pages,
            AVG(word_count) as avg_words
        FROM documents
        WHERE id::text IN ({placeholders})
        AND processing_status = 'completed'
        """,
        tuple(document_ids),
    )

    stats = cur.fetchone()
    cur.close()
    conn.close()

    return stats


def get_chunk_stats(document_ids: list[str]):
    """Get chunk embedding statistics."""
    conn = psycopg2.connect(**DB_CONFIG)
    cur = conn.cursor()

    # Total chunks
    cur.execute(
        """
        SELECT COUNT(*)
        FROM langchain_pg_embedding
        WHERE cmetadata->>'document_id' = ANY(%s)
        """,
        ([str(d) for d in document_ids],),
    )
    total_chunks = cur.fetchone()[0]

    # Enriched chunks (with hierarchy metadata)
    cur.execute(
        """
        SELECT COUNT(*)
        FROM langchain_pg_embedding
        WHERE cmetadata->>'document_id' = ANY(%s)
        AND cmetadata->>'section_heading' IS NOT NULL
        """,
        ([str(d) for d in document_ids],),
    )
    enriched_chunks = cur.fetchone()[0]

    cur.close()
    conn.close()

    return total_chunks, enriched_chunks


def main():
    print("=" * 80)
    print("MONITOR RECENT DOCUMENT UPLOADS")
    print("=" * 80)

    # Get documents uploaded in last 10 minutes
    print("\n[1/3] Fetching recently uploaded documents...")
    docs = get_recent_documents(minutes=10)

    if not docs:
        print("\n⚠️  No documents found in last 10 minutes")
        return

    print(f"✓ Found {len(docs)} documents")

    # Show status breakdown
    status_counts = {}
    for doc_id, title, status, created_at in docs:
        status_counts[status] = status_counts.get(status, 0) + 1

    print("\nStatus breakdown:")
    for status, count in sorted(status_counts.items()):
        print(f"  - {status}: {count}")

    # Extract document IDs
    doc_ids = [str(doc[0]) for doc in docs]

    # Monitor processing
    print("\n[2/3] Monitoring processing (timeout: 120 minutes)...")
    result = monitor_processing(doc_ids, timeout=7200)

    # Final statistics
    print("\n[3/3] Generating final statistics...")

    # Hierarchy stats
    # noinspection PyTypeChecker
    total_completed, with_hierarchy, avg_pages, avg_words = get_hierarchy_stats(result["completed"])

    # Chunk stats
    # noinspection PyTypeChecker
    total_chunks, enriched_chunks = get_chunk_stats(result["completed"])

    # Print final report
    print("\n" + "=" * 80)
    print("PHASE 1 PROCESSING - FINAL RESULTS")
    print("=" * 80)

    print("\nProcessing Summary:")
    print(f"  Total documents: {len(docs)}")
    # noinspection PyTypeChecker
    print(f"  Completed: {len(result['completed'])}")
    # noinspection PyTypeChecker
    print(f"  Failed: {len(result['failed'])}")
    print(f"  Processing time: {result['total_time'] / 60:.1f} minutes")

    if total_completed > 0:
        print("\nDocument Statistics:")
        print(f"  Average pages: {avg_pages:.1f}" if avg_pages else "  Average pages: N/A")
        print(f"  Average words: {avg_words:.0f}" if avg_words else "  Average words: N/A")

        print("\nHierarchy Extraction:")
        print(f"  Documents with hierarchy: {with_hierarchy}/{total_completed}")
        print(f"  Extraction rate: {(with_hierarchy / total_completed * 100):.1f}%")

    if total_chunks > 0:
        print("\nChunk Enrichment:")
        print(f"  Total chunks: {total_chunks}")
        print(f"  Enriched chunks: {enriched_chunks}")
        print(f"  Enrichment rate: {(enriched_chunks / total_chunks * 100):.1f}%")

    print("\n" + "=" * 80)
    print("MONITORING COMPLETE")
    print("=" * 80)

    print("\nNext Steps:")
    print("  1. Run: python tests/test_phase1_demonstration.py")
    print("  2. Open Neo4j Browser: http://localhost:7474")
    print("  3. Enable Neo4j sync and populate graph")
    print("  4. Verify graph structure")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n⚠️  Monitoring interrupted by user")
        exit(0)
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback

        traceback.print_exc()
        exit(1)
