"""Reset alchemy collection documents to pending and clean batch jobs."""

from sqlalchemy import text

from src.main.config.database import SessionLocal

db = SessionLocal()
cid = "3c3ce885-c40b-4f7a-a609-d19530105e22"

# Reset non-pending docs
r1 = db.execute(
    text("UPDATE documents SET processing_status = 'pending', processing_error = NULL WHERE collection_id = :cid AND processing_status != 'pending'"),
    {"cid": cid},
)
db.commit()
print(f"Reset {r1.rowcount} documents to pending")

# Delete batch jobs
r2 = db.execute(text("DELETE FROM jobs WHERE job_id LIKE 'batch-%%'"))
db.commit()
print(f"Deleted {r2.rowcount} batch jobs")

# Verify
rows = db.execute(
    text("SELECT processing_status, COUNT(*) FROM documents WHERE collection_id = :cid GROUP BY processing_status"),
    {"cid": cid},
).fetchall()
for r in rows:
    print(f"  {r[0]}: {r[1]}")

db.close()
