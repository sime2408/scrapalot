"""Extract academic identifiers (DOI, ISBN, PMID, arXiv) from document text.

Regex patterns derived from Zotero's recognizeDocument.js (line 719).
Focuses on the first 2 pages where identifiers typically appear.
"""

from dataclasses import dataclass, field
import re

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# DOI regex from Zotero's recognizeDocument.js line 719
DOI_REGEX = re.compile(r'\b10\.[0-9]{4,}/[^\s&"\']*[^\s&"\'.,]')

# ISBN-13 (978/979 prefix) and ISBN-10 patterns
ISBN_13_REGEX = re.compile(r"\b(97[89][-\s]?\d[-\s]?\d{2,7}[-\s]?\d{1,7}[-\s]?\d)\b")
ISBN_10_REGEX = re.compile(r"\b(\d[-\s]?\d{2,7}[-\s]?\d{1,7}[-\s]?[\dXx])\b")

# PubMed ID
PMID_REGEX = re.compile(r"\bPMID[:\s]*(\d{6,9})\b", re.IGNORECASE)

# arXiv ID — new format (YYMM.NNNNN) and old format (category/YYMMNNN)
ARXIV_REGEX = re.compile(r"(?:arXiv[:\s]*)?(\d{4}\.\d{4,5}(?:v\d+)?)\b", re.IGNORECASE)
ARXIV_OLD_REGEX = re.compile(r"arXiv[:\s]*([a-z-]+/\d{7}(?:v\d+)?)\b", re.IGNORECASE)


@dataclass
class ExtractedIdentifiers:
    """Identifiers found in document text."""

    dois: list[str] = field(default_factory=list)
    isbns: list[str] = field(default_factory=list)
    pmids: list[str] = field(default_factory=list)
    arxiv_ids: list[str] = field(default_factory=list)
    primary_doi: str | None = None
    primary_isbn: str | None = None

    @property
    def has_any(self) -> bool:
        return bool(self.dois or self.isbns or self.pmids or self.arxiv_ids)


def extract_identifiers(text: str, max_pages: int = 2) -> ExtractedIdentifiers:
    """
    Extract academic identifiers from document text.

    Focuses on the first N pages where identifiers typically appear
    (title page, copyright page, header/footer).

    Args:
        text: Full document text (pages may be separated by \\f or page markers)
        max_pages: Number of pages to scan (default 2)

    Returns:
        ExtractedIdentifiers with all found identifiers
    """
    # Split into pages/chapters (Docling uses \f, PyMuPDF4LLM uses page markers, EPUB uses chapter headers)
    pages = re.split(r"\f|(?=^#{1,2}\s+(?:Page|Chapter)\s+\d)", text, flags=re.MULTILINE)
    scan_text = "\n".join(pages[:max_pages]) if len(pages) > max_pages else text[:20000]

    result = ExtractedIdentifiers()

    # Extract DOIs (Zotero pattern + cleanup)
    for match in DOI_REGEX.finditer(scan_text):
        doi = match.group(0)
        # Zotero cleanup: remove trailing ) or } if no matching opener
        if doi.endswith(")") and "(" not in doi:
            doi = doi[:-1]
        if doi.endswith("}") and "{" not in doi:
            doi = doi[:-1]
        if doi not in result.dois:
            result.dois.append(doi)

    # Extract ISBNs
    for pattern in [ISBN_13_REGEX, ISBN_10_REGEX]:
        for match in pattern.finditer(scan_text):
            isbn = clean_isbn(match.group(1))
            if isbn and isbn not in result.isbns:
                result.isbns.append(isbn)

    # Extract PMIDs
    for match in PMID_REGEX.finditer(scan_text):
        pmid = match.group(1)
        if pmid not in result.pmids:
            result.pmids.append(pmid)

    # Extract arXiv IDs
    for pattern in [ARXIV_REGEX, ARXIV_OLD_REGEX]:
        for match in pattern.finditer(scan_text):
            arxiv_id = match.group(1)
            if arxiv_id not in result.arxiv_ids:
                result.arxiv_ids.append(arxiv_id)

    # Set primary identifiers
    result.primary_doi = result.dois[0] if result.dois else None
    result.primary_isbn = result.isbns[0] if result.isbns else None

    if result.has_any:
        logger.info(
            "Extracted identifiers: DOI=%s, ISBN=%s, PMID=%s, arXiv=%s",
            result.primary_doi,
            result.primary_isbn,
            result.pmids[:1] or None,
            result.arxiv_ids[:1] or None,
        )

    return result


def clean_isbn(raw: str) -> str | None:
    """Clean and validate ISBN string. Returns None if invalid."""
    cleaned = re.sub(r"[^0-9Xx]", "", raw).upper()
    if len(cleaned) == 13 and cleaned.startswith(("978", "979")):
        return cleaned
    if len(cleaned) == 10:
        return cleaned
    return None


def detect_identifier_type(text: str) -> tuple[str, str] | None:
    """
    Detect identifier type from user input (for manual paste).
    Returns (type, cleaned_value) or None.
    """
    text = text.strip()

    # DOI (with or without URL prefix)
    doi_match = re.match(r"^(?:https?://(?:dx\.)?doi\.org/)?(?P<id>10\.\d{4,}/\S+)$", text)
    if doi_match:
        return "doi", doi_match.group("id")

    # arXiv (with or without URL/prefix)
    arxiv_match = re.match(r"^(?:https?://arxiv\.org/abs/)?(?:arXiv:)?(?P<id>\d{4}\.\d{4,5}(?:v\d+)?)$", text, re.IGNORECASE)
    if arxiv_match:
        return "arxiv", arxiv_match.group("id")

    # ISBN
    isbn_candidate = re.sub(r"[^0-9Xx]", "", text).upper()
    if len(isbn_candidate) == 13 and isbn_candidate.startswith(("978", "979")):
        return "isbn", isbn_candidate
    if len(isbn_candidate) == 10:
        return "isbn", isbn_candidate

    # PMID
    pmid_match = re.match(r"^(?:PMID[:\s]*)?(\d{6,9})$", text, re.IGNORECASE)
    if pmid_match:
        return "pmid", pmid_match.group(1)

    return None
