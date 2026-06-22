#!/usr/bin/env python3
"""Show current dataset generation progress."""

import os
import sqlite3

os.chdir(os.path.dirname(os.path.abspath(__file__)) + "/..")


def a(text, width=0):
    """ASCII-safe string — replace non-ASCII with '?'."""
    result = str(text).encode("ascii", "replace").decode("ascii")
    return result[:width] if width else result


import argparse  # noqa: E402

parser = argparse.ArgumentParser(description="Show dataset generation progress.")
parser.add_argument("db_or_name", nargs="?", default=None, help="State DB path or dataset name (e.g. 'ufo')")
parser.add_argument("--dataset", "-d", default=None, help="Dataset name (resolves to datasets/{name}_state.db)")
args = parser.parse_args()

name_or_path = args.dataset or args.db_or_name
if name_or_path is None:
    # Default: show all available state DBs
    import glob as _glob

    dbs = sorted(_glob.glob("datasets/*_state.db"))
    if not dbs:
        print("No state DBs found in datasets/")
        raise SystemExit
    if len(dbs) == 1:
        db = dbs[0]
    else:
        print("Available datasets: %s" % ", ".join(os.path.basename(d).replace("_state.db", "") for d in dbs))
        print("Usage: python scripts/check_progress.py --dataset <name>")
        raise SystemExit
elif name_or_path.endswith(".db"):
    db = name_or_path
else:
    db = "datasets/%s_state.db" % name_or_path

if not os.path.exists(db):
    print("DB not yet created: %s" % db)
    raise SystemExit

conn = sqlite3.connect(db)
conn.row_factory = sqlite3.Row

books = conn.execute("SELECT file_path, title, status, processed_chapters, total_chapters, qa_pairs_generated FROM books ORDER BY id").fetchall()

counts = {}
for b in books:
    counts[b["status"]] = counts.get(b["status"], 0) + 1

total = len(books)
done = counts.get("completed", 0)
failed = counts.get("failed", 0)
skipped = counts.get("skipped", 0)
inprog = counts.get("in_progress", 0)
total_pairs = sum(b["qa_pairs_generated"] for b in books)

print("=== PROGRESS: %d/%d books ===" % (done, total))
print("  completed  : %d" % done)
print("  in_progress: %d" % inprog)
print("  failed     : %d" % failed)
print("  skipped    : %d" % skipped)
print("  pending    : %d" % counts.get("pending", 0))
print("  total pairs: %d" % total_pairs)

# Show active book + its chapters (filter by exact file_path)
active = [b for b in books if b["status"] == "in_progress"]
if active:
    b = active[0]
    chapters = conn.execute(
        "SELECT chapter_number, chapter_title, status FROM chapters WHERE book_file_path = ? ORDER BY chapter_number", (b["file_path"],)
    ).fetchall()
    completed_ch = sum(1 for c in chapters if c["status"] == "completed")
    print("\nCurrently: %s" % a(b["title"], 70))
    print("  chapters done: %d/%s" % (completed_ch, str(len(chapters)) if chapters else "?"))
    for c in chapters[-6:]:
        print("  Ch%02d %-12s %s" % (c["chapter_number"], c["status"], a(c["chapter_title"], 55)))

# Failed books
failed_books = [b for b in books if b["status"] == "failed"]
if failed_books:
    print("\nFailed (%d):" % len(failed_books))
    for b in failed_books[:5]:
        print("  ! %s" % a(b["title"], 70))

# Recent completions
recent = [b for b in books if b["status"] == "completed"][-5:]
if recent:
    print("\nLast completed:")
    for b in recent:
        print("  + %s (%d pairs)" % (a(b["title"], 60), b["qa_pairs_generated"]))

conn.close()
