"""
Persists `MultimodalElementDraft` instances into the `multimodal_elements`
table, re-encoding image bytes to WebP and writing them to a per-document
directory under the configured `multimodal.images_path`.

The describe / Neo4j-wiring phases live in `multimodal_pipeline.py`.
"""

from __future__ import annotations

import io
import logging
import os
from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import text as sa_text

from src.main.utils.config.loader import resolved_config

if TYPE_CHECKING:
    from sqlalchemy.orm import Session

    from src.main.service.document_processing.multimodal_extractor import (
        MultimodalElementDraft,
    )

logger = logging.getLogger(__name__)


def _multimodal_config() -> dict:
    return (resolved_config or {}).get("multimodal", {}) or {}


def _images_root() -> str:
    return _multimodal_config().get("images_path", "data/multimodal/images")


def _image_quality() -> int:
    return int(_multimodal_config().get("image_quality", 85))


def _image_format() -> str:
    return str(_multimodal_config().get("image_format", "webp")).lower()


def persist_drafts(
    db: Session,
    document_id: str | UUID,
    drafts: list[MultimodalElementDraft],
) -> list[UUID]:
    """Insert one row per draft. Image bytes are re-encoded to WebP and
    written to disk; row gets the relative path. Returns inserted ids."""

    if not drafts:
        return []

    doc_id_str = str(document_id)
    image_dir = os.path.join(_images_root(), doc_id_str)
    image_format = _image_format()
    inserted_ids: list[UUID] = []

    for draft in drafts:
        try:
            storage_path = None
            if draft.element_type == "image" and draft.image_bytes is not None:
                os.makedirs(image_dir, exist_ok=True)
                filename = f"p{draft.page_idx or 0}_i{draft.element_index}.{image_format}"
                storage_path = os.path.join(image_dir, filename)
                _reencode_image(draft.image_bytes, storage_path, image_format)

            content_text = None
            structured = None
            if draft.element_type == "table":
                content_text = draft.table_markdown
                structured = draft.table_structured
            elif draft.element_type == "equation":
                content_text = draft.equation_latex

            row_id = db.execute(
                sa_text(
                    """
                    INSERT INTO multimodal_elements (
                        document_id, element_type, element_index, page_idx,
                        bbox_json, storage_path, content_text,
                        caption, footnotes, structured_data,
                        processing_status
                    ) VALUES (
                        :document_id, :element_type, :element_index, :page_idx,
                        CAST(:bbox_json AS JSONB), :storage_path, :content_text,
                        :caption, CAST(:footnotes AS JSONB), CAST(:structured AS JSONB),
                        'pending'
                    )
                    ON CONFLICT (document_id, element_type, element_index)
                    DO UPDATE SET
                        page_idx = EXCLUDED.page_idx,
                        bbox_json = EXCLUDED.bbox_json,
                        storage_path = EXCLUDED.storage_path,
                        content_text = EXCLUDED.content_text,
                        caption = EXCLUDED.caption,
                        footnotes = EXCLUDED.footnotes,
                        structured_data = EXCLUDED.structured_data,
                        processing_status = 'pending',
                        updated_at = NOW()
                    RETURNING id
                    """
                ),
                {
                    "document_id": doc_id_str,
                    "element_type": draft.element_type,
                    "element_index": draft.element_index,
                    "page_idx": draft.page_idx,
                    "bbox_json": _json_or_none(draft.bbox),
                    "storage_path": storage_path,
                    "content_text": content_text,
                    "caption": draft.caption,
                    "footnotes": _json_or_none(draft.footnotes if draft.footnotes else None),
                    "structured": _json_or_none(structured),
                },
            ).scalar()
            if row_id is not None:
                inserted_ids.append(row_id)
        except Exception as ex:
            logger.warning(
                "Failed to persist multimodal draft (type=%s idx=%d): %s",
                draft.element_type,
                draft.element_index,
                ex,
            )

    db.commit()
    logger.info(
        "Persisted %d multimodal element rows for document %s",
        len(inserted_ids),
        doc_id_str,
    )
    return inserted_ids


def _reencode_image(image_bytes: bytes, dest_path: str, image_format: str) -> None:
    from PIL import Image

    img = Image.open(io.BytesIO(image_bytes))
    if img.mode in ("RGBA", "LA"):
        img = img.convert("RGB")
    save_kwargs: dict = {}
    if image_format == "webp":
        save_kwargs["quality"] = _image_quality()
        save_kwargs["method"] = 6
    elif image_format in ("jpg", "jpeg"):
        save_kwargs["quality"] = _image_quality()
        save_kwargs["optimize"] = True
    img.save(dest_path, format=image_format.upper().replace("JPG", "JPEG"), **save_kwargs)


def _json_or_none(value):
    if value is None:
        return None
    import json

    return json.dumps(value, default=str)
