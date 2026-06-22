#!/usr/bin/env python3
"""Delete duplicate book files: (1)/(2)/... copies and PDFs where EPUB exists."""

import os
import re
import sys

folder = sys.argv[1] if len(sys.argv) > 1 else "E:/_KNJIGE/ufo"

files = [f for f in os.listdir(folder) if f.lower().endswith((".pdf", ".epub"))]
to_delete = []

numbered_re = re.compile(r"^(.+?) \(\d+\)(\.(?:pdf|epub))$", re.IGNORECASE)

# Pass 1: numbered duplicates
for f in files:
    if numbered_re.match(f):
        to_delete.append(f)

# Pass 2: PDF when EPUB of same title exists
base_to_formats = {}
for f in files:
    if numbered_re.match(f):
        continue
    name, ext = os.path.splitext(f)
    base_to_formats.setdefault(name.lower(), []).append((ext.lower(), f))

for key, formats in base_to_formats.items():
    exts = {e for e, _ in formats}
    if ".pdf" in exts and ".epub" in exts:
        pdf_file = next(fn for e, fn in formats if e == ".pdf")
        to_delete.append(pdf_file)

deleted = 0
for f in to_delete:
    path = os.path.join(folder, f)
    try:
        os.remove(path)
        deleted += 1
        print("Deleted: %s" % f[:100])
    except OSError as e:
        print(f"ERROR: {f[:80]} — {e}")

print("\nDeleted %d files. Remaining: %d" % (deleted, len(files) - deleted))
