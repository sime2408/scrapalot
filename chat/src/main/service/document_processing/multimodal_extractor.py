"""
Multimodal element extraction from a Docling document.

Walks the in-memory `DoclingDocument` produced during PDF parsing and
returns one draft per non-text element (image, table, equation). Drafts
are agnostic about the destination database row and document_id — that
wiring lives in the worker task that calls this extractor.

The extractor never touches Neo4j or pgvector. It produces in-memory
data only; bytes are encoded as raw PNG (Docling's natural raster
format) and re-encoded to WebP at the persistence boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import io
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_INLINE_PROCESSED_LABELS = {"picture", "table", "formula"}

# Match a `$...$` span on a single line, 2-200 chars between. The opening
# `$` must follow start-of-string, whitespace, or an opening bracket; the
# closing `$` must precede whitespace, end-of-string, or sentence
# punctuation. This rejects the `$5 but the formula $E = mc^2$ is famous`
# trap where every odd `$` would otherwise become an opener. Excludes the
# `$$...$$` block form (handled by Docling's formula label) and embedded
# newlines.
_INLINE_LATEX_RE = re.compile(r"(?:^|(?<=[\s(\[{]))\$(?!\$)([^$\n]{1,200}?)(?<!\$)\$(?!\$)(?=$|[\s.,;:!?)\]}])")
# Currency-like tokens — treat them as cash, not LaTeX. Allows optional
# thousands separators and decimals, optional unit suffix (k, M, bn, USD).
_CURRENCY_RE = re.compile(r"^\s*\d[\d,.\s]*(?:\s*(?:k|m|bn|usd|eur))?\s*$", re.IGNORECASE)


def _find_inline_latex(text: str, *, skip_currency: bool) -> list[str]:
    """Return inline-LaTeX spans from a text item, currency tokens removed."""
    out: list[str] = []
    for match in _INLINE_LATEX_RE.finditer(text):
        body = match.group(1).strip()
        if not body:
            continue
        if skip_currency and _CURRENCY_RE.match(body):
            continue
        out.append(body)
    return out


@dataclass
class MultimodalElementDraft:
    """In-memory representation of one extracted multimodal element.

    The persistence layer attaches a `document_id`, re-encodes images,
    writes the file under `data/multimodal/images/{document_id}/`, and
    inserts one `multimodal_elements` row.
    """

    element_type: str
    element_index: int
    page_idx: int | None = None
    bbox: dict[str, float] | None = None

    image_bytes: bytes | None = None
    image_format: str | None = None

    table_markdown: str | None = None
    table_structured: dict[str, Any] | None = None

    equation_latex: str | None = None

    caption: str | None = None
    footnotes: list[str] = field(default_factory=list)


def extract_multimodal_elements(
    docling_document: Any,
    *,
    enable_images: bool = True,
    enable_tables: bool = True,
    enable_equations: bool = True,
    detect_inline_latex: bool = True,
    skip_dollar_currency: bool = True,
    max_elements: int = 100,
) -> list[MultimodalElementDraft]:
    """Walk a DoclingDocument and produce drafts for non-text elements.

    Soft-fails on any per-item error (logs warning, skips item) — never
    propagates an exception that would kill the whole PDF ingest.
    """

    drafts: list[MultimodalElementDraft] = []
    image_idx = 0
    table_idx = 0
    equation_idx = 0

    if enable_images:
        for picture in getattr(docling_document, "pictures", []) or []:
            if len(drafts) >= max_elements:
                break
            try:
                draft = _picture_to_draft(picture, image_idx)
            except Exception as ex:
                logger.warning("Failed to extract picture #%d: %s", image_idx, ex)
                image_idx += 1
                continue
            if draft is not None:
                drafts.append(draft)
            image_idx += 1

    if enable_tables:
        for table in getattr(docling_document, "tables", []) or []:
            if len(drafts) >= max_elements:
                break
            try:
                draft = _table_to_draft(table, table_idx, docling_document)
            except Exception as ex:
                logger.warning("Failed to extract table #%d: %s", table_idx, ex)
                table_idx += 1
                continue
            if draft is not None:
                drafts.append(draft)
            table_idx += 1

    if enable_equations:
        for text_item in getattr(docling_document, "texts", []) or []:
            if len(drafts) >= max_elements:
                break
            label = getattr(text_item, "label", None)
            if str(label) != "formula" and getattr(label, "value", None) != "formula":
                continue
            try:
                draft = _formula_to_draft(text_item, equation_idx)
            except Exception as ex:
                logger.warning("Failed to extract formula #%d: %s", equation_idx, ex)
                equation_idx += 1
                continue
            if draft is not None:
                drafts.append(draft)
            equation_idx += 1

        # Inline LaTeX scan over non-formula text items. Picks up `$...$`
        # spans Docling did not classify as standalone formulas (footnotes,
        # body paragraphs that mix prose and inline math). Currency-like
        # tokens are skipped.
        if detect_inline_latex:
            for text_item in getattr(docling_document, "texts", []) or []:
                if len(drafts) >= max_elements:
                    break
                label = getattr(text_item, "label", None)
                if str(label) == "formula" or getattr(label, "value", None) == "formula":
                    continue  # already handled above
                text = (getattr(text_item, "text", "") or "").strip()
                if not text or "$" not in text:
                    continue
                page_idx, bbox = _first_provenance(text_item)
                for inline_latex in _find_inline_latex(text, skip_currency=skip_dollar_currency):
                    if len(drafts) >= max_elements:
                        break
                    drafts.append(
                        MultimodalElementDraft(
                            element_type="equation",
                            element_index=equation_idx,
                            page_idx=page_idx,
                            bbox=bbox,
                            equation_latex=inline_latex,
                        )
                    )
                    equation_idx += 1

    logger.info(
        "Extracted multimodal drafts: images=%d tables=%d equations=%d total=%d",
        image_idx,
        table_idx,
        equation_idx,
        len(drafts),
    )
    return drafts


def _picture_to_draft(picture: Any, idx: int) -> MultimodalElementDraft | None:
    page_idx, bbox = _first_provenance(picture)
    image_bytes = _picture_to_png_bytes(picture)
    if image_bytes is None:
        return None
    return MultimodalElementDraft(
        element_type="image",
        element_index=idx,
        page_idx=page_idx,
        bbox=bbox,
        image_bytes=image_bytes,
        image_format="png",
        caption=_join_captions(picture),
        footnotes=_collect_footnotes(picture),
    )


def _table_to_draft(table: Any, idx: int, docling_document: Any) -> MultimodalElementDraft | None:
    page_idx, bbox = _first_provenance(table)
    markdown = _table_to_markdown(table, docling_document)
    structured = _table_to_structured(table)
    if not markdown and not structured:
        return None
    return MultimodalElementDraft(
        element_type="table",
        element_index=idx,
        page_idx=page_idx,
        bbox=bbox,
        table_markdown=markdown,
        table_structured=structured,
        caption=_join_captions(table),
        footnotes=_collect_footnotes(table),
    )


def _formula_to_draft(text_item: Any, idx: int) -> MultimodalElementDraft | None:
    latex = (getattr(text_item, "text", "") or "").strip()
    if not latex:
        return None
    page_idx, bbox = _first_provenance(text_item)
    return MultimodalElementDraft(
        element_type="equation",
        element_index=idx,
        page_idx=page_idx,
        bbox=bbox,
        equation_latex=latex,
    )


def _first_provenance(item: Any) -> tuple[int | None, dict[str, float] | None]:
    provs = getattr(item, "prov", None) or []
    if not provs:
        return None, None
    prov = provs[0]
    page_no = getattr(prov, "page_no", None)
    bbox_obj = getattr(prov, "bbox", None)
    if bbox_obj is None:
        return page_no, None
    bbox = {
        "x0": float(getattr(bbox_obj, "l", 0.0)),
        "y0": float(getattr(bbox_obj, "t", 0.0)),
        "x1": float(getattr(bbox_obj, "r", 0.0)),
        "y1": float(getattr(bbox_obj, "b", 0.0)),
        "coord_origin": str(getattr(bbox_obj, "coord_origin", "")) or None,
    }
    return page_no, bbox


def _picture_to_png_bytes(picture: Any) -> bytes | None:
    image_ref = getattr(picture, "image", None)
    if image_ref is None:
        return None
    pil_image = None
    if hasattr(image_ref, "pil_image") and getattr(image_ref, "pil_image", None) is not None:
        pil_image = image_ref.pil_image
    elif hasattr(image_ref, "uri"):
        pil_image = _load_pil_from_uri(getattr(image_ref, "uri", None))
    if pil_image is None:
        return None
    buf = io.BytesIO()
    pil_image.save(buf, format="PNG")
    return buf.getvalue()


def _load_pil_from_uri(uri: Any) -> Any:
    if uri is None:
        return None
    s = str(uri)
    if s.startswith("data:image"):
        try:
            import base64

            from PIL import Image

            _header, _, b64data = s.partition(",")
            return Image.open(io.BytesIO(base64.b64decode(b64data)))
        except Exception:
            return None
    return None


def _join_captions(item: Any) -> str | None:
    caps = getattr(item, "captions", None) or []
    parts: list[str] = []
    for cap in caps:
        if hasattr(cap, "cref"):
            continue  # RefItem — caller would need to dereference; skip.
        text = getattr(cap, "text", None)
        if text:
            parts.append(text.strip())
    if not parts:
        return None
    return " ".join(parts)


def _collect_footnotes(item: Any) -> list[str]:
    notes = getattr(item, "footnotes", None) or []
    out: list[str] = []
    for note in notes:
        if hasattr(note, "cref"):
            continue
        text = getattr(note, "text", None)
        if text:
            out.append(text.strip())
    return out


def _table_to_markdown(table: Any, docling_document: Any) -> str | None:
    if hasattr(table, "export_to_markdown"):
        try:
            return table.export_to_markdown(docling_document)
        except TypeError:
            try:
                return table.export_to_markdown()
            except Exception:
                return None
        except Exception:
            return None
    return None


def _table_to_structured(table: Any) -> dict[str, Any] | None:
    data = getattr(table, "data", None)
    if data is None:
        return None
    grid = getattr(data, "grid", None)
    if grid is None:
        # Fallback: use num_rows / num_cols if present
        rows = getattr(data, "num_rows", None)
        cols = getattr(data, "num_cols", None)
        if rows is None and cols is None:
            return None
        return {"row_count": rows, "col_count": cols, "headers": [], "rows": []}

    headers: list[str] = []
    body_rows: list[list[str]] = []
    for r_idx, row in enumerate(grid):
        cells: list[str] = []
        for cell in row:
            text = getattr(cell, "text", "") or ""
            cells.append(text.strip())
        if r_idx == 0:
            headers = cells
        else:
            body_rows.append(cells)
    return {
        "headers": headers,
        "rows": body_rows,
        "col_count": len(headers) if headers else (len(body_rows[0]) if body_rows else 0),
        "row_count": len(body_rows),
    }
