#!/bin/bash
# Search arXiv for papers matching a query and output JSON lines.
#
# Usage:
#   search_arxiv.sh [max_results] [start] [query] [category]
#
# Defaults match Scrapalot's standard arXiv competitive-analysis search:
#   - query:    (empty — category-only)
#   - category: cs.CL,cs.CR,cs.AI,cs.IR  (Computation+Language, Cryptography+Security,
#               AI, Information Retrieval)
#   - max_results: 100
#   - start:    0
#   - sort:     submittedDate descending (most recent first)
#   - time filter: past 12 months
#
# CATEGORY may be a single value (e.g. "cs.AI") or a comma-separated list
# (e.g. "cs.CL,cs.CR,cs.AI"). Multiple categories are joined as (cat:X OR cat:Y OR ...).
# Passing "cs.*" yields a wildcard match (single category clause).
#
# QUERY may be empty — in that case only the category + date filters apply.
# A non-empty QUERY is ANDead with the category clause.
#
# Output: one JSON object per line with fields:
#   arxiv_id, base_id, title, abstract, authors, published, updated,
#   primary_category, categories, html_url, abs_url, pdf_url
#
# Examples:
#   search_arxiv.sh                                # default: cs.CL/cs.CR/cs.AI, no keyword
#   search_arxiv.sh 100 100                        # next 100 (page 2) with default scope
#   search_arxiv.sh 100 0 "all:RAG"                # add RAG keyword on top of default categories
#   search_arxiv.sh 100 0 "" "cs.AI"               # single category, no keyword
#   search_arxiv.sh 100 0 "all:agent" "cs.AI,cs.CL"  # keyword + two categories

set -euo pipefail

MAX_RESULTS=${1:-100}
START=${2:-0}
QUERY=${3:-""}
CATEGORY=${4:-"cs.CL,cs.CR,cs.AI,cs.IR"}

# Restrict to past 12 months using the arXiv API submittedDate range syntax.
# Format: submittedDate:[YYYYMMDDHHMM+TO+YYYYMMDDHHMM]
TO_DATE=$(date -u +%Y%m%d%H%M)
FROM_DATE=$(date -u -d '12 months ago' +%Y%m%d%H%M 2>/dev/null || date -u -v-12m +%Y%m%d%H%M)

# Build the category clause. Single category → cat:VAL.
# Comma-separated list → (cat:A+OR+cat:B+OR+...) wrapped in parentheses.
if [[ "${CATEGORY}" == *","* ]]; then
    IFS=',' read -ra CAT_LIST <<< "${CATEGORY}"
    CAT_CLAUSE=""
    for c in "${CAT_LIST[@]}"; do
        c_trimmed=$(echo "$c" | xargs)
        [[ -z "$c_trimmed" ]] && continue
        if [[ -z "$CAT_CLAUSE" ]]; then
            CAT_CLAUSE="cat:${c_trimmed}"
        else
            CAT_CLAUSE="${CAT_CLAUSE}+OR+cat:${c_trimmed}"
        fi
    done
    CAT_CLAUSE="(${CAT_CLAUSE})"
else
    CAT_CLAUSE="cat:${CATEGORY}"
fi

# Build search_query. Drop the QUERY clause entirely when empty so the URL stays valid.
if [[ -z "${QUERY}" ]]; then
    SEARCH_QUERY="${CAT_CLAUSE}+AND+submittedDate:[${FROM_DATE}+TO+${TO_DATE}]"
else
    SEARCH_QUERY="${QUERY}+AND+${CAT_CLAUSE}+AND+submittedDate:[${FROM_DATE}+TO+${TO_DATE}]"
fi

URL="https://export.arxiv.org/api/query?search_query=${SEARCH_QUERY}&start=${START}&max_results=${MAX_RESULTS}&sortBy=submittedDate&sortOrder=descending"

echo "Fetching: ${URL}" >&2

python3 - "$URL" <<'PYEOF'
import json
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

NS = {
    'atom': 'http://www.w3.org/2005/Atom',
    'arxiv': 'http://arxiv.org/schemas/atom',
}

url = sys.argv[1]

# arXiv enforces a strict ~1 req / 3s budget across their public API. Once their
# throttler decides we are over-eager it locks the IP into a multi-minute (sometimes
# multi-hour) cooldown — and every retry during that cooldown extends it further.
#
# Their February 2026 enforcement update made 3 s spacing insufficient on its own
# (https://groups.google.com/a/arxiv.org/g/api/c/ycq8giRdZsQ). Three-part defence:
#
#   1) Cross-invocation state file at /tmp/last_arxiv_fetch_ts records the last
#      successful fetch's epoch seconds. If the user re-runs the skill within
#      MIN_INVOCATION_GAP s of the last fetch, we sleep until that gap elapses
#      BEFORE the 3 s in-script pre-sleep. Survives across separate `bash
#      search_arxiv.sh` calls within one shell session.
#   2) Pre-request sleep of 3 s on top of the cross-invocation gap, regardless of
#      whether a gap was honoured.
#   3) Retry budget on 429/503 = max 3 attempts with 60 s → 180 s backoff. 15 s
#      was too short under post-Feb-2026 enforcement and just deepened the IP
#      cooldown; 60 s + 180 s is more honest to arxiv's actual recovery window.

MIN_INVOCATION_GAP = 15  # seconds between successive skill invocations
STATE_FILE = "/tmp/last_arxiv_fetch_ts"

import os as _os
try:
    with open(STATE_FILE) as _f:
        _last_ts = float(_f.read().strip() or 0)
    _elapsed = time.time() - _last_ts
    if 0 <= _elapsed < MIN_INVOCATION_GAP:
        _wait = MIN_INVOCATION_GAP - _elapsed
        print(f"Cross-invocation gap: last fetch {_elapsed:.1f}s ago, sleeping {_wait:.1f}s extra", file=sys.stderr)
        time.sleep(_wait)
except FileNotFoundError:
    pass
except Exception as _e:  # pragma: no cover — state file is best-effort, never blocking
    print(f"State file unreadable ({_e}); continuing without cross-invocation gap", file=sys.stderr)

print("Pre-request sleep 3s (arXiv rate-limit defence)...", file=sys.stderr)
time.sleep(3)

attempts = 0
max_attempts = 3
while True:
    attempts += 1
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'scrapalot-competitive-analysis/1.0 (mailto:simun.sunjic@gmail.com)',
        })
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
        # Record successful fetch timestamp for cross-invocation gap.
        try:
            with open(STATE_FILE, "w") as _f:
                _f.write(str(time.time()))
        except Exception:  # pragma: no cover — state file is best-effort
            pass
        break
    except urllib.error.HTTPError as e:
        if e.code in (429, 503) and attempts < max_attempts:
            # 60 s base, exponential: attempt 1 → 60s, attempt 2 → 180s. Capped at 300s.
            wait_s = min(300, 60 * (3 ** (attempts - 1)))
            print(f"arXiv {e.code} (attempt {attempts}/{max_attempts}); sleeping {wait_s}s", file=sys.stderr)
            time.sleep(wait_s)
            continue
        print(f"ERROR: arXiv HTTP {e.code}: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        if attempts >= max_attempts:
            print(f"ERROR: failed to fetch arXiv after {attempts} attempts: {e}", file=sys.stderr)
            sys.exit(1)
        time.sleep(5 * attempts)

root = ET.fromstring(data)

count = 0
for entry in root.findall('atom:entry', NS):
    abs_url = (entry.findtext('atom:id', '', NS) or '').strip()
    if not abs_url:
        continue
    arxiv_id_full = abs_url.rsplit('/', 1)[-1]
    base_id = arxiv_id_full.split('v')[0] if 'v' in arxiv_id_full else arxiv_id_full

    title = ' '.join((entry.findtext('atom:title', '', NS) or '').split())
    summary = ' '.join((entry.findtext('atom:summary', '', NS) or '').split())
    published = (entry.findtext('atom:published', '', NS) or '').strip()
    updated = (entry.findtext('atom:updated', '', NS) or '').strip()

    authors = [
        (a.findtext('atom:name', '', NS) or '').strip()
        for a in entry.findall('atom:author', NS)
    ]
    authors = [a for a in authors if a]

    primary_cat_el = entry.find('arxiv:primary_category', NS)
    primary_cat = primary_cat_el.get('term') if primary_cat_el is not None else ''
    categories = [c.get('term') for c in entry.findall('atom:category', NS) if c.get('term')]

    obj = {
        'arxiv_id': arxiv_id_full,
        'base_id': base_id,
        'title': title,
        'abstract': summary,
        'authors': authors,
        'published': published,
        'updated': updated,
        'primary_category': primary_cat,
        'categories': categories,
        'html_url': f'https://arxiv.org/html/{arxiv_id_full}',
        'abs_url': f'https://arxiv.org/abs/{arxiv_id_full}',
        'pdf_url': f'https://arxiv.org/pdf/{arxiv_id_full}',
    }
    print(json.dumps(obj, ensure_ascii=False))
    count += 1

print(f"Returned {count} papers", file=sys.stderr)
PYEOF
