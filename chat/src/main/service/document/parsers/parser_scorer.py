"""
Deterministic, book-first quality scoring for parser outputs.

No LLM, no human judgement — pure heuristics so the winner is reproducible and
auditable. Weighted toward what matters for a book corpus (structure +
completeness), with table/layout artefacts folded into a small cleanliness term.

Scoring is RELATIVE within a single document's comparison: each metric is
normalised against the peer parsers run on the same PDF, then combined. The
``expected_chapters`` ground truth comes from the parser-INDEPENDENT
``PDFChapterDetector`` (it reads the raw PDF), so it doesn't favour either
backend.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import re

from src.main.service.document.parsers.pdf_parser_base import ParsedDocument

# Book-first weights. Tables intentionally carry little weight (folded into
# cleanliness via the <br>-collapse penalty) — the priority is faithful books.
_W_STRUCTURE = 0.5
_W_COMPLETENESS = 0.3
_W_CLEANLINESS = 0.2

_HEADER_RE = re.compile(r"(?m)^#{1,6}\s+\S")
_CHAPTER_RE = re.compile(r"(?im)^\s*(?:chapter\b|part\b|[ivxlcdm]+\.\s|\d+\.\s+[A-Z])")
_BR_RE = re.compile(r"<br\s*/?>", re.IGNORECASE)
_CODEFENCE_RE = re.compile(r"```")
_WS_RUN_RE = re.compile(r"[ \t]{4,}")


@dataclass
class ParserMetrics:
    """Raw, deterministic measurements of one parser's output."""

    page_count: int
    char_count: int
    nonws_char_count: int
    header_count: int
    chapter_marker_count: int
    br_count: int
    codefence_count: int
    ws_run_count: int
    parse_ms: float
    error: str | None = None


def _reconstructed_text(parsed: ParsedDocument) -> str:
    """Apply the shared pipeline header-reconstruction pass to each page so the
    structure metric reflects EFFECTIVE structure (what the chunker actually
    sees), not the parser's raw header output. Both backends go through this same
    pass in production, so it's a fair levelling — it mainly lifts a backend like
    LiteParse that emits chapter titles as plain text rather than ``#`` headers.
    """
    try:
        from src.main.service.document.document_processor_pdf import PDFProcessor

        return "\n\n".join(PDFProcessor._enhance_markdown_with_headers(p.text) for p in parsed.pages)
    except Exception:
        return parsed.full_text


def extract_metrics(parsed: ParsedDocument) -> ParserMetrics:
    text = parsed.full_text
    reconstructed = _reconstructed_text(parsed)
    nonws = len(re.sub(r"\s+", "", text))
    return ParserMetrics(
        page_count=parsed.page_count,
        char_count=len(text),
        nonws_char_count=nonws,
        # Structure on the RECONSTRUCTED text (effective, post-pipeline); cleanliness
        # on the RAW text (what the parser natively produced).
        header_count=len(_HEADER_RE.findall(reconstructed)),
        chapter_marker_count=len(_CHAPTER_RE.findall(reconstructed)),
        br_count=len(_BR_RE.findall(text)),
        codefence_count=len(_CODEFENCE_RE.findall(text)),
        ws_run_count=len(_WS_RUN_RE.findall(text)),
        parse_ms=parsed.parse_ms,
        error=parsed.error,
    )


def _structure_raw(m: ParserMetrics) -> float:
    """Raw structural richness (effective headers + half-weighted chapter markers)."""
    return m.header_count + 0.5 * m.chapter_marker_count


def _structure_coverage(m: ParserMetrics, expected_chapters: int) -> float:
    """Absolute structure score in [0,1]: how well the parser's effective headers
    COVER the independently-detected chapter count — not how many it emits. Full
    credit once the chapters are covered (h >= e); extreme over-segmentation (a
    header every few lines, h >> e) is mildly penalised. This stops a backend that
    simply emits the most headers from auto-winning the structure dimension."""
    h = _structure_raw(m)
    coverage = min(h, expected_chapters) / expected_chapters
    if h > 4 * expected_chapters:
        over = min(0.5, (h - 4 * expected_chapters) / (4 * expected_chapters))
        coverage *= 1 - over
    return round(coverage, 4)


def _cleanliness_penalty(m: ParserMetrics) -> float:
    """Higher = dirtier. <br>-collapsed tables dominate; whitespace bloat + stray
    code fences contribute a little."""
    return m.br_count + 0.001 * m.char_count * (m.ws_run_count / max(m.char_count, 1)) + 0.2 * m.codefence_count


@dataclass
class ParserScore:
    parser_name: str
    total: float
    structure: float
    completeness: float
    cleanliness: float
    metrics: dict


def score_from_metrics(
    metrics: dict[str, ParserMetrics],
    expected_chapters: int,
) -> list[ParserScore]:
    """Score parsers from already-extracted metrics. Structure is graded by
    coverage of the chapter ground truth when available (absolute), else by
    relative header richness; completeness and cleanliness are relative to peers.
    Failed parses get 0. Reusable for re-scoring stored rows without re-parsing."""
    ok = {name: m for name, m in metrics.items() if m.error is None and m.char_count > 0}
    if not ok:
        return [ParserScore(n, 0.0, 0.0, 0.0, 0.0, asdict(m)) for n, m in metrics.items()]

    use_absolute = expected_chapters > 0
    max_struct_raw = max((_structure_raw(m) for m in ok.values()), default=0.0) or 1.0
    max_nonws = max((m.nonws_char_count for m in ok.values()), default=0) or 1
    max_penalty = max((_cleanliness_penalty(m) for m in ok.values()), default=0.0)

    scores: list[ParserScore] = []
    for name, m in metrics.items():
        if name not in ok:
            scores.append(ParserScore(name, 0.0, 0.0, 0.0, 0.0, asdict(m)))
            continue
        structure = _structure_coverage(m, expected_chapters) if use_absolute else (_structure_raw(m) / max_struct_raw)
        completeness = m.nonws_char_count / max_nonws
        cleanliness = 1.0 - (_cleanliness_penalty(m) / max_penalty if max_penalty > 0 else 0.0)
        total = _W_STRUCTURE * structure + _W_COMPLETENESS * completeness + _W_CLEANLINESS * cleanliness
        scores.append(
            ParserScore(
                parser_name=name,
                total=round(total, 4),
                structure=round(structure, 4),
                completeness=round(completeness, 4),
                cleanliness=round(cleanliness, 4),
                metrics=asdict(m),
            )
        )
    return scores


def score_all(
    parsed_by_name: dict[str, ParsedDocument],
    expected_chapters: int,
) -> list[ParserScore]:
    """Score every parser's output. Convenience wrapper over score_from_metrics."""
    metrics = {name: extract_metrics(doc) for name, doc in parsed_by_name.items()}
    return score_from_metrics(metrics, expected_chapters)
