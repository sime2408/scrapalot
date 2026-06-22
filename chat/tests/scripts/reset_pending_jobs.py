"""
Reset pending jobs to allow the worker to pick them up again.
This script updates job timestamps to make them appear as "new" jobs.
"""

from datetime import UTC, datetime
import sys

import psycopg2

# Fix Windows encoding for emojis
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8")


def reset_pending_jobs():
    """Reset pending jobs by updating their timestamps."""
    conn = psycopg2.connect(host="localhost", port=15432, database="scrapalot", user="scrapalot", password="scrapalot")

    cur = conn.cursor()

    # Get all pending jobs with their document info
    cur.execute("""
        SELECT
            j.id as job_id,
            j.status,
            d.title,
            d.id as document_id
        FROM jobs j
        JOIN documents d ON j.document_id = d.id
        WHERE j.status = 'pending'
        ORDER BY j.created_at DESC
    """)

    jobs = cur.fetchall()

    print("=" * 80)
    print("RESET PENDING JOBS")
    print("=" * 80)
    print(f"\nFound {len(jobs)} pending jobs")

    if not jobs:
        print("\n✓ No pending jobs to reset")
        cur.close()
        conn.close()
        return

    # Update job timestamps to current time
    print(f"\nResetting {len(jobs)} jobs to current timestamp...")

    for job_id, status, title, doc_id in jobs:
        print(f"  - {title[:60]}")

        # Update job updated_at to trigger worker pickup
        cur.execute(
            """
            UPDATE jobs
            SET updated_at = %s
            WHERE id = %s
        """,
            (datetime.now(UTC), job_id),
        )

    conn.commit()

    print(f"\n✓ Reset {len(jobs)} jobs")
    print("\n" + "=" * 80)
    print("Jobs have been reset. The worker should pick them up automatically.")
    print("Monitor worker logs: docker logs scrapalot-docprocessing --tail 100 -f")
    print("=" * 80)

    cur.close()
    conn.close()


if __name__ == "__main__":
    try:
        reset_pending_jobs()
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback

        traceback.print_exc()
        exit(1)
