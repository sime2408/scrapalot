"""Direct PostgreSQL writer for the dataset generator pipeline.

Bypasses the REST API and writes extracted markdown + embeddings directly
to both Scrapalot databases via the SSH tunnel on localhost:15432.

Two-database architecture:
  - scrapalot_backend (Kotlin):  workspace + collection metadata (schema: scrapalot)
  - scrapalot         (Python):  documents + langchain embeddings (schema: public)

Embedding model: sentence-transformers/all-MiniLM-L6-v2 (384 dimensions)
Chunking:        RecursiveCharacterTextSplitter (same as production "recursive" strategy)
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shlex
import subprocess
import tempfile
import uuid

import psycopg2
import psycopg2.extras

from scripts.dataset_generator.targets.base import derive_collection_name
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
_EMBEDDING_MODEL_LOCAL = "data/models/all-MiniLM-L6-v2"
_EMBEDDING_DIM = 384


@dataclass
class DbWriteContext:
    """Configuration for direct database writes via SSH tunnel."""

    db_host: str
    db_port: int
    db_user: str
    db_password: str
    kotlin_db: str
    python_db: str
    workspace_name: str
    input_dir: str
    chunk_size: int = 1000
    chunk_overlap: int = 200
    embedding_batch_size: int = 64
    device: str = "cpu"
    # Cover-image push: when set, generate a {stem}_thumb_large.png cover from the
    # source file and copy it into the remote container's upload volume over SSH so
    # the UI can serve it (the original file itself is NOT uploaded — file_stored=false).
    cover_ssh_host: str | None = None
    cover_container: str = "scrapalot-chat"
    cover_upload_root: str = "/app/data/upload"


class ScrapalotDbWriter:
    """Direct PostgreSQL writer that replaces the REST API upload path.

    Connects to two databases on the same PostgreSQL host:
    - scrapalot_backend: finds/creates workspace and collection records
    - scrapalot:         inserts document records and chunk embeddings

    Duplicate prevention: on first access to a collection, all existing
    document filenames are fetched and cached so subsequent uploads within
    the same session skip already-present documents.
    """

    def __init__(self, ctx: DbWriteContext) -> None:
        self._ctx = ctx
        self._kotlin_conn: psycopg2.extensions.connection | None = None
        self._python_conn: psycopg2.extensions.connection | None = None
        self._workspace_id: str | None = None
        self._workspace_owner_id: str | None = None
        self._collection_cache: dict[str, str] = {}
        self._lc_collection_cache: dict[str, str] = {}
        self._remote_docs: dict[str, set[str]] = {}
        self._embedder = None
        self._splitter = None
        self._ssh_control_path: str | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def register_markdown(self, book_file_path: str, markdown: str, chapters=None) -> bool:
        """Chunk, embed, and write markdown directly to the database.

        Args:
            book_file_path: Local path to the source file (used for collection derivation).
            markdown:        Full extracted markdown text.
            chapters:        Optional list of ChapterData from chapter_assembler.
                             When provided, chunks are tagged with chapter_title so
                             document_hierarchy can be populated.

        Returns True on success or when the document already exists.
        Returns False on any non-retryable failure.
        """
        try:
            self._ensure_connected()
            collection_name = derive_collection_name(book_file_path, self._ctx.input_dir)
            collection_id = self._get_or_create_collection(collection_name)
            return self._write_document(book_file_path, markdown, collection_id, chapters=chapters)
        except Exception as e:
            logger.warning("DB write failed for '%s': %s", book_file_path, e, exc_info=True)
            for conn in (self._python_conn, self._kotlin_conn):
                if conn and not conn.closed:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
            return False

    def close(self) -> None:
        for conn in (self._kotlin_conn, self._python_conn):
            if conn and not conn.closed:
                try:
                    conn.close()
                except Exception:
                    pass
        self._embedder = None
        if self._ssh_control_path and self._ctx.cover_ssh_host:
            try:
                subprocess.run(
                    ["ssh", "-O", "exit", "-o", f"ControlPath={self._ssh_control_path}", self._ctx.cover_ssh_host],
                    capture_output=True,
                    timeout=15,
                )
            except Exception:
                pass
            self._ssh_control_path = None

    # ------------------------------------------------------------------
    # Cover thumbnail push (best-effort; never raises into the write path)
    # ------------------------------------------------------------------

    def _ssh_opts(self) -> list[str]:
        """SSH options for cover push.

        NO ControlMaster multiplexing: under rapid back-to-back scp/ssh from the
        worker it reset the mux socket (``mux_client_request_session: ... Connection
        reset by peer``) and most covers failed. Independent connections per call
        are slightly slower but reliable.
        """
        return [
            "-o", "ConnectTimeout=15",
            "-o", "BatchMode=yes",
            "-o", "ServerAliveInterval=10",
        ]

    def _push_cover(self, source_path: str, db_file_path: str) -> bool:
        """Generate a cover thumbnail locally and copy it into the remote
        container's upload volume at ``{stem}_thumb_large.png`` (the path the
        UI expects). Best-effort: logs and returns False on any failure.
        """
        ext = os.path.splitext(source_path)[1].lower()
        if ext not in (".pdf", ".epub"):
            return False
        if not os.path.exists(source_path):
            logger.debug("Cover skipped — source not found: %s", source_path)
            return False

        try:
            from src.main.service.document.thumbnail_service import ThumbnailService
        except Exception as e:
            logger.warning("Cover skipped — ThumbnailService import failed: %s", e)
            return False

        host = self._ctx.cover_ssh_host
        container = self._ctx.cover_container
        tmp_png = os.path.join(tempfile.gettempdir(), f"cover_{uuid.uuid4().hex}.png")
        staging = f"/tmp/scrapalot_cover_{uuid.uuid4().hex}.png"
        try:
            if ext == ".pdf":
                out = ThumbnailService.generate_pdf_thumbnail(source_path, output_path=tmp_png)
            else:
                out = ThumbnailService.generate_epub_thumbnail(source_path, output_path=tmp_png)
            if not out or not os.path.exists(tmp_png):
                logger.debug("Cover generation produced nothing for %s", source_path)
                return False

            # Remote paths: db_file_path == data/upload/{user}/{ws}/{coll}/{filename}
            rel_after = db_file_path.split("data/upload/", 1)[-1]
            server_dir = posixpath.join(self._ctx.cover_upload_root, posixpath.dirname(rel_after))
            filename = posixpath.basename(db_file_path)
            stem = filename.rsplit(".", 1)[0] if "." in filename else filename
            server_cover = posixpath.join(server_dir, f"{stem}_thumb_large.png")

            opts = self._ssh_opts()
            scp = subprocess.run(
                ["scp", *opts, tmp_png, f"{host}:{staging}"],
                capture_output=True, timeout=60, text=True,
            )
            if scp.returncode != 0:
                logger.warning("Cover scp failed for '%s': %s", filename, scp.stderr.strip()[:200])
                return False

            remote_cmd = (
                f"docker exec {shlex.quote(container)} mkdir -p {shlex.quote(server_dir)} && "
                f"docker cp {shlex.quote(staging)} {shlex.quote(container + ':' + server_cover)} && "
                f"rm -f {shlex.quote(staging)}"
            )
            cp = subprocess.run(
                ["ssh", *opts, host, remote_cmd],
                capture_output=True, timeout=60, text=True,
            )
            if cp.returncode != 0:
                logger.warning("Cover docker cp failed for '%s': %s", filename, cp.stderr.strip()[:200])
                return False
            logger.debug("Pushed cover for '%s' -> %s", filename, server_cover)
            return True
        except Exception as e:
            logger.warning("Cover push errored for '%s': %s", os.path.basename(source_path), e)
            return False
        finally:
            try:
                if os.path.exists(tmp_png):
                    os.remove(tmp_png)
            except OSError:
                pass

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------

    def _ensure_connected(self) -> None:
        # Roll back any connection stuck in an aborted transaction before reusing it.
        for conn in (self._kotlin_conn, self._python_conn):
            if conn and not conn.closed:
                status = conn.get_transaction_status()
                if status == psycopg2.extensions.TRANSACTION_STATUS_INERROR:
                    try:
                        conn.rollback()
                    except Exception:
                        pass

        if self._kotlin_conn is None or self._kotlin_conn.closed:
            self._kotlin_conn = psycopg2.connect(
                host=self._ctx.db_host,
                port=self._ctx.db_port,
                dbname=self._ctx.kotlin_db,
                user=self._ctx.db_user,
                password=self._ctx.db_password,
                options="-c search_path=scrapalot,public",
                connect_timeout=30,
            )
            self._kotlin_conn.autocommit = False
            logger.info("Connected to Kotlin DB '%s' on %s:%d", self._ctx.kotlin_db, self._ctx.db_host, self._ctx.db_port)

        if self._python_conn is None or self._python_conn.closed:
            self._python_conn = psycopg2.connect(
                host=self._ctx.db_host,
                port=self._ctx.db_port,
                dbname=self._ctx.python_db,
                user=self._ctx.db_user,
                password=self._ctx.db_password,
                connect_timeout=30,
            )
            self._python_conn.autocommit = False
            logger.info("Connected to Python DB '%s' on %s:%d", self._ctx.python_db, self._ctx.db_host, self._ctx.db_port)

        if self._workspace_id is None:
            result = self._find_workspace_by_name(self._ctx.workspace_name)
            if result is None:
                raise RuntimeError(
                    f"Workspace '{self._ctx.workspace_name}' not found in '{self._ctx.kotlin_db}'. "
                    "Create it via the UI first, or check --workspace-name."
                )
            self._workspace_id, self._workspace_owner_id = result

    # ------------------------------------------------------------------
    # Workspace (read-only — Kotlin owns workspace creation)
    # ------------------------------------------------------------------

    def _find_workspace_by_name(self, name: str) -> tuple[str, str] | None:
        with self._kotlin_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(
                "SELECT id, user_id FROM scrapalot.workspaces WHERE lower(name) = lower(%s) LIMIT 1",
                (name,),
            )
            row = cur.fetchone()
            if row:
                ws_id = str(row["id"])
                owner_id = str(row["user_id"])
                logger.info("Found workspace '%s' (id=%s, owner=%s)", name, ws_id, owner_id)
                return ws_id, owner_id
        logger.warning("Workspace '%s' not found in DB", name)
        return None

    # ------------------------------------------------------------------
    # Collection management
    # ------------------------------------------------------------------

    def _get_or_create_collection(self, name: str) -> str:
        if name in self._collection_cache:
            return self._collection_cache[name]

        cid = self._find_collection_by_name(name)
        if cid is None:
            cid = self._create_collection(name)

        self._collection_cache[name] = cid
        return cid

    def _find_collection_by_name(self, name: str) -> str | None:
        with self._kotlin_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(
                "SELECT id FROM scrapalot.collections WHERE workspace_id = %s AND lower(name) = lower(%s) LIMIT 1",
                (self._workspace_id, name),
            )
            row = cur.fetchone()
            if row:
                cid = str(row["id"])
                logger.info("Found collection '%s' (id=%s)", name, cid)
                return cid
        return None

    def _create_collection(self, name: str) -> str:
        cid = str(uuid.uuid4())
        slug = self._unique_slug(name)
        with self._kotlin_conn.cursor() as cur:
            cur.execute(
                """INSERT INTO scrapalot.collections
                   (id, name, slug, workspace_id, chunking_strategy,
                    chunk_size, chunk_overlap, depth, sort_order, is_processing,
                    created_at, updated_at)
                   VALUES (%s, %s, %s, %s, 'recursive', %s, %s, 0, 0, false, NOW(), NOW())""",
                (cid, name, slug, self._workspace_id, self._ctx.chunk_size, self._ctx.chunk_overlap),
            )
        self._kotlin_conn.commit()
        logger.info("Created collection '%s' (id=%s, slug=%s)", name, cid, slug)
        return cid

    def _unique_slug(self, name: str) -> str:
        base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "collection"
        slug = base
        counter = 2
        with self._kotlin_conn.cursor() as cur:
            while True:
                cur.execute(
                    "SELECT 1 FROM scrapalot.collections WHERE workspace_id = %s AND slug = %s",
                    (self._workspace_id, slug),
                )
                if cur.fetchone() is None:
                    return slug
                slug = f"{base}-{counter}"
                counter += 1

    # ------------------------------------------------------------------
    # LangChain collection (Python DB)
    # ------------------------------------------------------------------

    def _get_or_create_lc_collection(self, collection_id: str) -> str:
        if collection_id in self._lc_collection_cache:
            return self._lc_collection_cache[collection_id]

        with self._python_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(
                "SELECT uuid FROM langchain_pg_collection WHERE name = %s LIMIT 1",
                (collection_id,),
            )
            row = cur.fetchone()
            if row:
                lc_uuid = str(row["uuid"])
            else:
                lc_uuid = str(uuid.uuid4())
                cur.execute(
                    "INSERT INTO langchain_pg_collection (uuid, name, cmetadata) VALUES (%s, %s, '{}'::jsonb)",
                    (lc_uuid, collection_id),
                )
                self._python_conn.commit()
                logger.info("Created langchain_pg_collection for collection %s (lc_uuid=%s)", collection_id, lc_uuid)

        self._lc_collection_cache[collection_id] = lc_uuid
        return lc_uuid

    # ------------------------------------------------------------------
    # Remote document cache (dedup)
    # ------------------------------------------------------------------

    def _load_remote_docs(self, collection_id: str) -> None:
        if collection_id in self._remote_docs:
            return
        filenames: set[str] = set()
        with self._python_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            # Only consider documents that have embeddings — documents without
            # embeddings (failed mid-write) must be retried, not skipped.
            cur.execute(
                """SELECT filename FROM documents
                   WHERE collection_id = %s AND deleted_at IS NULL
                   AND (processing_stats->>'chunk_count')::int > 0""",
                (collection_id,),
            )
            for row in cur.fetchall():
                fname = row["filename"]
                if fname:
                    filenames.add(fname)
        self._remote_docs[collection_id] = filenames
        if filenames:
            logger.info("Loaded %d existing docs from collection %s", len(filenames), collection_id)

    # ------------------------------------------------------------------
    # Document write
    # ------------------------------------------------------------------

    def _write_document(self, book_file_path: str, markdown: str, collection_id: str, chapters=None) -> bool:
        src = Path(book_file_path)
        filename = src.name
        title = src.stem

        self._load_remote_docs(collection_id)
        if filename in self._remote_docs.get(collection_id, set()):
            logger.info("Document already exists '%s' — skipping upload", filename)
            return True

        lc_uuid = self._get_or_create_lc_collection(collection_id)

        doc_id = str(uuid.uuid4())
        content_hash = hashlib.sha256(markdown.encode()).hexdigest()

        # Build server-side relative path: data/upload/{user_id}/{workspace_id}/{collection_id}/{filename}
        db_file_path = "/".join(
            [
                "data/upload",
                self._workspace_owner_id,
                self._workspace_id,
                collection_id,
                filename,
            ]
        )

        with self._python_conn.cursor() as cur:
            cur.execute(
                """INSERT INTO documents
                   (id, collection_id, title, filename, file_path,
                    file_size, file_type, content, processing_status,
                    processing_progress, content_hash, file_stored,
                    created_at, updated_at)
                   VALUES (%s, %s, %s, %s, %s, %s, 'text/markdown',
                           %s, 'completed', 1.0, %s, false, NOW(), NOW())""",
                (
                    doc_id,
                    collection_id,
                    title,
                    filename,
                    db_file_path,
                    len(markdown.encode()),
                    markdown,
                    content_hash,
                ),
            )
        self._python_conn.commit()

        num_chunks = self._chunk_and_embed(doc_id, lc_uuid, collection_id, markdown, title, chapters=chapters)

        hierarchy = self._build_hierarchy(doc_id)

        with self._python_conn.cursor() as cur:
            cur.execute(
                "UPDATE documents SET processing_stats = %s::jsonb, document_hierarchy = %s::jsonb WHERE id = %s",
                (json.dumps({"chunk_count": num_chunks}), json.dumps(hierarchy) if hierarchy else None, doc_id),
            )
        self._python_conn.commit()

        # Generate + push a cover thumbnail to the remote upload volume (best-effort).
        if self._ctx.cover_ssh_host:
            if self._push_cover(book_file_path, db_file_path):
                with self._python_conn.cursor() as cur:
                    cur.execute(
                        """UPDATE documents
                           SET file_metadata = COALESCE(file_metadata, '{}'::jsonb)
                               || jsonb_build_object('thumbnail',
                                    jsonb_build_object('sizes', jsonb_build_array('large'),
                                                       'has_custom', false,
                                                       'has_thumbnail', true))
                           WHERE id = %s""",
                        (doc_id,),
                    )
                self._python_conn.commit()

        self._remote_docs.setdefault(collection_id, set()).add(filename)
        top_sections = len(hierarchy) if hierarchy else 0
        logger.info("Wrote document '%s' (doc_id=%s, chunks=%d, hierarchy_sections=%d)", filename, doc_id, num_chunks, top_sections)
        return True

    # ------------------------------------------------------------------
    # Chunking and embedding
    # ------------------------------------------------------------------

    def _chunk_and_embed(self, doc_id: str, lc_uuid: str, collection_id: str, markdown: str, title: str, chapters=None) -> int:
        """Chunk markdown, embed, and insert into langchain_pg_embedding.

        When chapters are provided each chapter's text is split independently
        so every chunk is tagged with chapter_title in cmetadata, enabling
        document_hierarchy to be populated afterwards.
        """
        splitter = self._get_splitter()

        # Build (text, chapter_title) pairs
        if chapters:
            tagged: list[tuple[str, str]] = []
            for ch in chapters:
                ch_text = getattr(ch, "text", None) or ""
                ch_title = getattr(ch, "title", None) or "Document"
                for chunk_text in splitter.split_text(ch_text):
                    tagged.append((chunk_text, ch_title))
        else:
            tagged = [(t, "Document") for t in splitter.split_text(markdown)]

        if not tagged:
            return 0

        embedder = self._get_embedder()
        batch_size = self._ctx.embedding_batch_size
        inserted = 0

        for batch_start in range(0, len(tagged), batch_size):
            batch = tagged[batch_start : batch_start + batch_size]
            texts = [t for t, _ in batch]
            embeddings = embedder.encode(texts, show_progress_bar=False, batch_size=min(batch_size, 32))

            rows = []
            for i, ((chunk_text, chapter_title), emb) in enumerate(zip(batch, embeddings)):
                chunk_idx = batch_start + i
                meta = json.dumps(
                    {
                        "document_id": doc_id,
                        "chunk_index": chunk_idx,
                        "collection_id": collection_id,
                        "source": title,
                        "chapter_title": chapter_title,
                    }
                )
                emb_str = "[" + ",".join(f"{v:.8f}" for v in emb) + "]"
                rows.append((str(uuid.uuid4()), lc_uuid, chunk_text, meta, emb_str))

            with self._python_conn.cursor() as cur:
                psycopg2.extras.execute_values(
                    cur,
                    """INSERT INTO langchain_pg_embedding
                       (id, collection_id, document, cmetadata, embedding)
                       VALUES %s""",
                    rows,
                    template="(%s, %s, %s, %s::jsonb, %s::vector)",
                )
            self._python_conn.commit()
            inserted += len(rows)

        logger.debug("Inserted %d embeddings for doc %s", inserted, doc_id)
        return inserted

    # ------------------------------------------------------------------
    # Document hierarchy
    # ------------------------------------------------------------------

    def _build_hierarchy(self, doc_id: str) -> dict | None:
        """Build document_hierarchy JSONB from chunk cmetadata.

        Mirrors hierarchy_utils.rebuild_hierarchy_from_chunk_metadata but uses
        psycopg2 directly so we don't need the full SQLAlchemy service stack.
        """
        with self._python_conn.cursor(cursor_factory=psycopg2.extras.DictCursor) as cur:
            cur.execute(
                """
                SELECT
                    COALESCE(
                        NULLIF(cmetadata->>'chunk_index', '')::int,
                        ROW_NUMBER() OVER (ORDER BY id)::int - 1
                    ) AS chunk_index,
                    cmetadata->>'chapter_title'   AS chapter_title,
                    cmetadata->>'section_heading' AS section_heading
                FROM langchain_pg_embedding
                WHERE cmetadata->>'document_id' = %s
                ORDER BY 1
                """,
                (doc_id,),
            )
            rows = cur.fetchall()

        if not rows or len({r["chunk_index"] for r in rows}) < 2:
            return None

        chapters: dict = {}
        for row in rows:
            ch_key = (row["chapter_title"] or "").strip() or "Document"
            ch_entry = chapters.setdefault(
                ch_key,
                {
                    "chunk_range": [row["chunk_index"], row["chunk_index"]],
                    "heading_level": 1,
                    "children": {},
                },
            )
            ch_entry["chunk_range"][1] = row["chunk_index"]

            sec_key = (row["section_heading"] or "").strip()
            if sec_key and sec_key != ch_key:
                sec_entry = ch_entry["children"].setdefault(
                    sec_key,
                    {"chunk_range": [row["chunk_index"], row["chunk_index"]], "heading_level": 2},
                )
                sec_entry["chunk_range"][1] = row["chunk_index"]

        return chapters

    # ------------------------------------------------------------------
    # Lazy-init helpers
    # ------------------------------------------------------------------

    def _get_embedder(self):
        if self._embedder is None:
            from pathlib import Path

            from sentence_transformers import SentenceTransformer

            device = self._ctx.device
            local_path = Path(_EMBEDDING_MODEL_LOCAL)
            model_ref = str(local_path) if local_path.exists() else _EMBEDDING_MODEL
            logger.info("Loading embedding model '%s' on device '%s'", model_ref, device)
            self._embedder = SentenceTransformer(model_ref, device=device)
        return self._embedder

    def _get_splitter(self):
        if self._splitter is None:
            from langchain_text_splitters import RecursiveCharacterTextSplitter

            self._splitter = RecursiveCharacterTextSplitter(
                chunk_size=self._ctx.chunk_size,
                chunk_overlap=self._ctx.chunk_overlap,
                length_function=len,
            )
        return self._splitter
