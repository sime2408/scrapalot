"""Extract existing annotations from PDF files.

Uses PyMuPDF (fitz) to read highlight, underline, strikeout, and text annotations
embedded in uploaded PDFs. Converts them to Scrapalot annotation format for import.
"""

from dataclasses import dataclass, field

import fitz

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# PyMuPDF annotation type codes
_HIGHLIGHT = 8
_UNDERLINE = 9
_SQUIGGLY = 10
_STRIKEOUT = 11
_TEXT_NOTE = 0  # Sticky note / pop-up

# Map PyMuPDF types to Scrapalot annotation types
# Scrapalot: 0=highlight, 1=underline, 2=strikeout, 3=note
_TYPE_MAP = {
    _HIGHLIGHT: 0,
    _UNDERLINE: 1,
    _STRIKEOUT: 2,
    _SQUIGGLY: 1,  # Treat squiggly as underline
    _TEXT_NOTE: 3,
}


@dataclass
class ExtractedAnnotation:
    """An annotation extracted from a PDF file."""

    page_index: int
    annotation_type: int  # Scrapalot type: 0=highlight, 1=underline, 2=strikeout, 3=note
    selected_text: str = ""
    comment: str = ""
    color_index: int = 0  # Default yellow
    position_json: str = ""
    is_external: bool = True


@dataclass
class ExtractionResult:
    """Result of PDF annotation extraction."""

    annotations: list[ExtractedAnnotation] = field(default_factory=list)
    page_count: int = 0
    error: str | None = None


def _color_to_index(color: tuple | None) -> int:
    """Map RGB color tuple to nearest Scrapalot color index (0-7)."""
    if not color:
        return 0  # Yellow default

    r, g, b = (int(c * 255) for c in color[:3])

    # Scrapalot colors: 0=yellow, 1=green, 2=blue, 3=pink, 4=purple, 5=red, 6=orange, 7=gray
    colors = [
        (255, 235, 59),  # 0: yellow
        (76, 175, 80),  # 1: green
        (33, 150, 243),  # 2: blue
        (233, 30, 99),  # 3: pink
        (156, 39, 176),  # 4: purple
        (244, 67, 54),  # 5: red
        (255, 152, 0),  # 6: orange
        (158, 158, 158),  # 7: gray
    ]

    min_dist = float("inf")
    best = 0
    for i, (cr, cg, cb) in enumerate(colors):
        dist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2
        if dist < min_dist:
            min_dist = dist
            best = i
    return best


def _rect_to_position_json(page: fitz.Page, rect: fitz.Rect, page_index: int) -> str:
    """Convert a PDF rect to percentage-based position JSON."""
    import json

    pw, ph = page.rect.width, page.rect.height
    if pw == 0 or ph == 0:
        return ""
    position = {
        "type": "highlight",
        "pageIndex": page_index,
        "rects": [
            {
                "left": round(rect.x0 / pw * 100, 2),
                "top": round(rect.y0 / ph * 100, 2),
                "width": round((rect.x1 - rect.x0) / pw * 100, 2),
                "height": round((rect.y1 - rect.y0) / ph * 100, 2),
            }
        ],
    }
    return json.dumps(position)


def extract_pdf_annotations(file_path: str) -> ExtractionResult:
    """Extract all annotations from a PDF file."""
    try:
        doc = fitz.open(file_path)
    except Exception as e:
        logger.warning("Cannot open PDF for annotation extraction: %s", str(e))
        return ExtractionResult(error=str(e))

    result = ExtractionResult(page_count=len(doc))
    try:
        for page_idx in range(len(doc)):
            page = doc[page_idx]
            for annot in page.annots() or []:
                annot_type = annot.type[0]
                if annot_type not in _TYPE_MAP:
                    continue

                scrapalot_type = _TYPE_MAP[annot_type]

                # Extract highlighted text
                selected_text = ""
                if annot_type in (_HIGHLIGHT, _UNDERLINE, _SQUIGGLY, _STRIKEOUT):
                    # noinspection PyBroadException
                    try:
                        # Get text within the annotation's quad points
                        quads = annot.vertices
                        if quads:
                            rect = fitz.Rect(quads[0], quads[1]) if len(quads) >= 2 else annot.rect
                            selected_text = page.get_textbox(rect).strip()
                        else:
                            selected_text = page.get_textbox(annot.rect).strip()
                    except Exception:
                        selected_text = ""

                comment = annot.info.get("content", "") or ""
                color = annot.colors.get("stroke") or annot.colors.get("fill")

                position_json = _rect_to_position_json(page, annot.rect, page_idx)

                if selected_text or comment:
                    result.annotations.append(
                        ExtractedAnnotation(
                            page_index=page_idx,
                            annotation_type=scrapalot_type,
                            selected_text=selected_text,
                            comment=comment,
                            color_index=_color_to_index(color),
                            position_json=position_json,
                            is_external=True,
                        )
                    )
    except Exception as e:
        logger.warning("Error extracting annotations from PDF: %s", str(e))
        result.error = str(e)
    finally:
        doc.close()

    if result.annotations:
        logger.info("Extracted %d annotations from PDF (%d pages)", len(result.annotations), result.page_count)

    return result
