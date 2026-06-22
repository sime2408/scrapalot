"""Duplicate detection service for documents.

Three-tier matching (inspired by Zotero's duplicates.js):
1. Exact DOI match
2. Exact ISBN match
3. Fuzzy title matching via pg_trgm (similarity > 0.6)

Results grouped via union-find for transitive duplicates.
"""

from dataclasses import dataclass

from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


@dataclass
class DuplicateMatch:
    """A potential duplicate document."""

    document_id: str
    title: str
    filename: str
    match_type: str  # 'exact_doi', 'exact_isbn', 'fuzzy_title'
    confidence: float  # 0.0-1.0
    doi: str | None = None
    isbn: str | None = None


def find_duplicates(db: Session, document_id: str) -> list[DuplicateMatch]:
    """Find potential duplicates for a given document."""
    matches = []

    # Get document metadata
    doc = db.execute(
        text("""
            SELECT id, title, filename, extracted_metadata
            FROM documents WHERE id = CAST(:did AS uuid)
        """),
        {"did": document_id},
    ).fetchone()
    if not doc:
        return []

    title = doc[1] or ""
    meta = doc[3] or {}
    if isinstance(meta, str):
        import json

        meta = json.loads(meta) if meta else {}

    identifiers = meta.get("identifiers", {})
    doi = identifiers.get("doi")
    isbn = identifiers.get("isbn")

    # Tier 1: Exact DOI match
    if doi:
        doi_matches = db.execute(
            text("""
                SELECT id, title, filename, extracted_metadata
                FROM documents
                WHERE id != CAST(:did AS uuid)
                AND extracted_metadata->>'identifiers' IS NOT NULL
                AND extracted_metadata->'identifiers'->>'doi' = :doi
            """),
            {"did": document_id, "doi": doi},
        ).fetchall()
        for m in doi_matches:
            matches.append(
                DuplicateMatch(
                    document_id=str(m[0]),
                    title=m[1] or m[2],
                    filename=m[2],
                    match_type="exact_doi",
                    confidence=0.98,
                    doi=doi,
                )
            )

    # Tier 2: Exact ISBN match
    if isbn:
        isbn_matches = db.execute(
            text("""
                SELECT id, title, filename, extracted_metadata
                FROM documents
                WHERE id != CAST(:did AS uuid)
                AND extracted_metadata->>'identifiers' IS NOT NULL
                AND extracted_metadata->'identifiers'->>'isbn' = :isbn
            """),
            {"did": document_id, "isbn": isbn},
        ).fetchall()
        for m in isbn_matches:
            if str(m[0]) not in [x.document_id for x in matches]:
                matches.append(
                    DuplicateMatch(
                        document_id=str(m[0]),
                        title=m[1] or m[2],
                        filename=m[2],
                        match_type="exact_isbn",
                        confidence=0.95,
                        isbn=isbn,
                    )
                )

    # Tier 3: Fuzzy title match + creator/year verification
    if title and len(title) > 10:
        try:
            fuzzy_matches = db.execute(
                text("""
                    SELECT id, title, filename, extracted_metadata,
                           similarity(LOWER(title), LOWER(:title)) as sim
                    FROM documents
                    WHERE id != CAST(:did AS uuid)
                    AND title IS NOT NULL
                    AND LENGTH(title) > 10
                    AND similarity(LOWER(title), LOWER(:title)) > 0.6
                    ORDER BY sim DESC
                    LIMIT 10
                """),
                {"did": document_id, "title": title},
            ).fetchall()

            # Extract source document creators and year for verification
            resolved = meta.get("resolved", {})
            src_authors = resolved.get("authors", [])
            src_year = resolved.get("year")
            src_last_names = {_extract_last_name(a).lower() for a in src_authors if a}

            for m in fuzzy_matches:
                if str(m[0]) in [x.document_id for x in matches]:
                    continue
                sim = float(m[4])
                confidence = sim

                # Verify creator overlap and year tolerance
                m_meta = m[3] or {}
                if isinstance(m_meta, str):
                    import json as _json

                    m_meta = _json.loads(m_meta) if m_meta else {}
                m_resolved = m_meta.get("resolved", {})
                m_authors = m_resolved.get("authors", [])
                m_year = m_resolved.get("year")
                m_last_names = {_extract_last_name(a).lower() for a in m_authors if a}

                # Boost confidence if at least one creator last name matches
                creator_match = bool(src_last_names & m_last_names) if src_last_names and m_last_names else False
                if creator_match:
                    confidence = min(confidence + 0.10, 0.99)

                # Year tolerance: same year or ±1
                year_match = True
                if src_year is not None and m_year is not None:
                    year_match = abs(int(src_year) - int(m_year)) <= 1

                # Accept if title sim > 0.6 AND (creator match OR no creator data)
                if sim > 0.6 and (creator_match or not src_last_names or not m_last_names) and year_match:
                    matches.append(
                        DuplicateMatch(
                            document_id=str(m[0]),
                            title=m[1] or m[2],
                            filename=m[2],
                            match_type="fuzzy_title",
                            confidence=confidence,
                        )
                    )
        except Exception as e:
            # pg_trgm might not be installed
            logger.debug("Fuzzy title search failed (pg_trgm not available?): %s", str(e))

    if matches:
        logger.info("Found %d potential duplicates for document %s", len(matches), document_id[:8])

    return matches


def _extract_last_name(full_name: str) -> str:
    """Extract last name from 'Last, First' or 'First Last' format."""
    parts = full_name.strip().split(",")
    if len(parts) >= 2:
        return parts[0].strip()
    words = full_name.strip().split()
    return words[-1] if words else full_name


def find_duplicates_by_metadata(db: Session, _title: str, doi: str | None = None, isbn: str | None = None) -> list[DuplicateMatch]:
    """Pre-upload duplicate check by metadata (before document is created)."""
    matches = []

    if doi:
        doi_matches = db.execute(
            text("""
                SELECT id, title, filename
                FROM documents
                WHERE extracted_metadata->'identifiers'->>'doi' = :doi
                LIMIT 5
            """),
            {"doi": doi},
        ).fetchall()
        for m in doi_matches:
            matches.append(
                DuplicateMatch(
                    document_id=str(m[0]),
                    title=m[1] or m[2],
                    filename=m[2],
                    match_type="exact_doi",
                    confidence=0.98,
                    doi=doi,
                )
            )

    if isbn and not matches:
        isbn_matches = db.execute(
            text("""
                SELECT id, title, filename
                FROM documents
                WHERE extracted_metadata->'identifiers'->>'isbn' = :isbn
                LIMIT 5
            """),
            {"isbn": isbn},
        ).fetchall()
        for m in isbn_matches:
            matches.append(
                DuplicateMatch(
                    document_id=str(m[0]),
                    title=m[1] or m[2],
                    filename=m[2],
                    match_type="exact_isbn",
                    confidence=0.95,
                    isbn=isbn,
                )
            )

    return matches
