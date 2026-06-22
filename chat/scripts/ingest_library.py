#!/usr/bin/env python3
"""Generic bulk-ingest driver for any ``/knjige`` subtree.

Ingests a whole library subtree into a Scrapalot workspace by calling the
**production** ``DocumentExtras.UploadDocument`` gRPC with ``store_file=false``
(row marked ``file_stored=false`` — physical file absent) and
``auto_process=true``. That single call drives the canonical pipeline exactly
like a real user upload: parse (pymupdf4llm / pymupdf4llm-layout / epub) ->
chunk -> embed -> document_hierarchy -> **thumbnail**, plus document_summaries
when ``--summary`` and the Neo4j graph when ``--graph``.

This supersedes the per-collection drivers (e.g. ``ingest_spirituality.py``):
one parameterised tool for every collection. Collections are derived from the
folder structure under ``--root``:

    <root>/<file>          -> collection = basename(<root>)   (depth 0, no parent)
    <root>/<sub>/<file>    -> collection = <sub>              (depth 1, parent = root)

Collections are found-or-created in the Kotlin DB (source of truth) and
re-asserted in ``collection_workspace_map`` right before each upload (the same
self-heal ``ingest_spirituality.py`` uses).

OCR/scanned PDFs are detected up front with the production
``analyze_pdf_document`` heuristic and are NOT uploaded in this pass — they are
collected into the final report for a later Docling/GPU run.

Operator wrapper (Rule #10): all real logic lives in src/ and is reached via the
gRPC server + ``analyze_pdf_document``. Run INSIDE the chat container (needs
localhost:9091 and the /knjige mount)::

    docker exec scrapalot-chat python /app/scripts/ingest_library.py \
        --root /knjige/psychology --workspace books
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from uuid import UUID, uuid4

sys.path.insert(0, "/app")
sys.path.insert(0, "/app/src/main/grpc")

import grpc  # noqa: E402
import psycopg2  # noqa: E402
import document_extras_pb2 as pb  # noqa: E402
import document_extras_pb2_grpc as pbg  # noqa: E402
from sqlalchemy import text  # noqa: E402

from src.main.config.database import SessionLocal  # noqa: E402
from src.main.service.collection_workspace_cache import upsert_collection_workspace  # noqa: E402
from src.main.service.document.document_processor_pdf import analyze_pdf_document  # noqa: E402
from src.main.utils.documents.utils import is_valid_document_type, sanitize_filename  # noqa: E402

GRPC_LIMIT = 50 * 1024 * 1024
MAX_BYTES = 49 * 1024 * 1024  # leave headroom under the 50MB gRPC frame
SUPPORTED_EXT = {".pdf", ".epub", ".docx", ".md", ".txt", ".csv", ".rtf"}

# Direct Kotlin/Python DB access (collections are Kotlin-owned). Inside the
# container the prod DB is reached over the SSH-tunnel sidecar.
DB_HOST = os.environ.get("CHAT_POSTGRES_HOST", "host.docker.internal")
DB_PORT = int(os.environ.get("CHAT_POSTGRES_PORT", "15432"))
DB_USER = os.environ.get("POSTGRES_USER", "scrapalot")
DB_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "scrapalot")
KOTLIN_DB = os.environ.get("POSTGRES_BACKEND_DB", "scrapalot_backend")


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _kotlin_conn():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, user=DB_USER, password=DB_PASSWORD,
        dbname=KOTLIN_DB, options="-c search_path=scrapalot,public",
    )


# ---------------------------------------------------------------------------
# Workspace + collection resolution (Kotlin DB is the source of truth)
# ---------------------------------------------------------------------------


def resolve_workspace(name: str) -> tuple[str, str]:
    """Return (workspace_id, owner_user_id) for the named workspace."""
    k = _kotlin_conn()
    try:
        cur = k.cursor()
        cur.execute(
            "SELECT id::text, user_id::text FROM scrapalot.workspaces WHERE lower(name) = lower(%s) LIMIT 1",
            (name,),
        )
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"Workspace '{name}' not found in {KOTLIN_DB}. Create it in the UI first.")
        return row[0], row[1]
    finally:
        k.close()


def _unique_slug(cur, workspace_id: str, name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "collection"
    slug, counter = base, 2
    while True:
        cur.execute(
            "SELECT 1 FROM scrapalot.collections WHERE workspace_id = %s AND slug = %s",
            (workspace_id, slug),
        )
        if cur.fetchone() is None:
            return slug
        slug = f"{base}-{counter}"
        counter += 1


def find_or_create_collection(
    workspace_id: str, name: str, *, parent_id: str | None, depth: int
) -> str:
    """Find a collection by (workspace, name) or create it in the Kotlin DB."""
    k = _kotlin_conn()
    try:
        cur = k.cursor()
        cur.execute(
            "SELECT id::text FROM scrapalot.collections WHERE workspace_id = %s AND lower(name) = lower(%s) LIMIT 1",
            (workspace_id, name),
        )
        row = cur.fetchone()
        if row:
            return row[0]
        cid = str(uuid4())
        slug = _unique_slug(cur, workspace_id, name)
        cur.execute(
            """INSERT INTO scrapalot.collections
               (id, name, slug, workspace_id, parent_collection_id, chunking_strategy,
                chunk_size, chunk_overlap, depth, sort_order, is_processing,
                created_at, updated_at)
               VALUES (%s, %s, %s, %s, %s, 'recursive', 1000, 200, %s, 0, false, NOW(), NOW())""",
            (cid, name, slug, workspace_id, parent_id, depth),
        )
        k.commit()
        log(f"created collection '{name}' (id={cid}, slug={slug}, depth={depth})")
        return cid
    finally:
        k.close()


def collection_meta(cid: str) -> dict:
    k = _kotlin_conn()
    try:
        cur = k.cursor()
        cur.execute(
            "SELECT name, workspace_id::text, description, depth, parent_collection_id::text "
            "FROM scrapalot.collections WHERE id::text = %s",
            (cid,),
        )
        name, wsid, desc, depth, parent = cur.fetchone()
        return {"name": name, "wsid": wsid, "desc": desc, "depth": int(depth), "parent": parent}
    finally:
        k.close()


def ensure_cwm(cid: str, owner_user_id: str, workspace_name: str) -> None:
    """Re-assert the collection row in collection_workspace_map (self-heal)."""
    meta = collection_meta(cid)
    with SessionLocal() as db:
        upsert_collection_workspace(
            db=db,
            collection_id=UUID(cid),
            workspace_id=UUID(meta["wsid"]),
            owner_user_id=UUID(owner_user_id),
            collection_name=meta["name"],
            workspace_name=workspace_name,
            description=meta["desc"] or None,
            parent_collection_id=(UUID(meta["parent"]) if meta["parent"] else None),
            depth=meta["depth"],
            custom_instructions=None,
        )


# ---------------------------------------------------------------------------
# Document state helpers
# ---------------------------------------------------------------------------


def already_completed(collection_id: str, sanitized: str) -> bool:
    with SessionLocal() as db:
        row = db.execute(
            text(
                "SELECT processing_status FROM documents "
                "WHERE filename = :fn AND collection_id = :cid AND deleted_at IS NULL"
            ),
            {"fn": sanitized, "cid": collection_id},
        ).fetchone()
        return bool(row and row.processing_status == "completed")


def inflight_pending(doc_ids: list[str]) -> set[str]:
    if not doc_ids:
        return set()
    with SessionLocal() as db:
        rows = db.execute(
            text(
                "SELECT id::text, processing_status FROM documents "
                "WHERE id::text = ANY(:ids) AND processing_status IN ('pending','processing')"
            ),
            {"ids": doc_ids},
        ).fetchall()
        return {r[0] for r in rows}


# ---------------------------------------------------------------------------
# Work-list discovery — collection derived from folder structure
# ---------------------------------------------------------------------------


def _find(path: str, *extra: str, retries: int = 12) -> list[str]:
    """Enumerate paths via coreutils ``find`` (NUL-separated), with retries.

    Python's ``os.listdir``/``os.scandir`` raise ``OSError: [Errno 5]`` on very
    large directories over the Docker Desktop (grpcfuse) host mount; ``find`` is
    more reliable but still INTERMITTENTLY hits the same EIO on the biggest
    directories, so we retry with backoff until a readdir succeeds. Per-file
    ``open().read()`` over the same mount works and is used elsewhere.
    """
    last_err = ""
    for attempt in range(retries):
        res = subprocess.run(
            ["find", path, "-mindepth", "1", *extra, "-print0"],
            capture_output=True, timeout=600,
        )
        if res.returncode == 0:
            return [p for p in res.stdout.decode("utf-8", errors="replace").split("\0") if p]
        last_err = res.stderr.decode(errors="replace")[:200]
        if "Input/output error" in last_err or "Resource temporarily" in last_err:
            time.sleep(min(2 + attempt, 10))
            continue
        break
    raise RuntimeError(f"find failed for {path} after {retries} attempts: {last_err}")


def _read_file_list(list_path: str, root: str) -> list[str]:
    """Read a pre-computed file list (NUL- or newline-separated) of paths under ``root``.

    Lets the caller enumerate on the host (native NTFS — reliable) and feed the
    list in, sidestepping the Docker Desktop grpcfuse readdir EIO on very large
    directories. Only paths under ``root`` are kept.
    """
    with open(list_path, "rb") as fh:
        raw = fh.read().decode("utf-8-sig", errors="replace")  # utf-8-sig strips a PowerShell BOM
    sep = "\0" if "\0" in raw else "\n"
    out = []
    root_prefix = root.rstrip("/") + "/"
    for line in raw.split(sep):
        p = line.strip().rstrip("\r")
        if p and p.startswith(root_prefix):
            out.append(p)
    return out


def build_targets(
    root: str, workspace_id: str, include_root_loose: bool, file_list: str | None = None
) -> list[tuple[str, str, str]]:
    """Return [(collection_id, folder_label, abs_path)], creating collections as needed.

    Root loose files -> collection named after basename(root) (depth 0).
    Files inside an immediate sub-folder -> collection = sub-folder name (depth 1).
    Files nested deeper than one level are attributed to their top-level sub-folder
    (mirrors derive_collection_name in the dataset generator), so the collection set
    matches the visible top-level structure.

    When ``file_list`` is given, paths come from that pre-computed list (host-side
    enumeration) instead of in-container ``find`` — collection assignment is pure
    string work on each path, so no directory readdir happens here at all.
    """
    root = root.rstrip("/")
    root_name = os.path.basename(root)
    root_cid = find_or_create_collection(workspace_id, root_name, parent_id=None, depth=0)
    targets: list[tuple[str, str, str]] = []

    if file_list:
        sub_cids: dict[str, str] = {}
        for p in sorted(_read_file_list(file_list, root)):
            rel = p[len(root) + 1:]
            parts = rel.split("/")
            if len(parts) == 1:
                if include_root_loose:
                    targets.append((root_cid, root_name, p))
                continue
            sub = parts[0]
            cid = sub_cids.get(sub)
            if cid is None:
                cid = find_or_create_collection(workspace_id, sub, parent_id=root_cid, depth=1)
                sub_cids[sub] = cid
            targets.append((cid, sub, p))
        return targets

    if include_root_loose:
        for p in sorted(_find(root, "-maxdepth", "1", "-type", "f")):
            targets.append((root_cid, root_name, p))
    for d in sorted(_find(root, "-maxdepth", "1", "-type", "d")):
        entry = os.path.basename(d)
        sub_cid = find_or_create_collection(workspace_id, entry, parent_id=root_cid, depth=1)
        for p in sorted(_find(d, "-type", "f")):
            targets.append((sub_cid, entry, p))
    return targets


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser(description="Generic library ingest via production UploadDocument gRPC.")
    ap.add_argument("--root", required=True, help="Library subtree to ingest, e.g. /knjige/psychology")
    ap.add_argument("--workspace", default="books", help="Target workspace name (default: books)")
    ap.add_argument("--summary", action="store_true", help="generate document_summaries (per-chapter + book)")
    ap.add_argument("--graph", action="store_true", help="build Neo4j knowledge graph")
    ap.add_argument("--max-inflight", type=int, default=3, help="max concurrently-processing uploads")
    ap.add_argument("--no-root-loose", action="store_true", help="skip loose files directly under --root")
    ap.add_argument("--file-list", default=None,
                    help="path to a pre-computed file list (host-enumerated, paths under --root); "
                         "avoids in-container readdir EIO on huge dirs over the Docker mount")
    ap.add_argument("--limit", type=int, default=0, help="process at most N files then stop (0 = all)")
    ap.add_argument("--state", default=None, help="incremental JSON report path")
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        raise SystemExit(f"--root not found: {args.root}")
    state_path = args.state or f"/app/data/tmp/ingest_{os.path.basename(args.root.rstrip('/'))}_report.json"
    os.makedirs(os.path.dirname(state_path), exist_ok=True)

    workspace_id, owner_user_id = resolve_workspace(args.workspace)
    log(f"workspace '{args.workspace}' id={workspace_id} owner={owner_user_id}")

    opts = [
        ("grpc.max_send_message_length", GRPC_LIMIT),
        ("grpc.max_receive_message_length", GRPC_LIMIT),
    ]
    channel = grpc.insecure_channel("localhost:9091", options=opts)
    stub = pbg.DocumentExtrasServiceStub(channel)

    log(f"discovering files under {args.root} ...")
    targets = build_targets(
        args.root, workspace_id, include_root_loose=not args.no_root_loose, file_list=args.file_list
    )
    if args.limit > 0:
        targets = targets[: args.limit]
    n_coll = len({t[0] for t in targets})
    log(f"candidate files: {len(targets)} across {n_coll} collections | "
        f"summary={args.summary} graph={args.graph} max_inflight={args.max_inflight}")

    report = {
        "submitted": [], "completed": [], "failed": [], "skipped_done": [],
        "ocr_needed": [], "unsupported": [], "oversize": [], "errors": [],
    }
    inflight: list[str] = []
    cwm_done: set[str] = set()

    def drain(limit: int) -> None:
        while True:
            pend = inflight_pending(inflight)
            for d in [d for d in inflight if d not in pend]:
                inflight.remove(d)
                report["completed"].append(d)
            if len(inflight) < limit:
                return
            time.sleep(5)

    def persist() -> None:
        with open(state_path, "w", encoding="utf-8") as sf:
            json.dump(report, sf, ensure_ascii=False, indent=1)

    for cid, folder, path in targets:
        fname = os.path.basename(path)
        ext = os.path.splitext(fname)[1].lower()
        try:
            if not is_valid_document_type(fname) or ext not in SUPPORTED_EXT:
                report["unsupported"].append({"folder": folder, "file": fname, "ext": ext})
                continue
            size = os.path.getsize(path)
            if size > MAX_BYTES:
                report["oversize"].append({"folder": folder, "file": fname, "size_mb": round(size / 1048576, 1)})
                log(f"OVERSIZE skip ({round(size/1048576,1)}MB): {folder}/{fname}")
                continue
            sanitized = sanitize_filename(fname)
            if already_completed(cid, sanitized):
                report["skipped_done"].append({"folder": folder, "file": fname})
                continue
            # OCR pre-classification for PDFs: scanned -> defer to a later GPU/Docling pass
            if ext == ".pdf":
                try:
                    is_ocr, page_count = analyze_pdf_document(path)
                except Exception as e:  # noqa: BLE001
                    report["errors"].append({"folder": folder, "file": fname, "stage": "ocr_classify", "error": str(e)[:200]})
                    continue
                if is_ocr:
                    report["ocr_needed"].append({"folder": folder, "file": fname, "pages": page_count})
                    log(f"OCR-needed (defer): {folder}/{fname} pages={page_count}")
                    continue

            drain(args.max_inflight)
            with open(path, "rb") as fh:
                data = fh.read()

            def submit_once() -> "pb.UploadDocumentResponse":
                req = pb.UploadDocumentRequest(
                    collection_id=cid,
                    user_id=owner_user_id,
                    filename=fname,
                    file_data=data,
                    auto_process=True,
                    store_file=False,
                    build_graph=args.graph,
                    generate_summary=args.summary,
                )
                return stub.UploadDocument(req, timeout=120)

            if cid not in cwm_done:
                ensure_cwm(cid, owner_user_id, args.workspace)  # self-heal once per collection
                cwm_done.add(cid)
            resp = submit_once()
            if not resp.success and "not found" in (resp.error or "").lower():
                ensure_cwm(cid, owner_user_id, args.workspace)
                resp = submit_once()  # retry once after re-asserting the collection
            if resp.success and resp.document_id:
                inflight.append(resp.document_id)
                report["submitted"].append({"folder": folder, "file": fname, "doc": resp.document_id})
                log(f"submitted {folder}/{fname} -> {resp.document_id} (inflight={len(inflight)})")
            else:
                report["failed"].append({"folder": folder, "file": fname, "error": resp.error or resp.message})
                log(f"FAILED submit {folder}/{fname}: {resp.error or resp.message}")
        except Exception as e:  # noqa: BLE001
            report["errors"].append({"folder": folder, "file": fname, "stage": "submit", "error": str(e)[:200]})
            log(f"ERROR {folder}/{fname}: {str(e)[:200]}")
        finally:
            persist()

    log("All submitted; draining in-flight...")
    drain(1)
    pend = inflight_pending(inflight)
    report["completed"].extend([d for d in inflight if d not in pend])
    persist()

    log("=== DONE ===")
    log(f"submitted={len(report['submitted'])} completed~={len(report['completed'])} "
        f"failed={len(report['failed'])} skipped_done={len(report['skipped_done'])} "
        f"ocr_needed={len(report['ocr_needed'])} unsupported={len(report['unsupported'])} "
        f"oversize={len(report['oversize'])} errors={len(report['errors'])}")
    log(f"report: {state_path}")


if __name__ == "__main__":
    main()
