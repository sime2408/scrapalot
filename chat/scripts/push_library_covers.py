#!/usr/bin/env python3
"""Batch cover-thumbnail backfill for a library workspace subtree.

Companion to ``ingest_library.py`` / the dataset-generator ``--upload-db`` path.
The ingest writes documents + embeddings to the PROD DB over the SSH tunnel but
does NOT ship cover images (per-book SSH throttled ingest and was flaky). This
script fills covers in one decoupled, reliable pass:

  1. Read every document in the target collection tree that lacks a cover.
  2. Generate ``{stem}_thumb_large.png`` from the source file (host-native read
     of E:\\_KNJIGE) via the production ``ThumbnailService`` into a LOCAL staging
     tree mirroring the prod upload path.
  3. Ship ALL covers to the remote container's upload volume in a SINGLE
     tar-over-ssh (one connection — reliable, unlike per-book scp/docker-cp).
  4. Mark ``file_metadata.thumbnail.has_thumbnail = true`` for the covered docs.

Runs on the HOST (needs E:\\_KNJIGE + the SSH tunnel on localhost:15432 + ssh to
the prod host). Safe to re-run: already-covered docs are skipped.

    python scripts/push_library_covers.py --root E:/_KNJIGE/psychology --workspace books --ssh-host hetzner-scrapalot
"""
from __future__ import annotations

import argparse
import json
import os
import posixpath
import shutil
import subprocess
import sys
import tempfile

# Make the repo root importable (script lives in scripts/; src/ is at the root).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2
import psycopg2.extras

DB = dict(host="localhost", port=15432, user="scrapalot", password="scrapalot", connect_timeout=8)
SUPPORTED = {".pdf", ".epub"}


def log(msg: str) -> None:
    print(msg, flush=True)


def resolve_workspace(name: str) -> str:
    c = psycopg2.connect(dbname="scrapalot_backend", options="-c search_path=scrapalot,public", **DB)
    try:
        cur = c.cursor()
        cur.execute("SELECT id::text FROM scrapalot.workspaces WHERE lower(name)=lower(%s) LIMIT 1", (name,))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"workspace '{name}' not found")
        return row[0]
    finally:
        c.close()


def collection_tree(workspace_id: str, root_name: str) -> dict[str, str]:
    """Return {collection_id: collection_name} for the root collection + its children."""
    c = psycopg2.connect(dbname="scrapalot_backend", options="-c search_path=scrapalot,public", **DB)
    try:
        cur = c.cursor()
        cur.execute(
            "SELECT id::text FROM scrapalot.collections WHERE workspace_id=%s AND lower(name)=lower(%s) LIMIT 1",
            (workspace_id, root_name),
        )
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"root collection '{root_name}' not found in workspace")
        root_id = row[0]
        cur.execute(
            "SELECT id::text, name FROM scrapalot.collections WHERE id=%s OR parent_collection_id=%s",
            (root_id, root_id),
        )
        return {cid: name for cid, name in cur.fetchall()}
    finally:
        c.close()


def build_source_index(root: str, root_name: str) -> dict[tuple[str, str], str]:
    """Map (collection_name, filename) -> absolute host path of the source file.

    Files directly under ``root`` belong to collection ``root_name``; files in a
    sub-folder belong to that top-level sub-folder's collection (matches the
    ingest's derive_collection_name).
    """
    index: dict[tuple[str, str], str] = {}
    root = root.rstrip("/\\")
    for dirpath, _dirs, files in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        coll = root_name if rel == "." else rel.replace("\\", "/").split("/")[0]
        for fn in files:
            index.setdefault((coll, fn), os.path.join(dirpath, fn))
    return index


def docs_needing_cover(collection_ids: list[str], limit: int) -> list[dict]:
    c = psycopg2.connect(dbname="scrapalot", **DB)
    try:
        cur = c.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cur.execute(
            """SELECT id::text, file_path, collection_id::text,
                      file_metadata->>'original_filename' AS original_filename
               FROM documents
               WHERE collection_id = ANY(%s::uuid[])
                 AND deleted_at IS NULL
                 AND COALESCE(file_metadata->'thumbnail'->>'has_thumbnail','') <> 'true'
               ORDER BY created_at""",
            (collection_ids,),
        )
        rows = [dict(r) for r in cur.fetchall()]
        return rows[:limit] if limit else rows
    finally:
        c.close()


def mark_covered(doc_ids: list[str]) -> None:
    if not doc_ids:
        return
    c = psycopg2.connect(dbname="scrapalot", **DB)
    try:
        cur = c.cursor()
        cur.execute(
            """UPDATE documents
               SET file_metadata = COALESCE(file_metadata,'{}'::jsonb)
                   || jsonb_build_object('thumbnail',
                        jsonb_build_object('sizes', jsonb_build_array('large'),
                                           'has_custom', false, 'has_thumbnail', true))
               WHERE id = ANY(%s::uuid[])""",
            (doc_ids,),
        )
        c.commit()
    finally:
        c.close()


def main() -> None:
    ap = argparse.ArgumentParser(description="Batch-backfill document cover thumbnails over SSH.")
    ap.add_argument("--root", required=True, help="Host source dir, e.g. E:/_KNJIGE/psychology")
    ap.add_argument("--workspace", default="books")
    ap.add_argument("--ssh-host", required=True, help="SSH alias of the prod host, e.g. hetzner-scrapalot")
    ap.add_argument("--container", default="scrapalot-chat")
    ap.add_argument("--upload-root", default="/app/data/upload")
    ap.add_argument("--limit", type=int, default=0, help="cover at most N docs (0 = all)")
    args = ap.parse_args()

    from src.main.service.document.thumbnail_service import ThumbnailService

    root_name = os.path.basename(args.root.rstrip("/\\"))
    workspace_id = resolve_workspace(args.workspace)
    tree = collection_tree(workspace_id, root_name)
    log(f"workspace={workspace_id} collections={len(tree)} (root '{root_name}')")

    docs = docs_needing_cover(list(tree.keys()), args.limit)
    log(f"docs needing cover: {len(docs)}")
    if not docs:
        return

    log("indexing source files on host ...")
    index = build_source_index(args.root, root_name)
    log(f"indexed {len(index)} source files")

    staging = tempfile.mkdtemp(prefix="scrapalot_covers_")
    generated: list[str] = []
    missing_src = 0
    gen_fail = 0
    try:
        for d in docs:
            coll_name = tree.get(d["collection_id"], root_name)
            orig = d["original_filename"] or os.path.basename(d["file_path"])
            src = index.get((coll_name, orig))
            if not src or not os.path.exists(src):
                missing_src += 1
                continue
            ext = os.path.splitext(src)[1].lower()
            if ext not in SUPPORTED:
                continue
            rel = d["file_path"].split("data/upload/", 1)[-1]              # {user}/{ws}/{coll}/{sanitized}.ext
            stem = posixpath.splitext(posixpath.basename(rel))[0]
            cover_rel = posixpath.join(posixpath.dirname(rel), f"{stem}_thumb_large.png")
            dest = os.path.join(staging, *cover_rel.split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            try:
                if ext == ".pdf":
                    out = ThumbnailService.generate_pdf_thumbnail(src, output_path=dest)
                else:
                    out = ThumbnailService.generate_epub_thumbnail(src, output_path=dest)
            except Exception as e:  # noqa: BLE001
                gen_fail += 1
                log(f"  gen fail: {orig[:50]} — {str(e)[:80]}")
                continue
            if out and os.path.exists(dest):
                generated.append(d["id"])
            else:
                gen_fail += 1

        log(f"covers generated: {len(generated)} (missing source: {missing_src}, gen failures: {gen_fail})")
        if not generated:
            return

        # One bulk tar-over-ssh transfer (reliable; relative paths land under upload-root).
        log("shipping covers to prod (single tar-over-ssh) ...")
        tar = subprocess.Popen(["tar", "-C", staging, "-cf", "-", "."], stdout=subprocess.PIPE)
        ssh = subprocess.Popen(
            ["ssh", "-o", "ConnectTimeout=20", "-o", "BatchMode=yes", args.ssh_host,
             f"docker exec -i {args.container} tar xf - -C {args.upload_root}"],
            stdin=tar.stdout,
        )
        tar.stdout.close()
        ssh.communicate()
        if ssh.returncode != 0:
            raise SystemExit(f"cover tar-over-ssh failed (rc={ssh.returncode}); file_metadata NOT marked")
        log("transfer OK; marking file_metadata ...")
        mark_covered(generated)
        log(f"DONE: {len(generated)} covers pushed + marked")
    finally:
        shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    main()
