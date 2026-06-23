"""
Comprehensive document utilities for file processing, chunking, and document management.

This module provides utility functions for document processing including
- Document processing and metadata extraction
- Text chunking strategies and utilities
- File operations and validation
- Entity extraction and validation
- Docling configuration and optimization

This is a merged module that consolidates functionality from:
- document_processing_utils.py
- document_utils.py (original)
- chunking_utils.py
- file_utils.py
"""

from datetime import UTC, datetime
import json
import logging
import multiprocessing
import os
import re
import shutil
import time
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from fastapi import UploadFile

import psutil

from src.main.models.enums import EntityType
from src.main.models.similarity import ExtractedEntity
from src.main.utils.config.loader import resolved_config, resolved_prompts
from src.main.utils.core.logger import get_logger
from src.main.utils.text.formatting import normalize_whitespace, smart_title_case

logger = get_logger(__name__)


# ============================================================================
# DOCUMENT PROCESSING UTILITIES (from document_processing_utils.py)
# ============================================================================


def get_user_retriever_with_fallback(db, user_id: str, default_type: str = "pgvector") -> str:
    """
    Get a user's preferred retriever type with fallback to default.

    Args:
        db: Database session
        user_id: User identifier
        default_type: Default retriever type to use as fallback

    Returns:
        Retriever type string
    """
    try:
        return get_user_retriever_type(db, user_id)
    except Exception as ex:
        logger.warning("Failed to get user retriever type, using default %s: %s", default_type, str(ex))
        return default_type


async def _store_embeddings_async(enriched_documents: list, collection_id: str, user_id: str, db, retriever_manager) -> None:
    """
    Internal async function to store embeddings.
    Runs entirely within a single event loop to avoid asyncpg concurrency issues.
    """
    from uuid import UUID

    # Get user's preferred retriever type with proper error handling
    user_retriever_type = get_user_retriever_with_fallback(db, user_id)

    # Get user-specific retriever from RetrieverManager
    retriever = await retriever_manager.get_retriever(user_id, user_retriever_type)
    if not retriever:
        logger.warning("No retriever available for storing embeddings")
        return

    # Convert collection_id to UUID and create a list for the method call (handle case where it might already be UUID)
    collection_uuids = [collection_id if isinstance(collection_id, UUID) else UUID(collection_id)]

    logger.debug("Storing embeddings in async context (single event loop)")
    await retriever.add_documents(enriched_documents, collection_ids=collection_uuids)

    logger.info("Stored %d document chunks in vector database", len(enriched_documents))


def store_embeddings_sync(enriched_documents: list, collection_id: str, _user_id: str, db, _retriever_manager, progress_callback=None) -> None:
    """
    Store embeddings in a vector database synchronously (for worker tasks).

    Uses direct SQLAlchemy INSERT instead of async LangChain PGVector to avoid
    asyncpg InterfaceError in Celery worker forked processes.

    Args:
        enriched_documents: List of enriched documents to store
        collection_id: Collection identifier
        _user_id: User identifier (not used, reserved for future use)
        db: Database session
        _retriever_manager: Retriever manager instance (not used, reserved for future use)
        progress_callback: Optional callable(progress_pct, message) invoked
            after each embedding batch and after each insert batch so the
            UI ring keeps moving instead of sitting at 65 % the entire
            time large books are being embedded.
    """
    import json
    import uuid

    from sqlalchemy import text

    try:
        # Step 1: Ensure collection exists in langchain_pg_collection
        existing = db.execute(
            text("SELECT uuid FROM langchain_pg_collection WHERE name = :name"),
            {"name": collection_id},
        ).fetchone()

        if existing:
            collection_uuid = str(existing[0])
        else:
            collection_uuid = str(uuid.uuid4())
            db.execute(
                text("INSERT INTO langchain_pg_collection (uuid, name, cmetadata) VALUES (:uuid, :name, :meta)"),
                {"uuid": collection_uuid, "name": collection_id, "meta": json.dumps({})},
            )
            db.commit()
            logger.info("Created collection %s with UUID %s", collection_id, collection_uuid)

        # Step 2: Generate embeddings using HuggingFace model (sync, no asyncpg)
        from langchain_huggingface import HuggingFaceEmbeddings

        from src.main.utils.llm.embedding_resolver import EmbeddingModelResolver

        model_name = EmbeddingModelResolver.get_default_embedding_model()
        embeddings_model = HuggingFaceEmbeddings(model_name=model_name)

        texts = [doc.page_content for doc in enriched_documents]
        metadatas = [getattr(doc, "metadata", {}) for doc in enriched_documents]

        # Sanitize metadata for JSONB. PostgreSQL JSONB rejects literal NUL bytes inside strings, so any chunk text / chapter
        # title that carries a NUL would poison the INSERT. Strip recursively
        # from every string leaf before json.dumps.
        def _strip_nul(v):
            if isinstance(v, str):
                return v.replace("\x00", "")
            if isinstance(v, dict):
                return {k: _strip_nul(vv) for k, vv in v.items()}
            if isinstance(v, list):
                return [_strip_nul(x) for x in v]
            return v

        def sanitize(meta_dict):
            sanitized = {}
            for k, v in meta_dict.items():
                if isinstance(v, (str, int, float, bool)) or v is None:
                    sanitized[k] = _strip_nul(v)
                elif isinstance(v, (list, dict)):
                    try:
                        json.dumps(v)
                        sanitized[k] = _strip_nul(v)
                    except (TypeError, ValueError):
                        sanitized[k] = _strip_nul(str(v))
                else:
                    sanitized[k] = _strip_nul(str(v))
            return sanitized

        sanitized_metadatas = [sanitize(m) for m in metadatas]

        # Generate embeddings in batches
        batch_size = 50
        total_batches = max(1, (len(texts) + batch_size - 1) // batch_size)
        all_embeddings = []
        for i in range(0, len(texts), batch_size):
            batch_texts = texts[i : i + batch_size]
            batch_embeddings = embeddings_model.embed_documents(batch_texts)
            all_embeddings.extend(batch_embeddings)
            current_batch = i // batch_size + 1
            logger.info("Generated embeddings batch %d/%d", current_batch, total_batches)
            if progress_callback is not None:
                # Map embedding work onto the 65 → 80 % band so the ring
                # actually moves while we crunch through chunks.
                pct = 65 + int((current_batch / total_batches) * 15)
                try:
                    progress_callback(pct, f"embeddingBatch:{current_batch}:{total_batches}")
                except Exception as cb_err:
                    logger.debug("Embedding progress_callback raised: %s", cb_err)

        # Step 3: Insert into langchain_pg_embedding using sync psycopg2.
        # PostgreSQL TEXT cannot store NUL bytes (\x00); strip up front so one
        # bad chunk doesn't poison the whole book. Each row runs inside a
        # SAVEPOINT so any other UntranslatableCharacter / encoding fault on
        # one chunk rolls back only that row, not the entire batch.
        texts = [t.replace("\x00", "") if isinstance(t, str) else t for t in texts]

        inserted = 0
        for i in range(0, len(enriched_documents), 10):
            batch_texts_slice = texts[i : i + 10]
            batch_embeddings_slice = all_embeddings[i : i + 10]
            batch_meta_slice = sanitized_metadatas[i : i + 10]

            for j, (doc_text, embedding, meta) in enumerate(zip(batch_texts_slice, batch_embeddings_slice, batch_meta_slice, strict=False)):
                doc_id = str(uuid.uuid4())
                try:
                    with db.begin_nested():
                        db.execute(
                            text("""
                                INSERT INTO langchain_pg_embedding (id, collection_id, embedding, document, cmetadata)
                                VALUES (:id, :coll_id, :embedding, :document, :meta)
                            """),
                            {
                                "id": doc_id,
                                "coll_id": collection_uuid,
                                "embedding": str(embedding),
                                "document": doc_text,
                                "meta": json.dumps(meta),
                            },
                        )
                    inserted += 1
                except Exception as row_err:
                    logger.warning("Failed to insert embedding %d: %s", i + j, row_err)

            db.commit()

        logger.info("Stored %d/%d embeddings via sync SQLAlchemy (collection %s)", inserted, len(enriched_documents), collection_id)

        if inserted == 0 and len(enriched_documents) > 0:
            raise RuntimeError(
                f"Stored 0/{len(enriched_documents)} embeddings — every row insert failed; "
                f"see prior 'Failed to insert embedding' warnings for the underlying error"
            )

    except Exception as ex:
        logger.error("Error storing embeddings: %s", str(ex))
        db.rollback()
        raise


def enrich_documents_with_metadata_core(documents: list, collection_id: str, user_id: str, document_id: str = None, **kwargs) -> list:
    """
    Core logic for enriching documents with metadata.

    Args:
        documents: List of documents to enrich (LangChain Document objects or dicts)
        collection_id: Collection identifier
        user_id: User identifier
        document_id: Optional document identifier
        **kwargs: Additional metadata to include

    Returns:
        List of enriched LangChain Document objects
    """
    try:
        from langchain_core.documents import Document as LangchainDocument

        enriched_documents = []

        for doc in documents:
            # Handle both LangChain Document objects and plain dicts
            if isinstance(doc, LangchainDocument):
                # Extract content and metadata from LangChain Document
                content = doc.page_content
                metadata = doc.metadata.copy()
            elif isinstance(doc, dict):
                # Handle plain dict format
                content = doc.get("page_content") or doc.get("content", "")
                metadata = doc.get("metadata", {}).copy()
            else:
                logger.warning("Skipping document with unknown type: %s", type(doc))
                continue

            # Enrich metadata with standard fields
            metadata.update(
                {
                    "collection_id": collection_id,
                    "user_id": user_id,
                    "document_id": document_id,
                    "enriched_at": datetime.now(UTC).isoformat(),
                    **kwargs,  # Include any additional metadata
                }
            )

            # Add content validation
            if not content or not content.strip():
                logger.warning("Skipping document with empty content")
                continue

            # Create enriched LangChain Document
            enriched_doc = LangchainDocument(page_content=content, metadata=metadata)
            enriched_documents.append(enriched_doc)

        logger.info("Enriched %d documents with metadata", len(enriched_documents))
        return enriched_documents

    except Exception as ex:
        logger.error("Error enriching documents with metadata: %s", str(ex))
        raise


# ============================================================================
# ORIGINAL DOCUMENT UTILITIES (from original document_utils.py)
# ============================================================================


def enhanced_json_encoder(obj):
    """Enhanced JSON encoder for document metadata"""
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    # Handle JobStatus enum values
    if hasattr(obj, "value"):
        return obj.value
    return str(obj)


def is_chunk_too_short(chunk_text: str, min_length: int = 20) -> bool:
    """Check if a chunk is too short for processing"""
    return not chunk_text or len(chunk_text.strip()) < min_length


def is_low_value_chunk(chunk_text: str) -> bool:
    """
    Detect chunks that are bibliographic indexes, reference lists, author indexes,
    tables of contents, or other structural content that yields poor entity extraction.

    These chunks waste LLM API calls and produce garbage entities (e.g., extracting
    "J. E. Dixon" from a bibliography line "Dixon, J. E., 45, 67, 89").

    Returns True if the chunk should be skipped for entity extraction.
    """
    if not chunk_text:
        return True

    text = chunk_text.strip()
    lines = text.split("\n")
    non_empty_lines = [ln.strip() for ln in lines if ln.strip()]

    # Pattern 0: Dense page-number references — high ratio of numbers to words
    # e.g., "Kasanis, B., 11, 13, 14, 15, 19, 23, 24, 26 ..."
    digit_chars = sum(1 for c in text if c.isdigit())
    alpha_chars = sum(1 for c in text if c.isalpha())
    if alpha_chars > 0 and digit_chars / alpha_chars > 0.5 and len(text) > 200:
        return True

    if len(non_empty_lines) < 3:
        return False

    # Pattern 1: Author index / bibliography — lines like "Smith, J. E., 45, 67, 89"
    # Characterized by: Name, initials, followed by many page numbers
    bib_pattern = re.compile(r"^[A-Z][a-zà-ž]+,\s+[A-Z]\.\s*[A-Z]?\.\s*,?\s*\d[\d,\s]*$")
    bib_count = sum(1 for ln in non_empty_lines if bib_pattern.match(ln))
    if bib_count >= 5 or (len(non_empty_lines) > 5 and bib_count / len(non_empty_lines) > 0.3):
        return True

    # Pattern 2: Markdown/pipe table with mostly numbers — typical OCR'd index pages
    pipe_lines = sum(1 for ln in non_empty_lines if ln.count("|") >= 2)
    if pipe_lines > 5:
        # Check if pipe-table lines are mostly numbers and short names (index pattern)
        num_heavy_pipe_lines = 0
        for ln in non_empty_lines:
            if ln.count("|") >= 2:
                cells = ln.split("|")
                cell_text = " ".join(cells)
                cell_digits = sum(1 for c in cell_text if c.isdigit())
                cell_alpha = sum(1 for c in cell_text if c.isalpha())
                if cell_alpha > 0 and cell_digits / cell_alpha > 0.4:
                    num_heavy_pipe_lines += 1
        if num_heavy_pipe_lines >= 5:
            return True

    # Pattern 3: Table of contents — lines matching "Chapter/Section N ... page"
    toc_pattern = re.compile(
        r"(?:chapter|section|part|appendix|index|bibliography|references)\s+[\dIVXLCivxlc]+",
        re.IGNORECASE,
    )
    toc_count = sum(1 for ln in non_empty_lines if toc_pattern.search(ln))
    if toc_count >= 5:
        return True

    # Pattern 4: Reference list — lines starting with "[1]", "(1)", or numbered refs
    ref_pattern = re.compile(r"^\s*[\[\(]?\d{1,3}[\]\)]?\s*[A-Z]")
    ref_count = sum(1 for ln in non_empty_lines if ref_pattern.match(ln))
    if ref_count >= 8 or (len(non_empty_lines) > 5 and ref_count / len(non_empty_lines) > 0.4):
        return True

    # Pattern 5: Comma-separated page number sequences dominate the text
    # e.g., "121, 122, 160, 161, 185, 187, 193, 199"
    page_seq_pattern = re.compile(r"\d{1,4}(?:\s*,\s*\d{1,4}){4,}")
    page_seq_count = len(page_seq_pattern.findall(text))
    if page_seq_count >= 10:
        return True

    # Pattern 6: Journal-admin / copyright front-matter / publisher boilerplate.
    # These pages (directory of past issues, subscription info, copyright notices,
    # editorial boards, publisher addresses) yield garbage entities — journal
    # names, mailing addresses, "Hudson Ltd", editorial-board author lists. A real
    # content chunk rarely stacks several of these signals, so require >= 2
    # (or 1 signal + a postal address line, or >= 2 address lines).
    lowered = text.lower()
    boilerplate_signals = (
        "all rights reserved",
        "no part of this",
        "library of congress",
        "cataloging-in-publication",
        "printed in",
        "isbn",
        "issn",
        "subscription",
        "back issues",
        "past issues",
        "directory of past",
        "editorial board",
        "editor-in-chief",
        "manuscript submission",
        "call for papers",
        "guidelines for authors",
        "indexed in",
        "abstracting",
        "p.o. box",
        "po box",
        "copyright ©",
        "© ",
        "first published",
        "all enquiries",
        "all inquiries",
        "may not be reproduced",
    )
    signal_hits = sum(1 for s in boilerplate_signals if s in lowered)
    addr_lines = sum(
        1
        for ln in non_empty_lines
        if re.search(r"\b\d{1,5}\s+\w+(?:\s+\w+){0,3}\s+(?:road|street|avenue|drive|lane|boulevard|blvd|rd\.?|st\.?|ave\.?)\b", ln, re.IGNORECASE)
        or re.search(r"\b[A-Z]{2}\s+\d{5}\b", ln)  # US state abbrev + ZIP
    )
    return bool(signal_hits >= 2 or (signal_hits >= 1 and addr_lines >= 1) or addr_lines >= 2)


def filter_low_quality_chunks(chunks: list[str], min_length: int = 10) -> list[str]:
    """Filter out low-quality chunks like dividers or single headers"""
    filtered_chunks = []

    for chunk in chunks:
        content = chunk.strip()
        # Skip documents that are too short or just dividers/headers
        if len(content) < min_length or content == "-----" or (content.startswith("  #") and len(content.split("\n")) <= 1):
            logger.warning("Skipping low - quality chunk: '%s...'", content[:30])
            continue
        filtered_chunks.append(chunk)

    return filtered_chunks


def calculate_batch_info(total_items: int, batch_size: int, current_index: int) -> dict[str, int]:
    """Calculate batch processing information"""
    total_batches = (total_items + batch_size - 1) // batch_size
    current_batch = current_index // batch_size + 1

    return {
        "current_batch": current_batch,
        "total_batches": total_batches,
        "batch_start": current_index,
        "batch_end": min(current_index + batch_size, total_items),
    }


def validate_file_path(file_path: str) -> bool:
    """Validate that a file exists and is readable"""
    try:
        return os.path.exists(file_path) and os.path.isfile(file_path)
    except Exception as e:
        logger.error("Error validating file path %s: %s", file_path, e)
        return False


def get_file_size_mb(file_path: str) -> float:
    """Get file size in megabytes"""
    try:
        size_bytes = os.path.getsize(file_path)
        return size_bytes / (1024 * 1024)
    except Exception as e:
        logger.error("Error getting file size for %s: %s", file_path, e)
        return 0.0


def create_document_metadata(original_filename: str, content_type: str, file_size: int) -> dict[str, Any]:
    """Create standard document metadata dictionary"""
    return {
        "original_filename": original_filename,
        "content_type": content_type,
        "file_size": file_size,
        "upload_date": time.strftime("%Y-%m-%d %H:%M:%S"),
        "processed_at": time.time(),
    }


def format_processing_time(start_time: float) -> str:
    """Format processing time for display"""
    elapsed = time.time() - start_time
    if elapsed < 60:
        return f"{elapsed:.1f}s"
    elif elapsed < 3600:
        return f"{elapsed / 60:.1f}m"
    else:
        return f"{elapsed / 3600:.1f}h"


def inspect_object_structure(obj, prefix: str = "", max_depth: int = 2, current_depth: int = 0) -> dict[str, Any]:
    """
    Inspect the structure of an object to identify available attributes

    Args:
        obj: The object to inspect
        prefix: String prefix for nested attributes
        max_depth: Maximum recursion depth
        current_depth: Current recursion depth

    Returns:
        A dictionary of available attributes and their types
    """
    if current_depth > max_depth:
        return {"_max_depth_reached": True}

    result = {}
    try:
        # Get all attributes (both public and possibly private)
        attrs = dir(obj)
        for attr in attrs:
            # Skip special methods
            if attr.startswith("__") and attr.endswith("__"):
                continue

            try:
                # Get attribute value
                val = getattr(obj, attr)
                # Store primitive types directly
                if isinstance(val, (str, int, float, bool, type(None))):
                    result[f"{prefix}{attr}"] = f"{type(val).__name__}({val})"
                # Record type info for non-primitive types
                else:
                    result[f"{prefix}{attr}"] = f"{type(val).__name__}"
                    # Recurse into objects but not too deeply
                    if current_depth < max_depth and not isinstance(val, (list, dict, set, tuple)):
                        # Check if it's a custom object worth inspecting
                        if hasattr(val, "__dict__") or hasattr(val, "__slots__"):
                            result[f"{prefix}{attr}_attrs"] = inspect_object_structure(val, f"{prefix}{attr}.", max_depth, current_depth + 1)
            except Exception as ex:
                result[f"{prefix}{attr}"] = f"<Error: {ex!s}>"
    except Exception as ex:
        return {f"{prefix}<inspection_error>": str(ex)}

    return result


# Docling Configuration Functions
def configure_docling_pipeline_options(pipeline_options, is_gpu: bool, ocr_enabled: bool = False):
    """
    Configure Docling pipeline options based on available hardware and features.

    Args:
        pipeline_options: The PdfPipelineOptions object to configure
        is_gpu: Whether GPU is available
        ocr_enabled: Whether OCR is enabled

    Returns:
        The configured pipeline_options object
    """
    try:
        # Get the class name for better error messages
        options_class = pipeline_options.__class__.__name__
        logger.info("Configuring options for class: %s", options_class)

        # Inspect pipeline_options structure to better understand available attributes
        logger.debug("Inspecting pipeline_options structure")
        structure = inspect_object_structure(pipeline_options)
        # Log the structure in a way that doesn't spam the logs too much
        structure_summary = {k: v for k, v in list(structure.items())[:10]}
        logger.debug("Pipeline options structure (partial): %s", structure_summary)

        # Set OCR options
        try:
            if hasattr(pipeline_options, "do_ocr"):
                pipeline_options.do_ocr = ocr_enabled
                logger.info("Set OCR option: do_ocr=%s", ocr_enabled)

            if hasattr(pipeline_options, "ocr_options") and ocr_enabled:
                logger.debug("OCR options found, configuring based on hardware capabilities")

                # Use RapidOCR (PaddleOCR models via ONNX Runtime) on CPU — 5-8x faster
                # than EasyOCR and higher accuracy (96.6% vs ~85%). On GPU, keep EasyOCR
                # as it leverages CUDA acceleration well.
                if not is_gpu:
                    try:
                        from docling.datamodel.pipeline_options import RapidOcrOptions

                        # Docling does NOT pass lang to RapidOCR's Det/Rec lang_type params,
                        # so RapidOCR defaults to Chinese (ch) models. We must set lang_type
                        # via rapidocr_params to use English/Latin detection and recognition.
                        from rapidocr.utils.parse_parameters import LangDet, LangRec

                        pipeline_options.ocr_options = RapidOcrOptions(
                            lang=["english"],
                            force_full_page_ocr=False,
                            rapidocr_params={
                                "Det.lang_type": LangDet.EN,
                                "Rec.lang_type": LangRec.LATIN,
                            },
                        )
                        logger.info("Using RapidOCR (ONNX) with EN/LATIN models for CPU-based OCR")
                    except ImportError:
                        # noinspection PyPep8Naming
                        RapidOcrOptions = None
                        # noinspection PyPep8Naming
                        LangDet = None
                        # noinspection PyPep8Naming
                        LangRec = None
                        logger.warning("RapidOCR not available, falling back to default OCR engine")
        except Exception as ex:
            logger.warning("Could not set OCR options: %s", str(ex))

        # Table structure: FAST TableFormer + do_cell_matching=False.
        # do_cell_matching=False makes the table model emit its own predicted
        # text cells instead of mapping back to PDF cells — the documented fix
        # for tables whose columns get erroneously merged (cheap; it's a flag,
        # not a slower model). We keep FAST (the Docling default) deliberately:
        # measured on this corpus, ACCURATE produced bit-identical output to
        # FAST on the simple science tables that dominate it, while being
        # markedly slower on CPU — it only helps dense/borderless/spanning
        # tables, which this prose-first corpus rarely has. Also stop dropping
        # embedded figures. Guarded so a missing attr on any version is
        # non-fatal.
        try:
            if hasattr(pipeline_options, "do_table_structure"):
                pipeline_options.do_table_structure = True
            if hasattr(pipeline_options, "table_structure_options"):
                try:
                    from docling.datamodel.pipeline_options import TableFormerMode

                    pipeline_options.table_structure_options.mode = TableFormerMode.FAST
                except Exception as mode_ex:
                    logger.warning("Could not set TableFormerMode.FAST: %s", str(mode_ex))
                if hasattr(pipeline_options.table_structure_options, "do_cell_matching"):
                    pipeline_options.table_structure_options.do_cell_matching = False
                logger.info("Configured Docling tables: mode=FAST, do_cell_matching=False")
            if hasattr(pipeline_options, "generate_picture_images"):
                pipeline_options.generate_picture_images = True
        except Exception as ex:
            logger.warning("Could not set table-structure options: %s", str(ex))

        # Try to set artifacts_path for offline model usage
        try:
            artifacts_path = os.environ.get("DOCLING_ARTIFACTS_PATH")
            if artifacts_path and hasattr(pipeline_options, "artifacts_path"):
                pipeline_options.artifacts_path = artifacts_path
                logger.info("Set artifacts_path from environment variable: %s", artifacts_path)
        except Exception as ex:
            logger.warning("Could not set artifacts_path: %s", str(ex))

        # Configure remote services option
        try:
            if hasattr(pipeline_options, "enable_remote_services"):
                pipeline_options.enable_remote_services = False  # Keep offline by default
                logger.info("Disabled remote services for privacy / offline operation")
        except Exception as ex:
            logger.warning("Could not set enable_remote_services: %s", str(ex))

        # Try to set an optimized configuration based on hardware
        try:
            cpu_count = multiprocessing.cpu_count()
            thread_count = min(8, max(2, cpu_count // 2)) if is_gpu else 1

            thread_settings = ["num_worker_threads", "threads", "worker_threads", "concurrency", "max_threads"]

            thread_set = False
            for attr in thread_settings:
                if hasattr(pipeline_options, attr):
                    setattr(pipeline_options, attr, thread_count)
                    logger.info("Set %s=%d based on hardware capabilities", attr, thread_count)
                    thread_set = True
                    break

            if not thread_set and hasattr(pipeline_options, "accelerator_options"):
                for attr in thread_settings:
                    if hasattr(pipeline_options.accelerator_options, attr):
                        setattr(pipeline_options.accelerator_options, attr, thread_count)
                        logger.info("Set accelerator_options.%s=%d based on hardware capabilities", attr, thread_count)
                        thread_set = True
                        break

            if not thread_set and not is_gpu:
                os.environ["DOCLING_MAX_THREADS"] = str(1)
                logger.info("Set DOCLING_MAX_THREADS environment variable to 1 for CPU processing")

        except Exception as ex:
            logger.warning("Could not configure threading options: %s", str(ex))

        return pipeline_options

    except Exception as e:
        logger.error("Error configuring Docling pipeline options: %s", str(e))
        return pipeline_options


def setup_docling_environment(is_gpu: bool, device_type: str = "cpu"):
    """
    Setup environment variables for optimal Docling performance.

    Args:
        is_gpu: Whether GPU is available
        device_type: The specific device type (cuda, opencl, mps, cpu)
    """
    try:
        # Configure HuggingFace cache directory first
        import platform

        # Get the project root directory for local model storage.
        # File now lives at src/main/utils/documents/utils.py -> go up 4 levels.
        current_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.abspath(os.path.join(current_dir, "..", "..", "..", ".."))
        local_models_dir = os.path.join(project_root, "data", "models", "huggingface")

        # Ensure local models directory exists
        os.makedirs(local_models_dir, exist_ok=True)

        # Configure HuggingFace cache directory to use our local models directory
        os.environ["HF_HOME"] = local_models_dir
        os.environ["HUGGINGFACE_HUB_CACHE"] = local_models_dir

        if platform.system() == "Windows":
            # Additional Windows-specific environment variables for HuggingFace
            os.environ["HF_HUB_DISABLE_EXPERIMENTAL_WARNING"] = "1"
            os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "0"  # Keep progress bars for user feedback
            os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
            # Disable symlinks for HuggingFace Hub (requires admin privileges on Windows)
            os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1"
            os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"
            # Set a reasonable timeout for downloads
            os.environ["HF_HUB_DOWNLOAD_TIMEOUT"] = "300"  # 5 minutes
            logger.info("Applied Windows-specific HuggingFace configuration (symlinks disabled)")

        logger.info("HuggingFace cache configured to use local directory: %s", local_models_dir)

        if is_gpu:
            # Note: Primary Docling accelerator configuration happens in run_service.py before imports
            # This section handles runtime optimizations and additional device-specific settings

            # Set device-specific runtime optimizations
            if device_type == "opencl":
                # For OpenCL GPUs (AMD), additional runtime settings
                logger.info("Configuring for OpenCL GPU - PyTorch will use CPU, but OpenCL acceleration enabled where supported")

                # Additional OpenCL specific settings (supplementing run_service.py configuration)
                os.environ["OPENCL_VENDOR_PATH"] = "/opt/amdgpu-pro/etc/OpenCL/vendors"

                # For AMD GPUs with ROCm/OpenCL support
                os.environ["HIP_VISIBLE_DEVICES"] = "0"
                os.environ["ROCR_VISIBLE_DEVICES"] = "0"

            elif device_type == "cuda":
                # For CUDA GPUs (NVIDIA) - additional runtime settings
                os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:512"

            elif device_type == "mps":
                # For Apple Silicon GPUs
                os.environ["TORCH_DEVICE"] = "mps"
                os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"

            # Allow more threads for GPU processing
            os.environ["OMP_NUM_THREADS"] = "4"
            os.environ["MKL_NUM_THREADS"] = "4"
            os.environ["NUMEXPR_NUM_THREADS"] = "4"

            logger.info("Set GPU environment variables for Docling acceleration (device: %s)", device_type)
            if device_type == "opencl":
                logger.warning("Note: OpenCL GPUs use CPU fallback for PyTorch but may accelerate other operations")
        else:
            # Set threading limits for CPU processing
            os.environ["OMP_NUM_THREADS"] = "1"
            os.environ["MKL_NUM_THREADS"] = "1"
            os.environ["NUMEXPR_NUM_THREADS"] = "1"

        # Set memory management
        if not is_gpu:
            try:
                system_memory = psutil.virtual_memory().total
                memory_limit = int(system_memory * 0.6)  # Use 60% of available memory
                os.environ["DOCLING_MEMORY_LIMIT"] = str(memory_limit)
            except ImportError:
                logger.warning("psutil not available for memory limit setting")

        if is_gpu:
            logger.info("Docling environment configured for GPU processing (device: %s)", device_type)
            if device_type == "opencl":
                logger.info("Note: OpenCL GPUs may use CPU fallback for PyTorch operations")
        else:
            logger.info("Docling environment configured for CPU processing")

    except Exception as ex:
        logger.warning("Error setting up Docling environment: %s", str(ex))


# Entity Extraction Functions
def get_entity_types_description() -> str:
    """Get description of supported entity types matching the EntityType enum."""
    return """
- PERSON: Named individuals (e.g., "Albert Einstein", "Marie Curie", "Nikola Tesla")
- CONCEPT: Ideas, theories, methodologies, frameworks, organizations, disciplines (e.g., "machine learning", "quantum mechanics", "natural selection", "UNESCO", "cognitive science")
- PLACE: Geographic locations, cities, countries, geopolitical entities (e.g., "Silicon Valley", "European Union", "Amazon rainforest")
- EVENT: Historical events, conferences, discoveries, milestones (e.g., "World War II", "Apollo 11 moon landing", "NeurIPS 2024")
- TERM: Technical terms, domain-specific vocabulary, named works, publications (e.g., "backpropagation", "Turing completeness", "The Origin of Species", "p-value")
- QUOTE: Direct quotations from the text with attribution (e.g., "I think, therefore I am" by Descartes)
"""


def get_output_format_instruction() -> str:
    """Get instructions for output format with strict JSON schema."""
    return """
Return ONLY a valid JSON array. Each element must have exactly these fields:
- "name": The exact name or term as it appears in the text
- "description": Brief description (1-2 sentences) of what this entity represents in context
- "confidence": Float between 0.0 and 1.0 indicating extraction confidence
- "type": MUST be exactly one of: PERSON, CONCEPT, PLACE, EVENT, TERM, QUOTE

Example output:
[
  {"name": "neural network", "description": "A computational model inspired by biological neural networks used in machine learning.", "confidence": 0.95, "type": "CONCEPT"},
  {"name": "Geoffrey Hinton", "description": "Researcher known as a pioneer of deep learning.", "confidence": 0.9, "type": "PERSON"},
  {"name": "backpropagation", "description": "Algorithm for training neural networks by computing gradients.", "confidence": 0.85, "type": "TERM"}
]

Do NOT use any type values other than: PERSON, CONCEPT, PLACE, EVENT, TERM, QUOTE.
"""


def format_extraction_prompt(prompt_template: str, chunk_text: str, document_context: str = "") -> str:
    """Format extraction prompt with chunk text and optional document context"""
    try:
        entity_types: str = get_entity_types_description()
        output_format: str = get_output_format_instruction()

        # Try with chunk_text first, then fallback to text if that fails
        try:
            return prompt_template.format(
                chunk_text=chunk_text,
                entity_types=entity_types,
                output_format=output_format,
                document_context=document_context,
            )
        except KeyError:
            # Try with text instead of chunk_text
            return prompt_template.format(
                text=chunk_text,
                entity_types=entity_types,
                output_format=output_format,
                document_context=document_context,
            )

    except KeyError as key_error:
        logger.error("Missing placeholder in prompt template: %s", str(key_error))
        # Return a simple fallback prompt
        return f"""Extract key entities from the following text:

{chunk_text}

Return the entities as a JSON array with name, description, confidence, and type fields."""


def format_extraction_prompt_for_types(prompt_template: str, chunk_text: str, entity_types_filter: list[str], document_context: str = "") -> str:
    """
    Format extraction prompt for a filtered subset of entity types.

    Used when some entity types are handled by spaCy, so the LLM only
    needs to extract the remaining types.

    Args:
        prompt_template: Prompt template with {chunk_text}, {entity_types}, {output_format} placeholders
        chunk_text: The text to extract entities from
        entity_types_filter: List of entity type names to extract (e.g., ["CONCEPT", "TERM", "QUOTE", "EVENT"])
        document_context: Optional context about the document for improved extraction

    Returns:
        Formatted prompt string with only the specified entity types
    """
    # Build a filtered entity types description
    all_type_descriptions = {
        "PERSON": '- PERSON: Named individuals (e.g., "Albert Einstein", "Marie Curie", "Nikola Tesla")',
        "CONCEPT": '- CONCEPT: Ideas, theories, methodologies, frameworks, organizations, disciplines (e.g., "machine learning", "quantum mechanics", "natural selection", "UNESCO", "cognitive science")',
        "PLACE": '- PLACE: Geographic locations, cities, countries, geopolitical entities (e.g., "Silicon Valley", "European Union", "Amazon rainforest")',
        "EVENT": '- EVENT: Historical events, conferences, discoveries, milestones (e.g., "World War II", "Apollo 11 moon landing", "NeurIPS 2024")',
        "TERM": '- TERM: Technical terms, domain-specific vocabulary, named works, publications (e.g., "backpropagation", "Turing completeness", "The Origin of Species", "p-value")',
        "QUOTE": '- QUOTE: Direct quotations from the text with attribution (e.g., "I think, therefore I am" by Descartes)',
    }

    filtered_descriptions = "\n".join(all_type_descriptions[t] for t in entity_types_filter if t in all_type_descriptions)

    type_names = ", ".join(entity_types_filter)
    output_format = f"""
Return ONLY a valid JSON array. Each element must have exactly these fields:
- "name": The exact name or term as it appears in the text
- "description": Brief description (1-2 sentences) of what this entity represents in context
- "confidence": Float between 0.0 and 1.0 indicating extraction confidence
- "type": MUST be exactly one of: {type_names}

Do NOT use any type values other than: {type_names}.
"""

    # Escape stray curly braces in template that are not placeholders
    import re

    known_placeholders = {"chunk_text", "text", "entity_types", "output_format", "document_context"}

    def _escape_unknown_braces(tmpl: str) -> str:
        def replacer(m: re.Match) -> str:
            # noinspection PyTypeChecker
            key = m.group(1)
            # noinspection PyTypeChecker
            return m.group(0) if key in known_placeholders else "{{" + key + "}}"

        return re.sub(r"\{([^}]*)\}", replacer, tmpl)

    safe_template = _escape_unknown_braces(prompt_template)
    try:
        return safe_template.format(
            chunk_text=chunk_text,
            entity_types=filtered_descriptions,
            output_format=output_format,
            document_context=document_context,
        )
    except KeyError:
        try:
            return safe_template.format(
                text=chunk_text,
                entity_types=filtered_descriptions,
                output_format=output_format,
                document_context=document_context,
            )
        except KeyError as key_error:
            logger.error("Missing placeholder in prompt template for filtered types: %s", str(key_error))
            return f"""Extract key entities from the following text. Only extract these types: {type_names}

{chunk_text}

{filtered_descriptions}

{output_format}"""


def get_extraction_prompt_template(_entity_config: dict[str, Any]) -> str:
    """Get the entity extraction prompt template from prompts.yaml"""
    return resolved_prompts.get("entity_extraction", {}).get(
        "extraction_prompt",
        """
You are an expert at extracting key entities from text. Analyze the following text chunk and extract important entities.

Text to analyze:
{chunk_text}

Extract the following types of entities:
{entity_types}

For each entity, provide:
1. The exact name / term as it appears in the text
2. A brief description of what it represents
3. A confidence score from 0.0 to 1.0
4. The entity type

{output_format}

Focus on entities that are central to the meaning and content of the text. Avoid extracting very common words or overly specific details unless
they are particularly important.
""",
    )


def parse_extraction_response(response_text: str, chunk_text: str = None, _entity_config: dict[str, Any] = None) -> list[ExtractedEntity]:
    """
    Parse LLM response for entity extraction.

    Args:
        response_text: Raw response text from LLM (string or AIMessage object)
        chunk_text: Source text (optional, for compatibility)
        _entity_config: Entity configuration (optional, not currently used)

    Returns:
        List of ExtractedEntity objects
    """
    try:
        # Handle AIMessage object (from llm.invoke())
        if hasattr(response_text, "content"):
            response_text = response_text.content

        # Try to find JSON in the response
        json_start = response_text.find("[")
        json_end = response_text.rfind("]") + 1

        if json_start != -1 and json_end > json_start:
            json_text = response_text[json_start:json_end]
            entities_data = json.loads(json_text)

            if isinstance(entities_data, list):
                # Convert to ExtractedEntity objects
                return validate_extracted_entities(entities_data, chunk_text)
            else:
                logger.warning("Parsed JSON is not a list: %s", type(entities_data))
                return []
        else:
            logger.warning("No JSON array found in response")
            return []

    except json.JSONDecodeError as e:
        logger.error("Failed to parse JSON from extraction response: %s", str(e))
        return []
    except Exception as e:
        logger.error("Unexpected error parsing extraction response: %s", str(e))
        return []


def validate_extracted_entities(entities: list[dict[str, Any]], chunk_text: str = None) -> list[ExtractedEntity]:
    """
    Validate and convert extracted entities to the proper format.

    Args:
        entities: List of entity dictionaries from extraction
        chunk_text: Source text (optional, for compatibility)

    Returns:
        List of validated ExtractedEntity objects
    """
    validated_entities = []

    for entity_data in entities:
        try:
            # Validate required fields
            if not all(key in entity_data for key in ["name", "description", "confidence", "type"]):
                logger.warning("Skipping entity with missing required fields: %s", entity_data)
                continue

            # Validate entity type (normalize to lowercase and map prompt types to enum types)
            try:
                raw_type = str(entity_data["type"]).lower().strip()
                # Map prompt entity types to enum values
                type_mapping = {
                    "person": "person",
                    "organization": "concept",  # Map to concept (closest match)
                    "location": "place",  # Map LOCATION to PLACE
                    "concept": "concept",
                    "field": "concept",  # Map FIELD to concept
                    "work": "term",  # Map WORK to term
                    "event": "event",
                    "place": "place",
                    "term": "term",
                    "quote": "quote",
                }
                mapped_type = type_mapping.get(raw_type, raw_type)
                entity_type = EntityType(mapped_type)
            except ValueError:
                logger.warning("Invalid entity type '%s', skipping entity", entity_data["type"])
                continue

            # Validate confidence score
            confidence = float(entity_data["confidence"])
            if not 0.0 <= confidence <= 1.0:
                logger.warning("Invalid confidence score %s, clamping to valid range", confidence)
                confidence = max(0.0, min(1.0, confidence))

            # Create a validated entity
            validated_entity = ExtractedEntity(
                name=str(entity_data["name"]).strip(),
                description=str(entity_data["description"]).strip(),
                confidence_score=confidence,
                entity_type=entity_type,
                source_text=chunk_text or "",
                additional_properties={"source": "llm"},
            )

            validated_entities.append(validated_entity)

        except Exception as e:
            logger.error("Error validating entity %s: %s", entity_data, str(e))
            continue

    return validated_entities


def get_user_retriever_type(db, user_id):
    """
    Get the user's preferred retriever type from settings without instantiating DocumentService.
    This is a standalone utility function to avoid heavy ML imports during startup.

    Args:
        db: Database session
        user_id: User ID

    Returns:
        str: The preferred retriever type ('pgvector', 'neo4j', 'ensemble'), defaults to 'pgvector'
    """
    try:
        # Check if the transaction is in a failed state and rollback if needed
        if hasattr(db, "in_transaction") and db.in_transaction() and hasattr(db, "is_active") and not db.is_active:
            logging.getLogger(__name__).warning("Database transaction is in failed state, rolling back")
            db.rollback()

        # Query user settings for retriever preference
        from sqlalchemy import and_

        from src.main.models.sqlmodel_models import UserSetting

        # Get the retriever settings from document_processing settings
        # noinspection PyTypeChecker
        retriever_settings = (
            # noinspection PyTypeChecker
            db.query(UserSetting)
            # noinspection PyTypeChecker
            .filter(and_(UserSetting.user_id == user_id, UserSetting.setting_key == "document_processing"))
            .first()
        )

        # Default retriever type
        default_retriever = "pgvector"

        if retriever_settings and retriever_settings.setting_value:
            try:
                # Parse the JSON settings
                settings_data = (
                    json.loads(retriever_settings.setting_value)
                    if isinstance(retriever_settings.setting_value, str)
                    else retriever_settings.setting_value
                )
                retriever_type = settings_data.get("retriever_type", default_retriever)

                # Validate the retriever type
                valid_types = ["pgvector", "neo4j", "ensemble"]
                if retriever_type in valid_types:
                    return retriever_type
                else:
                    logging.getLogger(__name__).warning("Invalid retriever type '%s' for user %s, using default", retriever_type, user_id)
                    return default_retriever

            except (json.JSONDecodeError, AttributeError, KeyError) as e:
                logging.getLogger(__name__).warning("Error parsing retriever settings for user %s: %s, using default", user_id, str(e))
                return default_retriever
        else:
            # No settings found, return default
            logging.getLogger(__name__).debug("No retriever settings found for user %s, using default", user_id)
            return default_retriever

    except Exception as e:
        logging.getLogger(__name__).error("Error getting user retriever type for user %s: %s, using default", user_id, str(e))
        return "pgvector"


# ============================================================================
# CHUNKING UTILITIES (from chunking_utils.py)
# ============================================================================


def paragraph_based_chunking(text: str, chunk_size: int, overlap: bool = True) -> list[str]:
    """
    Common paragraph-based chunking logic used across multiple chunking strategies.

    Args:
        text: Text to chunk
        chunk_size: Maximum size of each chunk
        overlap: Whether to add overlap between chunks

    Returns:
        List of text chunks
    """
    paragraphs = re.split(r"\n\s*\n", text)
    chunks = []
    current_chunk = ""

    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            continue

        if len(current_chunk + paragraph) > chunk_size and current_chunk:
            chunks.append(current_chunk.strip())
            if overlap:
                # Add overlap from the end of the previous chunk
                overlap_text = current_chunk[-min(200, len(current_chunk) // 4) :] if current_chunk else ""
                current_chunk = overlap_text + paragraph + "\n\n"
            else:
                current_chunk = paragraph + "\n\n"
        else:
            current_chunk += paragraph + "\n\n"

    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    return chunks


def simple_paragraph_chunking(text: str, chunk_size: int) -> list[str]:
    """
    Simple paragraph-based chunking without overlap - used as a fallback in many strategies.

    Args:
        text: Text to chunk
        chunk_size: Maximum size of each chunk

    Returns:
        List of text chunks
    """
    logger.warning("Falling back to paragraph-based chunking")

    paragraphs = re.split(r"\n\s*\n", text)
    chunks = []
    current_chunk = ""

    for paragraph in paragraphs:
        paragraph = paragraph.strip()
        if not paragraph:
            continue

        if len(current_chunk + paragraph) > chunk_size and current_chunk:
            chunks.append(current_chunk.strip())
            current_chunk = paragraph + "\n\n"
        else:
            current_chunk += paragraph + "\n\n"

    if current_chunk.strip():
        chunks.append(current_chunk.strip())

    return chunks


def sliding_window_chunking(text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
    """
    Common sliding window chunking logic with overlap.

    Args:
        text: Text to chunk
        chunk_size: Maximum size of each chunk
        chunk_overlap: Number of characters to overlap between chunks

    Returns:
        List of text chunks
    """
    logger.info("Using sliding window chunking with size %d and overlap %d", chunk_size, chunk_overlap)

    chunks = []
    # Handle case where text is shorter than chunk_size
    if len(text) <= chunk_size:
        chunks.append(text)
        return chunks

    # Use a sliding window approach with overlap
    for i in range(0, len(text), chunk_size - chunk_overlap):
        # Avoid creating tiny chunks at the end
        if i + chunk_size >= len(text):
            chunks.append(text[i:])
            break
        chunks.append(text[i : i + chunk_size])

    return chunks


def merge_small_chunks(chunks: list[str], min_chunk_size: int = 100) -> list[str]:
    """
    Merge chunks that are smaller than the minimum size.

    Args:
        chunks: List of text chunks
        min_chunk_size: Minimum size for chunks

    Returns:
        List of merged chunks
    """
    if not chunks:
        return []

    result = []
    current_chunk = ""

    for chunk in chunks:
        if len(chunk) < min_chunk_size and current_chunk:
            # Merge with previous chunk
            if len(current_chunk + chunk) < min_chunk_size * 2:
                current_chunk += "\n\n" + chunk
            else:
                result.append(current_chunk)
                current_chunk = chunk
        else:
            # Add accumulated chunk if exists
            if current_chunk:
                result.append(current_chunk)
            current_chunk = chunk

    # Add the final chunk
    if current_chunk:
        result.append(current_chunk)

    return result


def create_document_chunks_with_metadata(
    document: dict[str, Any], chunks: list[str], strategy_name: str, **additional_metadata
) -> list[dict[str, Any]]:
    """
    Create document chunks with standardized metadata structure.

    Args:
        document: Original document with metadata
        chunks: List of text chunks
        strategy_name: Name of the chunking strategy
        **additional_metadata: Additional strategy-specific metadata

    Returns:
        List of document chunks with metadata
    """
    document_chunks = []

    # Handle special list-based metadata that needs per-chunk processing
    chunk_concepts_list = additional_metadata.pop("chunk_concepts_list", None)
    concept_metadata_list = additional_metadata.pop("concept_metadata_list", None)
    narrative_infos = additional_metadata.pop("narrative_infos", None)
    topic_infos = additional_metadata.pop("topic_infos", None)

    for i, chunk_text in enumerate(chunks):
        chunk_metadata = {
            **document.get("metadata", {}),
            "chunk_index": i,
            "total_chunks": len(chunks),
            "chunking_strategy": strategy_name,
            "chunk_size": len(chunk_text),
            **additional_metadata,
        }

        # Add per-chunk specific metadata
        if chunk_concepts_list and i < len(chunk_concepts_list):
            chunk_metadata["chunk_concepts"] = chunk_concepts_list[i]
        if concept_metadata_list and i < len(concept_metadata_list):
            chunk_metadata["concept_metadata"] = concept_metadata_list[i]
        if narrative_infos and i < len(narrative_infos):
            chunk_metadata.update(narrative_infos[i])
        if topic_infos and i < len(topic_infos):
            chunk_metadata.update(topic_infos[i])

        chunk_doc = {"content": chunk_text, "metadata": chunk_metadata}
        document_chunks.append(chunk_doc)

    return document_chunks


def fallback_chunking_with_overlap(text: str, chunk_size: int, chunk_overlap: int) -> list[str]:
    """
    Fallback chunking using a sliding window approach with overlap.

    Args:
        text: Text to chunk
        chunk_size: Size of each chunk
        chunk_overlap: Amount of overlap between chunks

    Returns:
        List of text chunks
    """
    chunks = []

    # Handle case where text is shorter than chunk_size
    if len(text) <= chunk_size:
        chunks.append(text)
        return chunks

    # Use a sliding window approach with overlap
    for i in range(0, len(text), chunk_size - chunk_overlap):
        # Avoid creating tiny chunks at the end
        if i + chunk_size >= len(text):
            chunk = text[i:]
            if len(chunk) > 0:  # Only add non-empty chunks
                chunks.append(chunk)
            break

        chunk = text[i : i + chunk_size]
        if len(chunk) > 0:  # Only add non-empty chunks
            chunks.append(chunk)

    return chunks


def get_default_markdown_headers(use_spaces: bool = False) -> list[tuple[str, str]]:
    """
    Get the default Markdown headers configuration.

    Args:
        use_spaces: Whether to prefix headers with spaces (for compatibility)

    Returns:
        List of tuples containing (header_pattern, header_name)
    """
    prefix = "  " if use_spaces else ""
    return [
        (f"{prefix}#", "Header 1"),
        (f"{prefix}##", "Header 2"),
        (f"{prefix}###", "Header 3"),
        (f"{prefix}####", "Header 4"),
        (f"{prefix}#####", "Header 5"),
        (f"{prefix}######", "Header 6"),
    ]


def setup_markdown_headers(headers_to_split_on, use_spaces: bool = False):
    """
    Setup markdown headers configuration with fallback to defaults.

    Args:
        headers_to_split_on: User-provided headers configuration or None
        use_spaces: Whether to use spaced headers for compatibility

    Returns:
        Configured headers list
    """
    if headers_to_split_on is None:
        return get_default_markdown_headers(use_spaces)
    else:
        return headers_to_split_on


def create_chunk_list_with_method_metadata(
    chunks: list[str], metadata: dict[str, Any], chunk_method: str, extra_metadata_fn=None
) -> list[dict[str, Any]]:
    """
    Create a list of chunks with method-specific metadata - eliminates duplicate chunk creation patterns.

    This function consolidates the common pattern found across chunking strategies where
    chunks are created with method-specific metadata in a loop.

    Args:
        chunks: List of text chunks
        metadata: Base metadata to include in each chunk
        chunk_method: The chunking method name for metadata
        extra_metadata_fn: Optional function that takes (chunk, index) and returns additional metadata dict

    Returns:
        List of document chunks with standardized metadata
    """
    doc_chunks = []
    for i, chunk in enumerate(chunks):
        chunk_metadata = {
            **metadata,
            "chunk_index": i,
            "chunk_size": len(chunk),
            "chunk_method": chunk_method,
            "total_chunks": len(chunks),
        }

        # Add extra metadata if function provided
        if extra_metadata_fn:
            extra_metadata = extra_metadata_fn(chunk, i)
            chunk_metadata.update(extra_metadata)

        doc_chunks.append({"text": chunk, "metadata": chunk_metadata})
    return doc_chunks


# ============================================================================
# FILE UTILITIES (from file_utils.py)
# ============================================================================


def sanitize_filename(original_filename: str, extension: str = None) -> str:
    """
    Sanitize a filename by removing special characters and converting to lowercase.

    Args:
        original_filename: The original filename to sanitize
        extension: Optional file extension to append (without the dot)

    Returns:
        Sanitized filename
    """
    # Remove a file extension if present
    basename = os.path.splitext(original_filename)[0]

    # Replace special characters with underscores and convert to lowercase
    sanitized = re.sub(r"[^a-z0-9]+", "_", basename.lower()).strip("_")

    # Add the extension if provided
    if extension:
        if not extension.startswith("."):
            extension = f".{extension}"
        return f"{sanitized}{extension}"

    # Keep the original file extension
    orig_ext = os.path.splitext(original_filename)[1]
    if orig_ext:
        return f"{sanitized}{orig_ext}"

    return sanitized


def get_upload_path(user_id: str, collection_id: str, workspace_id: str = None, filename: str = None) -> str | tuple[str, str]:
    """
    Generate file paths for uploading a document.

    Args:
        user_id: User ID
        collection_id: Collection ID
        workspace_id: Workspace ID (optional for backward compatibility)
        filename: Filename (already sanitized). If None, returns just the directory path.

    Returns:
        If filename is provided: Tuple of (relative_path, absolute_path)
        If filename is None: absolute directory path

    Note:
        Relative paths are normalized with forward slashes for cross-platform compatibility
        and database storage. Absolute paths keep OS-native separators for file system operations.
    """
    from src.main.utils.files.paths import normalize_path_for_db

    # Get the base upload path from config
    upload_base_path = resolved_config.get("documents", {}).get("upload_path", "data/upload")

    # Generate a base directory path with workspace_id if provided
    if workspace_id:
        base_dir = os.path.join(upload_base_path, str(user_id), str(workspace_id), collection_id)
    else:
        # Fallback to the old structure for backward compatibility
        base_dir = os.path.join(upload_base_path, str(user_id), collection_id)

    absolute_dir = os.path.abspath(base_dir)

    # Create directories if they don't exist
    os.makedirs(absolute_dir, exist_ok=True)

    # If no filename provided, return just the directory path
    if filename is None:
        return absolute_dir

    # Generate full paths with filename
    absolute_path = os.path.join(absolute_dir, filename)
    relative_path = os.path.join(base_dir, filename)

    # Normalize relative path for database storage (forward slashes only)
    relative_path = normalize_path_for_db(relative_path)

    return relative_path, absolute_path


def get_content_store_path(file_hash: str, filename: str) -> tuple[str, str]:
    """
    Generate content-addressable file path for deduplication storage.

    Files are stored in a bucketed directory structure using the first 4 characters
    of the hash to prevent directory bloat: data/content/{hash[0:2]}/{hash[2:4]}/{hash}/{filename}

    Args:
        file_hash: SHA-256 hash of the file bytes
        filename: The filename to store (sanitized)

    Returns:
        Tuple of (relative_path, absolute_path) where relative_path uses forward slashes
    """
    from src.main.utils.files.paths import normalize_path_for_db

    content_path = resolved_config.get("documents", {}).get("content_path", "data/content")
    bucket1 = file_hash[0:2]
    bucket2 = file_hash[2:4]
    base_dir = os.path.join(content_path, bucket1, bucket2, file_hash)
    absolute_dir = os.path.abspath(base_dir)
    os.makedirs(absolute_dir, exist_ok=True)

    absolute_path = os.path.join(absolute_dir, filename)
    relative_path = os.path.join(base_dir, filename)
    relative_path = normalize_path_for_db(relative_path)

    return relative_path, absolute_path


def delete_collection_files(user_id: str, collection_id: str, workspace_id: str = None) -> bool:
    """
    Delete all files associated with a collection.

    Args:
        user_id: User ID
        collection_id: Collection ID
        workspace_id: Workspace ID (optional for backward compatibility)

    Returns:
        True if files were deleted successfully, False otherwise
    """
    try:
        # Get the directory path for this collection
        collection_dir = str(get_upload_path(user_id, collection_id, workspace_id))

        # Check if the directory exists
        if os.path.exists(collection_dir) and os.path.isdir(collection_dir):
            # Delete the entire directory
            shutil.rmtree(collection_dir)
            return True

        # If the directory doesn't exist, return True (nothing to delete)
        return True
    except Exception as e:
        logger.error("Error deleting collection files: %s", str(e))
        return False


def cleanup_file(file_path: str) -> bool:
    """
    Remove a file if it exists.

    Args:
        file_path: Path to the file to remove

    Returns:
        True if the file was removed or didn't exist, False if there was an error
    """
    try:
        if os.path.exists(file_path):
            os.unlink(file_path)
            logger.info("Removed file: %s", file_path)
        return True
    except Exception as e:
        logger.error("Error removing file %s: %s", file_path, str(e))
        return False


def extract_file_extension(filename: str) -> str:
    """
    Extract the file extension from a filename.

    Args:
        filename: The filename to extract an extension from

    Returns:
        The file extension (lowercase, without the dot)
    """
    if not filename:
        return ""

    # Get the extension and convert to lowercase
    ext = os.path.splitext(filename)[1].lower()

    # Remove the dot
    if ext.startswith("."):
        ext = ext[1:]

    return ext


def is_valid_document_type(filename: str, allowed_extensions: list = None) -> bool:
    """
    Check if a file is a valid document type based on its extension.

    Args:
        filename: The filename to check
        allowed_extensions: List of allowed extensions (without dots)

    Returns:
        True if the file has an allowed extension, False otherwise
    """
    if allowed_extensions is None:
        # Default allowed document types (synced with frontend and document processors).
        # Audio/video transcription (Whisper) is not available in this edition,
        # so only text-based document formats are accepted.
        allowed_extensions = ["pdf", "epub", "docx", "md", "txt", "csv", "tsv", "xlsx", "xls", "rtf"]

    ext = extract_file_extension(filename)
    return ext in allowed_extensions


async def save_fastapi_upload(file: "UploadFile", file_path: str) -> dict:
    """
    Save an uploaded file to disk, handling FastAPI UploadFile objects.

    Args:
        file: FastAPI UploadFile object
        file_path: Path to save the file to

    Returns:
        dict: Result with success status, size, and error message if applicable
    """
    try:
        # Ensure the directory exists
        os.makedirs(os.path.dirname(file_path), exist_ok=True)

        # Save the file
        with open(file_path, "wb") as f:
            content = await file.read()
            f.write(content)
            size = len(content)

        logger.info("File saved successfully to %s (%s bytes)", file_path, size)
        return {"success": True, "size": size}
    except Exception as e:
        # Clean up a partial file if there was an error
        if os.path.exists(file_path):
            try:
                os.unlink(file_path)
            except OSError as cleanup_error:
                logger.warning("Could not clean up partial file %s: %s", file_path, cleanup_error)
        logger.exception("Error saving uploaded file: %s", str(e))
        return {"success": False, "error": str(e)}


# ============================================================================
# TITLE PARSING AND VALIDATION UTILITIES
# ============================================================================


def is_title_meaningless(title: str) -> bool:
    """
    Check if a title is meaningless and should be rejected.

    Meaningless titles include:
    - Sentence fragments (ends with common incomplete patterns)
    - Sentences (ends with punctuation)
    - Blurbs or promotional text
    - Common sentence starters
    - Very long titles (likely descriptions)

    Args:
        title: The title to validate

    Returns:
        True if the title is meaningless and should be rejected
    """
    if not title or len(title) < 3:
        return True

    # Convert to lowercase for case-insensitive checks
    title_lower = title.lower().strip()

    # CRITICAL: Check for sentence fragments (incomplete sentences)
    # Example: "family and friends. With curiosity and courage, she has"
    fragment_indicators = [
        " she has",
        " he has",
        " they have",
        " it has",
        " she is",
        " he is",
        " they are",
        " it is",
        " will be",
        " would be",
        " should be",
        " could be",
        " provides",
        " providing",
        " includes",
        " including",
        " with an",
        " with a",
        " with the",
        " that ",
        " which ",
        " who ",
        " where ",
    ]
    # BUG FIX: Downgrade all title rejection logs to DEBUG - this is normal validation, fallback handles it
    if any(title_lower.endswith(indicator) for indicator in fragment_indicators):
        logger.debug("Rejected title (sentence fragment): %s", title)
        return True

    # Check for sentence endings (punctuation)
    if title.rstrip().endswith((".", ",", "!", "?", ";", ":")):
        logger.debug("Rejected title (ends with punctuation): %s", title)
        return True

    # Check if it starts with quotes (likely a blurb)
    if title.startswith(('"', "'", '"', '"', """, """)):
        logger.debug("Rejected title (starts with quotes): %s", title)
        return True

    # Check for subtitle/descriptor patterns (not actual titles)
    subtitle_patterns = [
        "translated with",
        "translated by",
        "translated and",
        "edited by",
        "edited with",
        "foreword by",
        "introduction by",
        "with introduction",
        "with notes by",
        "with a foreword",
        "with a preface",
        "compiled by",
        "adapted by",
        "revised by",
        "abridged by",
    ]
    if any(title_lower.startswith(pattern) for pattern in subtitle_patterns):
        logger.debug("Rejected title (subtitle/descriptor): %s", title)
        return True

    # Check for common sentence starters (lowercase because already converted)
    sentence_starters = [
        "in ",
        "this ",
        "that ",
        "with ",
        "providing ",
        "including ",
        "featuring ",
        "an extraordinary",
        "a comprehensive",
        "a fascinating",
    ]
    if any(title_lower.startswith(starter) for starter in sentence_starters):
        logger.debug("Rejected title (sentence starter): %s", title)
        return True

    # Allow "The", "A", "An" at the start — too common in book titles to reject

    # Check for blurb/review indicators
    blurb_keywords = ["reader", "brilliant", "excellent", "masterpiece", "must-read", "fascinating", "provided"]
    if any(keyword in title_lower for keyword in blurb_keywords):
        logger.debug("Rejected title (contains blurb keywords): %s", title)
        return True

    # Check if it's too long (likely a description, not a title)
    if len(title) > 150:
        logger.debug("Rejected title (too long): %s", title[:50])
        return True

    # Check word count - titles are usually concise
    word_count = len(title.split())
    if word_count > 20:
        logger.debug("Rejected title (too many words: %d): %s", word_count, title[:50])
        return True

    return False


_FILENAME_FUNCTION_WORDS = frozenset(
    {
        "of",
        "and",
        "the",
        "in",
        "on",
        "at",
        "to",
        "for",
        "or",
        "by",
        "an",
        "a",
        "is",
        "as",
        "vs",
        "not",
        "no",
        "but",
        "with",
        "from",
        "into",
        "my",
        "our",
        "your",
        "his",
        "her",
        "their",
    }
)
_FILENAME_BLEED_WORDS = frozenset({"of", "by", "and", "or"})  # leading-token strip targets
_FILENAME_ROLE_PREFIX_RE = re.compile(
    r"^(?:editors?|eds?)[-_\s]+of[-_\s]+\w+(?:[-_\s]+\w+){0,2}[-_\s]+"
    r"(?:publishing|press|publications|publishers|books|university|institute|society)[-_\s]+",
    re.IGNORECASE,
)
_FILENAME_ARCHIVAL_SUFFIX_RE = re.compile(
    r"[-_\s]+(?:rescued|dup|copy|backup|ocr|v\d+|part[-_]\d+|final|draft)$",
    re.IGNORECASE,
)
_FILENAME_BULLETIN_SUFFIX_RE = re.compile(
    r"[-_\s]+(?:storey[-_]s?[-_]country[-_]wisdom[-_]bulletin|country[-_]wisdom[-_]bulletin)"
    r"[-_]\w+[-_]\d+$",
    re.IGNORECASE,
)
_FILENAME_AUTH_MARKER_RE = re.compile(r"_auth_", re.IGNORECASE)
# Anna's Archive metadata bloat: ISBN + MD5 + "Anna's Archive" suffix.
# Example: "..._9780866191548_ef76bc2d05f6a028ec5477f51afc8c9a_anna_s_archive"
_FILENAME_ARCHIVE_BLOAT_RE = re.compile(
    r"[-_\s]+\d{10,13}(?:[-_\s]+[\da-fA-F]{20,})?[-_\s]+anna[-_]?s?[-_]archive$",
    re.IGNORECASE,
)
# Only Anna's Archive trailer (no leading ISBN). Same site, partial match.
_FILENAME_ANNAS_ARCHIVE_RE = re.compile(
    r"[-_\s]+anna[-_]?s?[-_]archive$",
    re.IGNORECASE,
)
# Articles that strongly signal title start.
_FILENAME_TITLE_ARTICLES = frozenset({"the", "an", "a", "my"})
# Role / authorship markers that often replace a real author block in
# bibliographic filenames. They sit at the very front of the filename
# (after the year prefix) and never belong to the title proper.
_FILENAME_ROLE_MARKERS = frozenset({"coll", "ed", "eds", "editor", "editors", "auth", "trans", "anon", "unknown"})


def _restore_filename_apostrophes(text: str) -> str:
    """Reattach common contraction/possessive markers split by underscore tokenisation.

    `beekeeper s handbook` → `beekeeper's handbook`,
    `don t worry` → `don't worry`, `we ll` → `we'll`, etc.
    """
    text = re.sub(r"\b([A-Za-z]{2,})\s+s\b", r"\1's", text)
    text = re.sub(r"\b([A-Za-z]{2,})\s+t\b", r"\1't", text)
    text = re.sub(r"\b([A-Za-z]{2,})\s+ve\b", r"\1've", text)
    text = re.sub(r"\b([A-Za-z]{2,})\s+ll\b", r"\1'll", text)
    text = re.sub(r"\b([A-Za-z]{2,})\s+re\b", r"\1're", text)
    text = re.sub(r"\b([A-Za-z]{2,})\s+d\b", r"\1'd", text)
    return text


_FILENAME_EXTENSION_MIME = {
    "pdf": "application/pdf",
    "epub": "application/epub+zip",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "txt": "text/plain",
    "md": "text/markdown",
    "markdown": "text/markdown",
    "rtf": "application/rtf",
    "csv": "text/csv",
    "html": "text/html",
    "htm": "text/html",
}


def derive_file_type_from_filename(filename: str | None, fallback: str | None = None) -> str | None:
    """Return the canonical MIME type for ``filename`` based on extension.

    Used at upload / batch-import time when the request-supplied ``content_type``
    is unreliable (`application/octet-stream`, the bare extension `pdf`, etc.).
    Falls back to the supplied ``fallback`` when the extension is unknown so
    callers can decide whether to keep the original value or set NULL.
    """
    if not filename:
        return fallback
    ext = os.path.splitext(filename)[1].lstrip(".").lower()
    return _FILENAME_EXTENSION_MIME.get(ext, fallback)


def parse_title_from_filename(filename: str) -> str | None:
    """
    Parse a book title from a filename.

    Pipeline:
      1. Strip extension and leading year/`0_` prefix.
      2. Strip trailing archival markers (`_rescued`, `_dup`, `_v2`, ...).
      3. Strip Storey-style country-wisdom bulletin suffix.
      4. Strip publisher prefix (`editors_of_X_publishing_`).
      5. If `_auth_` marker present, drop everything before and including it.
      6. Try em-dash/hyphen split (the trailing segment is the title).
      7. Else: tokenise, drop initials in the first 4 tokens, then either:
         - cut at the first non-fn → fn transition (article/preposition entering title)
         - or strip a single leading author pair when none of the first two
           tokens is a function word.
      8. Drop a leading bare `of`/`by`/`and`/`or` and a trailing 4-digit year token.
      9. Restore apostrophes lost to underscore tokenisation.
     10. `smart_title_case` for final casing.

    Examples:
      - "1992_karla_turner_into_the_fringe.pdf" → "Into the Fringe"
      - "1978_diana_sammataro_alphonse_avitabile_the_beekeeper_s_handbook_rescued.pdf"
            → "The Beekeeper's Handbook"
      - "1981_editors_of_storey_publishing_starting_right_with_bees_storey_s_country_wisdom_bulletin_a_36.epub"
            → "Starting Right with Bees"
      - "1977_kenneth_m_smith_c_b_e_d_sc_ph_d_f_r_s_auth_plant_viruses.pdf"
            → "Plant Viruses"
      - "1995_bruce_d_smith_the_emergence_of_agriculture.pdf"
            → "The Emergence of Agriculture"

    Returns the parsed title or None when the result fails length validation.
    """
    try:
        basename = os.path.splitext(filename)[0]

        # 1. Strip year/zero prefix.
        basename = re.sub(r"^[\(\[]?\d{4}[\)\]]?[-_\s]+", "", basename)
        basename = re.sub(r"^0[-_\s]+", "", basename)

        # 2. Strip trailing archival markers (loop — multiple may stack).
        for _ in range(3):
            new_basename = _FILENAME_ARCHIVAL_SUFFIX_RE.sub("", basename)
            if new_basename == basename:
                break
            basename = new_basename

        # 3. Strip Anna's Archive metadata bloat (ISBN + MD5 + suffix).
        basename = _FILENAME_ARCHIVE_BLOAT_RE.sub("", basename)
        basename = _FILENAME_ANNAS_ARCHIVE_RE.sub("", basename)

        # 3b. Strip Storey country-wisdom bulletin suffix (entire bulletin marker).
        basename = _FILENAME_BULLETIN_SUFFIX_RE.sub("", basename)

        # 3c. Strip leading role markers ("coll", "ed", "eds", "auth", "trans",
        # "anon", "unknown_author"). These appear in libgen / archive-style
        # filenames as collective-author placeholders ("1962_coll_journal_of_
        # the_siam_society_50") and inflate the heuristic's pair-strip into
        # consuming legitimate title nouns. Strip them BEFORE tokenisation so
        # the article rule and pair-strip see a clean candidate set.
        # IMPORTANT: handle the compound "unknown_author" first — otherwise
        # the next single-token strip below eats "unknown" alone and leaves
        # "author_..." which the pair-strip then conflates with the title.
        basename = re.sub(r"^unknown[-_\s]+author[-_\s]+", "", basename, flags=re.IGNORECASE)
        basename = re.sub(
            r"^(?:" + "|".join(re.escape(w) for w in _FILENAME_ROLE_MARKERS) + r")[-_\s]+",
            "",
            basename,
            flags=re.IGNORECASE,
        )

        # Track whether a "strong" prefix strip already isolated the title.
        # When yes, skip the transition heuristic — the remaining text IS the
        # title and any further chopping mid-title (e.g. at a "with" preposition)
        # would corrupt it.
        explicit_prefix_strip = False

        # 4. Strip "editors of X publishing" prefix.
        new_basename = _FILENAME_ROLE_PREFIX_RE.sub("", basename)
        if new_basename != basename:
            explicit_prefix_strip = True
            basename = new_basename

        # 5. If `_auth_` marker exists, strip everything up to and including it.
        match = _FILENAME_AUTH_MARKER_RE.search(basename)
        if match:
            explicit_prefix_strip = True
            basename = basename[match.end() :]

        # 6. Em-dash / hyphen split.
        parts = re.split(r"\s*[-–—]\s*", basename)
        if len(parts) >= 2 and len(parts[-1].strip()) >= 5:
            basename = parts[-1]
            words = basename.replace("_", " ").split()
        else:
            # 7. Tokenise.
            words = basename.replace("_", " ").replace("-", " ").split()

            if len(words) > 3 and not explicit_prefix_strip:
                # Drop initials inside the first 4 tokens (single alpha chars).
                head, tail = words[:4], words[4:]
                head = [w for w in head if not (len(w) == 1 and w.isalpha())]
                words = head + tail

                # Find an article boundary ("the/a/an/my") preceded by a
                # non-function word — that's a strong "Author ... THE Title"
                # signal. Restricted to articles (vs all function words) so
                # mid-title prepositions like "Thyme on My Hands" or
                # "Apiculture in India" don't cut the actual title.
                title_start = -1
                for i in range(2, min(len(words), 8)):
                    prev_w = words[i - 1].lower()
                    curr_w = words[i].lower()
                    if prev_w not in _FILENAME_FUNCTION_WORDS and curr_w in _FILENAME_TITLE_ARTICLES:
                        title_start = i
                        break

                if title_start >= 2:
                    words = words[title_start:]
                elif len(words) > 4 and words[0].lower() not in _FILENAME_FUNCTION_WORDS and words[1].lower() not in _FILENAME_FUNCTION_WORDS:
                    # Single leading author pair (firstname lastname) → strip 2.
                    # We deliberately do NOT iterate: in 3+ author filenames the
                    # next pair often contains the first noun(s) of the actual
                    # title (e.g. "Veerle Linseele Archaeofaunal Remains" —
                    # "Archaeofaunal Remains" is title content, not an author).
                    # Iterating silently truncates real titles down to a
                    # meaningless prepositional phrase.
                    words = words[2:]

        # 8a. Drop a leading bare `of`/`by`/`and`/`or`.
        while words and words[0].lower() in _FILENAME_BLEED_WORDS:
            words = words[1:]

        # 8b. Drop a trailing 4-digit year duplicate.
        if len(words) > 2 and re.match(r"^\d{4}$", words[-1]):
            words = words[:-1]

        title = " ".join(words).strip()

        # 9. Restore apostrophes split by underscore tokenisation.
        title = _restore_filename_apostrophes(title)

        # 10. Smart title case (preserves Roman numerals and abbreviations).
        title = smart_title_case(title)

        if len(title) < 3:
            logger.warning("Parsed title from filename too short: %s", title)
            return None

        # Marketing-style subtitles (filenames that embed the full back-cover
        # blurb) can blow past any reasonable display width. Truncate at the
        # last word boundary inside an 80-char window so we still surface a
        # usable title rather than reverting to the raw filename slug.
        if len(title) > 80:
            cutoff = title.rfind(" ", 0, 80)
            if cutoff > 30:
                title = title[:cutoff].rstrip(",;:-")

        logger.info("Parsed title from filename '%s': %s", filename, title)
        return title

    except Exception as e:
        logger.error("Error parsing title from filename '%s': %s", filename, str(e))
        return None


def get_fallback_title(filename: str, extracted_title: str | None = None) -> str:
    """
    Get a fallback title when LLM extraction fails.

    Priority:
    1. Use extracted_title if it's meaningful
    2. Parse from filename
    3. Use sanitized filename as last resort

    Args:
        filename: The original filename
        extracted_title: The LLM-extracted title (may be meaningless)

    Returns:
        A valid title string
    """
    # First, check if extracted_title is meaningful
    if extracted_title and not is_title_meaningless(extracted_title):
        # Convert ALL CAPS to title case (e.g., "THE ART OF WAR" → "The Art Of War")
        if extracted_title.isupper():
            return extracted_title.title()
        return extracted_title

    # If extracted title is meaningless, log it and try filename
    # BUG FIX: Downgrade to DEBUG - this is normal fallback behavior
    if extracted_title:
        logger.debug("Extracted title is meaningless: '%s', falling back to filename parsing", extracted_title)

    # Try to parse from filename
    parsed_title = parse_title_from_filename(filename)
    if parsed_title:
        return parsed_title

    # Last resort: use sanitized filename
    fallback = os.path.splitext(filename)[0].replace("_", " ").replace("-", " ").title()
    logger.info("Using sanitized filename as fallback title: %s", fallback)
    return fallback


# ============================================================================
# DOCUMENT CONTENT EXTRACTION UTILITIES
# ============================================================================


def extract_pdf_to_markdown(
    file_path: str,
    page_chunks: bool = True,
    show_progress: bool = False,
    hdr_info: Any | None = None,
) -> tuple[str | None, int | None]:
    """
    Extract text content from a PDF file and convert to Markdown format.

    Uses pymupdf4llm for high-quality markdown conversion with:
    - Preserved headers and formatting
    - Page chunking for processing (optional)
    - Clean text output suitable for LLM context

    Args:
        file_path: Path to the PDF file
        page_chunks: If True, split by pages (useful for large docs). Default: True
        show_progress: If True, show progress bar during conversion. Default: False
        hdr_info: Header detection configuration. None uses default (font size based)

    Returns:
        Tuple of (markdown_text, page_count) or (None, None) if extraction fails

    Usage:
        # For RAG/background processing (no progress needed)
        content, pages = extract_pdf_to_markdown(path)

        # For interactive processing with progress
        content, pages = extract_pdf_to_markdown(path, show_progress=True)

        # For small docs that fit in context (single chunk)
        content, pages = extract_pdf_to_markdown(path, page_chunks=False)
    """

    def _parse_pymupdf_result(parse_result, source_label: str):
        """Parse pymupdf4llm result (list of page dicts or string) into (text, page_count)."""
        if isinstance(parse_result, list):
            markdown_parts = []
            for page_data in parse_result:
                if isinstance(page_data, dict) and "text" in page_data:
                    markdown_parts.append(page_data["text"])
                elif isinstance(page_data, str):
                    markdown_parts.append(page_data)
            text = "\n\n".join(markdown_parts)
            return (text, len(parse_result)) if text and text.strip() else (None, None)
        elif isinstance(parse_result, str):
            return (parse_result, None) if parse_result and parse_result.strip() else (None, None)
        else:
            logger.error("Unexpected %s result type: %s", source_label, type(parse_result))
            return None, None

    # Attempt 1: pymupdf4llm (may use -layout variant if installed)
    try:
        import pymupdf4llm

        md_result = pymupdf4llm.to_markdown(file_path, page_chunks=page_chunks, show_progress=show_progress, hdr_info=hdr_info)
        markdown_text, page_count = _parse_pymupdf_result(md_result, "pymupdf4llm")
        if markdown_text:
            logger.info("Extracted PDF to markdown: %d pages, %d chars", page_count or 0, len(markdown_text))
            return markdown_text, page_count
        logger.warning("pymupdf4llm returned empty markdown for %s", file_path)

    except ImportError:
        pymupdf4llm = None
        logger.warning("pymupdf4llm not installed, trying pymupdf fallback")
    except Exception as e:
        logger.warning("pymupdf4llm failed for %s: %s — trying pymupdf fallback", file_path, str(e))

    # Attempt 2: plain pymupdf text extraction (handles PDFs that crash pymupdf4llm-layout)
    try:
        import pymupdf

        doc = pymupdf.open(file_path)
        pages_text = []
        for page in doc:
            pages_text.append(page.get_text("text"))
        doc.close()

        markdown_text = "\n\n".join(pages_text)
        if markdown_text and markdown_text.strip():
            logger.info("Extracted PDF via pymupdf fallback: %d pages, %d chars", len(pages_text), len(markdown_text))
            return markdown_text, len(pages_text)
        logger.warning("pymupdf fallback returned empty text for %s", file_path)

    except Exception as e2:
        logger.error("pymupdf fallback also failed for %s: %s", file_path, str(e2))

    return None, None


_FRONTMATTER_TITLE_RE = re.compile(
    r"^\s*("
    r"cover|title\s*page|copyright|imprint|colophon|"
    r"contents|table\s+of\s+contents|toc|"
    r"acknowledg(e)?ments?|dedication|epigraph|"
    r"foreword|preface|"
    r"about\s+the\s+author|about\s+the\s+book|"
    r"index|bibliography|references|notes"
    r")\s*$",
    re.IGNORECASE,
)
_FRONTMATTER_FILENAME_RE = re.compile(
    r"(cover|title|copyright|colophon|imprint|toc|nav|contents|"
    r"acknowledg|dedication|epigraph|foreword|preface|about[-_]?the[-_]?author|"
    r"index|biblio|references)",
    re.IGNORECASE,
)


def _is_frontmatter(filename: str, title: str | None, body_chars: int) -> bool:
    """Heuristic to skip non-body items (cover, copyright, TOC, dedication,
    acknowledgments, index, etc.) when emitting an EPUB markdown summary.

    Returns True iff the item is short AND its filename or title matches a
    well-known frontmatter pattern. Keeps real chapters even if they happen
    to be short.
    """
    short = body_chars < 1500
    if not short:
        return False
    if filename and _FRONTMATTER_FILENAME_RE.search(filename):
        return True
    return bool(title and _FRONTMATTER_TITLE_RE.match(title.strip()))


def _epub_chapter_to_markdown(soup: Any) -> str:
    """Flatten an EPUB chapter's BeautifulSoup tree to markdown text,
    preserving ``<h1>``..``<h6>`` as ``#``..``###### `` markers.

    Before this helper the extractor called ``soup.get_text(separator="\\n",
    strip=True)`` which discarded ALL HTML tag structure — sub-headings
    inside a chapter (15 H2 + 33 H3 across a typical 53-spine alchemy EPUB)
    collapsed into plain prose. The downstream chunker then saw only the
    one ``# Chapter N`` per spine entry that the extractor's own loop
    emits, so 53 spine files collapsed into 2-3 distinct chapter_numbers
    after chunking. See incident on doc ``84d16cf3`` (Alchemy: Secrets of
    Consciousness Transformation) — EPUB had real semantic H1s ("The
    Great Work", "The Science of Fire", ...) which were lost.

    Strategy: walk the soup, replace each ``<hN>`` element with a
    ``NavigableString`` carrying the equivalent markdown ``#`` marker plus
    the heading text plus surrounding blank lines, then call
    ``get_text()`` which now emits the markdown prefix verbatim along
    with the rest of the body prose.

    Idempotent: replaces only inside the supplied soup, does not mutate
    the EPUB on disk.
    """
    try:
        from bs4 import NavigableString
    except ImportError:
        return soup.get_text(separator="\n", strip=True)

    # Walk all heading levels in document order. Replace each <hN> with a
    # NavigableString carrying the markdown marker. Use replace_with()
    # rather than insert() so the original tag is removed and the text
    # node takes its place in the tree.
    for level in range(1, 7):
        for h_tag in soup.find_all(f"h{level}"):
            heading_text = h_tag.get_text(strip=True)
            if not heading_text:
                continue
            marker = "#" * level
            h_tag.replace_with(NavigableString(f"\n\n{marker} {heading_text}\n\n"))

    # Now flatten — paragraphs and inline text become plain text with
    # newline separators; the heading markdown markers we just inserted
    # survive verbatim.
    return soup.get_text(separator="\n", strip=True)


def _build_toc_title_map(book: Any) -> dict[str, str]:
    """Walk `book.toc` to build {href_without_anchor: chapter_title}.

    `book.toc` is a tree of (epub.Section | epub.Link, [children]) nodes.
    The TOC is the authoritative chapter list for nav-driven EPUBs and
    avoids the trap where the chunker tags a chapter from the first
    body paragraph instead of the real heading.
    """
    out: dict[str, str] = {}

    def _walk(nodes: Any) -> None:
        try:
            from ebooklib import epub as _epub
        except ImportError:
            return
        for node in nodes:
            children: Any = ()
            if isinstance(node, tuple):
                head, children = node[0], node[1] if len(node) > 1 else ()
            else:
                head = node
            href = getattr(head, "href", None)
            title = getattr(head, "title", None)
            if href and title:
                # Strip URL fragment (#anchor) so spine items match.
                key = href.split("#", 1)[0]
                out.setdefault(key, str(title).strip())
            if isinstance(head, _epub.Section) or hasattr(head, "title"):
                if children:
                    _walk(children)

    try:
        _walk(book.toc or [])
    except Exception:
        # TOC malformed — caller falls back to per-document HTML headings.
        return {}
    return out


def extract_epub_to_markdown(file_path: str) -> tuple[str | None, int | None]:
    """
    Extract text content from an EPUB file and convert to Markdown format.

    Uses ebooklib + BeautifulSoup. The traversal order is `book.spine`
    (the authoritative reading order) rather than `book.get_items()`
    (which returns ZIP-entry order, not reading order). Chapter titles
    come from `book.toc` when available, falling back to the first
    HTML heading inside the chapter body, then to "Chapter N".

    Frontmatter (cover, copyright, dedication, TOC, index, acknowledgments,
    bibliography) is filtered out to keep the chapter list focused on
    real body content, which prevents the downstream chunker from
    inflating the chapter count with non-chapters.

    Args:
        file_path: Path to the EPUB file

    Returns:
        Tuple of (markdown_text, chapter_count) or (None, None) if
        extraction fails. `chapter_count` is the number of body chapters
        emitted, NOT the number of EPUB items (frontmatter is excluded).
    """
    try:
        from bs4 import BeautifulSoup
        import ebooklib
        from ebooklib import epub

        book = epub.read_epub(file_path)
        toc_titles = _build_toc_title_map(book)
        text_parts: list[str] = []
        chapter_num = 0
        items_visited = 0
        items_skipped_frontmatter = 0
        items_skipped_empty = 0

        # Walk spine (reading order). Each spine entry is (idref, linear)
        # — `linear='yes'` is the body, 'no' is supplementary (skip).
        spine_iter: list[tuple[str, str]] = []
        for entry in book.spine or []:
            if isinstance(entry, tuple) and entry:
                idref = entry[0]
                linear = entry[1] if len(entry) > 1 else "yes"
            else:
                idref = entry
                linear = "yes"
            spine_iter.append((str(idref), str(linear)))

        for idref, linear in spine_iter:
            items_visited += 1
            if str(linear).lower() == "no":
                # Supplementary content — skip per EPUB spec.
                items_skipped_frontmatter += 1
                continue
            try:
                item = book.get_item_with_id(idref)
            except Exception:
                continue
            if item is None or item.get_type() != ebooklib.ITEM_DOCUMENT:
                continue

            file_name = getattr(item, "file_name", "") or getattr(item, "href", "") or ""
            # noinspection PyArgumentList
            soup = BeautifulSoup(item.get_content(), "html.parser")
            # Resolve title BEFORE flattening — the markdownifier replaces
            # heading tags with NavigableString nodes, after which
            # `soup.find("h1")` returns nothing.
            chapter_title_pre_resolved: str | None = None
            for tag in ("h1", "h2", "h3", "title"):
                heading = soup.find(tag)
                if heading:
                    title_text = heading.get_text(strip=True)
                    if title_text and 2 < len(title_text) < 200:
                        chapter_title_pre_resolved = title_text
                        break
            # noinspection PyArgumentList
            chapter_text = _epub_chapter_to_markdown(soup)
            if not chapter_text or len(chapter_text.strip()) < 10:
                items_skipped_empty += 1
                continue

            # Title resolution priority:
            # 1. TOC entry that points to this spine item (authoritative).
            # 2. First HTML heading h1/h2/h3 inside the body (pre-resolved
            #    BEFORE markdownify mutated the soup).
            # 3. <title> element.
            chapter_title: str | None = None
            href_key = (file_name or "").split("#", 1)[0]
            if href_key in toc_titles:
                chapter_title = toc_titles[href_key]
            else:
                chapter_title = chapter_title_pre_resolved

            if _is_frontmatter(file_name, chapter_title, len(chapter_text)):
                items_skipped_frontmatter += 1
                continue

            chapter_num += 1
            # When the spine entry has no semantic title, emit chapter_text
            # WITHOUT a synthetic `# Chapter N` wrapper — the
            # downstream enhanced_markdown chunker uses `Chapter \d+`
            # presence as a doc-wide signal (`doc_has_explicit_chapters`)
            # to disable auto-promotion of OTHER semantic H1s. Emitting
            # even a few `# Chapter N` labels for nameless spine entries
            # silently disables 50+ legitimate H1 chapter boundaries
            # downstream. The body H1/H2/H3 from `_epub_chapter_to_markdown`
            # carry the structure when present; when absent the chunker's
            # auto-promote on the first body heading still works.
            if chapter_title:
                text_parts.append(f"# {chapter_title}\n\n{chapter_text}\n")
            else:
                text_parts.append(f"{chapter_text}\n")

        # Fallback: if spine traversal produced nothing usable (malformed
        # spine, single-file EPUB), retry with the legacy
        # `book.get_items()` walk so we never regress relative to the old
        # implementation. This keeps existing disk-EPUB call sites
        # (document_qa_agent, document_extras_service) working even on
        # exotic books.
        if chapter_num == 0:
            logger.warning("EPUB spine walk produced 0 chapters for %s — falling back to ITEM_DOCUMENT order", file_path)
            for item in book.get_items():
                if item.get_type() == ebooklib.ITEM_DOCUMENT:
                    soup = BeautifulSoup(item.get_content(), "html.parser")
                    # Pre-resolve title BEFORE markdownify (same reason as
                    # the spine path: replace_with() destroys heading tags).
                    chapter_title = None
                    for tag in ("h1", "h2", "h3", "title"):
                        heading = soup.find(tag)
                        if heading:
                            title_text = heading.get_text(strip=True)
                            if title_text and 2 < len(title_text) < 200:
                                chapter_title = title_text
                                break
                    chapter_text = _epub_chapter_to_markdown(soup)
                    if not chapter_text or len(chapter_text.strip()) < 10:
                        continue
                    chapter_num += 1
                    # Same rationale as spine path: avoid synthetic
                    # `# Chapter N` labels that flip the downstream
                    # `doc_has_explicit_chapters` switch.
                    if chapter_title:
                        text_parts.append(f"# {chapter_title}\n\n{chapter_text}\n")
                    else:
                        text_parts.append(f"{chapter_text}\n")

        full_text = "\n".join(text_parts)

        if not full_text or not full_text.strip():
            logger.warning("EPUB extraction returned empty text for %s", file_path)
            return None, None

        logger.info(
            "Extracted EPUB to markdown: %d body chapters (skipped %d frontmatter, %d empty), %d chars from %d spine items",
            chapter_num,
            items_skipped_frontmatter,
            items_skipped_empty,
            len(full_text),
            items_visited,
        )

        return full_text, chapter_num

    except ImportError:
        logger.error("ebooklib or beautifulsoup4 not installed - cannot extract EPUB content")
        return None, None
    except Exception as e:
        logger.exception("Error extracting EPUB: %s", str(e))
        return None, None


def extract_text_file_content(file_path: str) -> str | None:
    """
    Extract content from plain text or Markdown files.

    Tries UTF-8 encoding first, then falls back to latin-1.

    Args:
        file_path: Path to the text file

    Returns:
        File content as string, or None if extraction fails
    """
    try:
        with open(file_path, encoding="utf-8") as f:
            text = f.read()

        if text and text.strip():
            logger.info("Extracted text file: %d chars", len(text))
            return text

        logger.warning("Text file is empty: %s", file_path)
        return None

    except UnicodeDecodeError:
        # Try with different encoding
        try:
            with open(file_path, encoding="latin-1") as f:
                text = f.read()

            if text and text.strip():
                logger.info("Extracted text file (latin-1 encoding): %d chars", len(text))
                return text

            return None

        except Exception as e:
            logger.error("Error reading text file with latin-1: %s", str(e))
            return None
    except Exception as e:
        logger.error("Error extracting text file: %s", str(e))
        return None


def extract_document_content(
    file_path: str,
    show_progress: bool = False,
    page_chunks: bool = True,
) -> tuple[str | None, int | None]:
    """
    Extract content from a document based on file type.

    Automatically detects file type and uses appropriate extraction method:
    - PDF: pymupdf4llm for markdown conversion
    - EPUB: ebooklib + BeautifulSoup
    - TXT/MD: Direct text reading

    Args:
        file_path: Path to the document file
        show_progress: If True, show progress during PDF extraction. Default: False
        page_chunks: If True, split PDF by pages. Default: True

    Returns:
        Tuple of (content_text, page_or_chapter_count) or (None, None) if extraction fails
    """
    if not file_path or not os.path.exists(file_path):
        logger.error("File not found: %s", file_path)
        return None, None

    file_ext = os.path.splitext(file_path)[1].lower()

    if file_ext == ".pdf":
        return extract_pdf_to_markdown(file_path, page_chunks=page_chunks, show_progress=show_progress)
    elif file_ext == ".epub":
        return extract_epub_to_markdown(file_path)
    elif file_ext in {".txt", ".md", ".markdown"}:
        content = extract_text_file_content(file_path)
        return content, None
    else:
        logger.warning("Unsupported file type for content extraction: %s", file_ext)
        return None, None


def is_small_document(
    file_path: str = None,
    max_pages: int = 20,
    page_count: int | None = None,
) -> bool:
    """
    Check if a document is small enough to load entirely into LLM context.

    Args:
        file_path: Path to the document file (used for file size heuristic if page_count not provided)
        max_pages: Maximum pages to consider "small". Default: 20
        page_count: Actual page count if known (from extract_pdf_to_markdown with page_chunks=True)

    Returns:
        True if document has <= max_pages, False otherwise

    Usage:
        # With known page count (preferred)
        content, pages = extract_pdf_to_markdown(path, page_chunks=True)
        if is_small_document(page_count=pages):
            # Use full context

        # With file path only (uses file size heuristic)
        if is_small_document(file_path=path):
            # Use full context
    """
    # If page_count is provided, use it directly
    if page_count is not None:
        return page_count <= max_pages

    # Fallback to file size heuristic
    if not file_path or not os.path.exists(file_path):
        return False

    try:
        file_size = os.path.getsize(file_path)
        file_ext = os.path.splitext(file_path)[1].lower()

        if file_ext == ".pdf":
            # Heuristic: ~50KB per page for typical PDFs
            max_size = max_pages * 50 * 1024
            return file_size <= max_size
        elif file_ext == ".epub":
            # EPUBs are compressed, ~30KB per chapter typically
            max_size = max_pages * 30 * 1024
            return file_size <= max_size
        else:
            # Text files: ~5KB per "page" (roughly 2500 chars)
            max_size = max_pages * 5 * 1024
            return file_size <= max_size

    except Exception as e:
        logger.warning("Could not determine file size for %s: %s", file_path, str(e))
        return False


def build_enriched_filename(authors: list | None, year: int | None, title: str | None, original_ext: str) -> str | None:
    """Build enriched filename from resolved metadata: '(Year) Author - Title.ext'.

    Returns None if metadata is insufficient (no title).
    """
    if not title or title.strip().lower() in ("untitled", ""):
        return None

    # Extract last name of first author
    author_part = ""
    if authors and len(authors) > 0:
        first_author = authors[0].strip()
        # Handle "Last, First" or "First Last" format
        if "," in first_author:
            author_part = first_author.split(",")[0].strip()
        else:
            parts = first_author.split()
            author_part = parts[-1] if parts else ""

    year_part = f"({year})" if year else ""

    # Truncate title to 80 chars
    clean_title = title.strip()[:80].rstrip(".")

    # Build: (Year) Author - Title.ext
    prefix_parts = [p for p in [year_part, author_part] if p]
    prefix = " ".join(prefix_parts)

    if prefix:
        base_name = f"{prefix} - {clean_title}"
    else:
        base_name = clean_title

    # Sanitize for filesystem
    import re

    base_name = re.sub(r'[/\\:*?"<>|]', "", base_name)
    base_name = normalize_whitespace(base_name)

    if not base_name:
        return None

    ext = original_ext.lstrip(".")
    return f"{base_name}.{ext}"


# ──────────────────────────────────────────────────────────────────────
# Heavy-document classification
# ──────────────────────────────────────────────────────────────────────

# Any file larger than this is deferred for user confirmation. Value
# picked because our scrapalot-workers container is capped at 6 GB and
# Docling OCR on a ~20 MB scanned PDF already sits around 3 GB resident.
HEAVY_DOC_SIZE_BYTES: int = 20 * 1024 * 1024  # 20 MB

# When the PDF-text-layer scan averages fewer characters per page than
# this across the first few pages, we assume the PDF is scanned/image
# and will need Docling OCR — a multi-hour, multi-GB job. 500 chars ≈
# four short paragraphs; well below any real prose page.
HEAVY_DOC_MIN_CHARS_PER_PAGE: int = 500

# Sample size for the text-layer probe. Reading the whole PDF at upload
# time would block the gRPC handler for seconds; five pages is a fast
# approximation.
HEAVY_DOC_SAMPLE_PAGES: int = 5

# Above this page count a single document monopolises a worker for tens
# of minutes — we observed encyclopaedia-class PDFs (1500+ pages) blow
# past the 30 min soft_time_limit on every retry. Defer them so the user
# can decide whether to process anyway (or split the file first).
HEAVY_DOC_MAX_PAGES: int = 1000


def classify_upload_heaviness(file_path: str, file_size: int) -> tuple[bool, str]:
    """
    Decide whether an uploaded file should be processed immediately or
    deferred for explicit user confirmation.

    The goal is to protect the worker pool from OCR-heavy jobs that can
    monopolise both Celery slots for tens of minutes each. Light docs
    (text-layer PDFs, EPUBs, short PDFs) go through the normal pipeline
    at upload time; heavy docs are parked in `processing_status='deferred'`
    until the user clicks "Process anyway" in the UI.

    Returns a tuple of (is_heavy, reason_code). The reason code is a
    short machine-readable string the UI / API consumers can key on; it
    is NOT an English sentence for the user.

    Detection:
      * `file_size_over_20mb` — anything above `HEAVY_DOC_SIZE_BYTES`.
      * `pdf_over_1000_pages` — PDF whose total page count exceeds
        `HEAVY_DOC_MAX_PAGES`. Encyclopaedia-class docs blow past the
        30 min soft_time_limit on every retry; defer for explicit
        user action.
      * `scanned_pdf_no_text_layer` — PDF whose first
        `HEAVY_DOC_SAMPLE_PAGES` pages average fewer than
        `HEAVY_DOC_MIN_CHARS_PER_PAGE` characters. These will need
        OCR, not just text extraction.
      * `light` — everything else. Non-PDFs (epub, txt, docx) are
        classified light at this layer; their own parsers are cheap
        enough that they don't need a confirmation step.
    """
    if file_size > HEAVY_DOC_SIZE_BYTES:
        return True, "file_size_over_20mb"

    if not file_path.lower().endswith(".pdf"):
        return False, "light"

    # Text-layer probe + page-count guard. Worst-case path: pymupdf fails
    # to open → treat as light rather than blocking the upload. The normal
    # pipeline downstream has its own error handling and will mark the doc
    # as failed if the file is really unreadable.
    try:
        import pymupdf

        doc = pymupdf.open(file_path)
        try:
            total_pages = len(doc)
            if total_pages > HEAVY_DOC_MAX_PAGES:
                return True, "pdf_over_1000_pages"
            n_pages = min(HEAVY_DOC_SAMPLE_PAGES, total_pages)
            if n_pages == 0:
                return False, "light"
            total_chars = 0
            for i in range(n_pages):
                try:
                    total_chars += len(doc[i].get_text("text").strip())
                except Exception:
                    continue
            avg_chars = total_chars / n_pages
            if avg_chars < HEAVY_DOC_MIN_CHARS_PER_PAGE:
                return True, "scanned_pdf_no_text_layer"
        finally:
            doc.close()
    except Exception:
        return False, "light"

    return False, "light"
