"""Resolve academic identifiers to full metadata via external APIs.

Resolution priority (matching Zotero's recognizeDocument.js lines 432-578):
  arXiv → DOI (CrossRef) → ISBN (Open Library) → PMID (PubMed)

Each resolver is async, has timeout, and results are cached in Redis (30-day TTL).
"""

from dataclasses import asdict, dataclass, field
import re

import httpx

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_TIMEOUT = 10.0
_USER_AGENT = "Scrapalot/1.0 (mailto:research@mail.scrapalot.app)"


@dataclass
class Creator:
    """Structured creator with role distinction."""

    first_name: str = ""
    last_name: str = ""
    role: str = "author"  # author, editor, contributor, translator, book_author

    @property
    def display_name(self) -> str:
        if self.last_name and self.first_name:
            return f"{self.last_name}, {self.first_name}"
        return self.last_name or self.first_name or "Unknown"


@dataclass
class ResolvedMetadata:
    """Structured metadata from external API resolution."""

    title: str | None = None
    authors: list[str] = field(default_factory=list)
    creators: list[Creator] = field(default_factory=list)
    year: int | None = None
    journal: str | None = None
    volume: str | None = None
    issue: str | None = None
    pages: str | None = None
    abstract: str | None = None
    doi: str | None = None
    isbn: str | None = None
    pmid: str | None = None
    arxiv_id: str | None = None
    url: str | None = None
    publisher: str | None = None
    document_type: str | None = None
    language: str | None = None
    issn: str | None = None
    keywords: list[str] = field(default_factory=list)
    source: str = "unknown"
    confidence: float = 0.0

    def to_dict(self) -> dict:
        result = {}
        for k, v in asdict(self).items():
            if v is None or v == [] or v == 0.0:
                continue
            # Serialize creators as list of dicts
            if k == "creators" and isinstance(v, list):
                result[k] = [c for c in v if isinstance(c, dict)]
            else:
                result[k] = v
        return result


def _clean_abstract(raw: str | None) -> str | None:
    """Strip HTML/JATS tags from CrossRef abstracts."""
    if not raw:
        return None
    clean = re.sub(r"<[^>]+>", "", raw).strip()
    return clean if len(clean) > 20 else None


def _extract_year(date_parts: dict | None) -> int | None:
    """Extract year from CrossRef date-parts structure."""
    if not date_parts:
        return None
    parts = date_parts.get("date-parts", [[]])
    if parts and parts[0] and len(parts[0]) >= 1:
        return int(parts[0][0])
    return None


def _map_crossref_type(cr_type: str | None) -> str | None:
    """Map CrossRef type to Scrapalot document type."""
    mapping = {
        "journal-article": "journal_article",
        "book": "book",
        "book-chapter": "book_section",
        "proceedings-article": "conference_paper",
        "posted-content": "preprint",
        "dissertation": "thesis",
        "report": "report",
        "monograph": "book",
    }
    return mapping.get(cr_type or "")


async def resolve_doi(doi: str) -> ResolvedMetadata | None:
    """Resolve DOI via CrossRef API. Primary resolver for journal articles."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.get(
                f"https://api.crossref.org/works/{doi}",
                headers={"User-Agent": _USER_AGENT, "Accept": "application/json"},
            )
            if response.status_code != 200:
                logger.debug("CrossRef returned %s for DOI %s", response.status_code, doi)
                return None

            data = response.json().get("message", {})
            title_list = data.get("title", [])
            title = title_list[0] if title_list else None

            authors = []
            creators = []
            # CrossRef author field contains authors
            for a in data.get("author", []):
                family = a.get("family", "")
                given = a.get("given", "")
                if family:
                    authors.append(f"{family}, {given}".strip(", "))
                    creators.append(Creator(first_name=given, last_name=family, role="author"))
            # CrossRef editor field contains editors
            for e in data.get("editor", []):
                family = e.get("family", "")
                given = e.get("given", "")
                if family:
                    creators.append(Creator(first_name=given, last_name=family, role="editor"))
            # CrossRef translator field
            for t in data.get("translator", []):
                family = t.get("family", "")
                given = t.get("given", "")
                if family:
                    creators.append(Creator(first_name=given, last_name=family, role="translator"))

            container = data.get("container-title", [])

            # Extract keywords/subjects from CrossRef (auto-tag)
            subjects = data.get("subject", [])

            return ResolvedMetadata(
                title=title,
                authors=authors,
                creators=creators,
                year=_extract_year(data.get("published-print") or data.get("published-online") or data.get("created")),
                journal=container[0] if container else None,
                volume=data.get("volume"),
                issue=data.get("issue"),
                pages=data.get("page"),
                abstract=_clean_abstract(data.get("abstract")),
                doi=doi,
                url=f"https://doi.org/{doi}",
                publisher=data.get("publisher"),
                document_type=_map_crossref_type(data.get("type")),
                issn=(data.get("ISSN", [None]) or [None])[0],
                language=data.get("language"),
                keywords=subjects,
                source="crossref",
                confidence=0.95,
            )
    except Exception as e:
        logger.warning("CrossRef resolution failed for DOI %s: %s", doi, str(e))
        return None


async def resolve_isbn(isbn: str) -> ResolvedMetadata | None:
    """Resolve ISBN via Open Library API."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            response = await client.get(f"https://openlibrary.org/isbn/{isbn}.json")
            if response.status_code != 200:
                return None

            data = response.json()
            title = data.get("title")

            # Fetch authors (separate API call)
            authors = []
            creators = []
            for author_ref in data.get("authors", []):
                author_key = author_ref.get("key")
                if author_key:
                    try:
                        author_resp = await client.get(f"https://openlibrary.org{author_key}.json")
                        if author_resp.status_code == 200:
                            author_data = author_resp.json()
                            name = author_data.get("name", "")
                            authors.append(name)
                            parts = name.split()
                            if len(parts) >= 2:
                                creators.append(Creator(first_name=" ".join(parts[:-1]), last_name=parts[-1], role="author"))
                            elif parts:
                                creators.append(Creator(last_name=parts[0], role="author"))
                    except Exception as e:
                        logger.debug("Suppressed exception: %s", e)

            # Extract year from publish_date
            year = None
            publish_date = data.get("publish_date", "")
            year_match = re.search(r"\b(19|20)\d{2}\b", publish_date)
            if year_match:
                year = int(year_match.group(0))

            return ResolvedMetadata(
                title=title,
                authors=authors,
                creators=creators,
                year=year,
                isbn=isbn,
                publisher=data.get("publishers", [None])[0] if data.get("publishers") else None,
                pages=str(data.get("number_of_pages", "")) or None,
                document_type="book",
                url=f"https://openlibrary.org/isbn/{isbn}",
                source="openlibrary",
                confidence=0.85,
            )
    except Exception as e:
        logger.warning("Open Library resolution failed for ISBN %s: %s", isbn, str(e))
        return None


async def resolve_arxiv(arxiv_id: str) -> ResolvedMetadata | None:
    """Resolve arXiv ID via arXiv API."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=True) as client:
            response = await client.get(f"https://export.arxiv.org/api/query?id_list={arxiv_id}&max_results=1")
            if response.status_code != 200:
                return None

            # Parse Atom XML
            text = response.text
            # Skip the feed title, get entry title
            titles = re.findall(r"<title[^>]*>(.*?)</title>", text, re.DOTALL)
            title = titles[1].strip() if len(titles) > 1 else None

            # Authors
            authors = re.findall(r"<name>(.*?)</name>", text)
            creators = []
            for name in authors:
                parts = name.strip().split()
                if len(parts) >= 2:
                    creators.append(Creator(first_name=" ".join(parts[:-1]), last_name=parts[-1], role="author"))
                elif parts:
                    creators.append(Creator(last_name=parts[0], role="author"))

            # Abstract
            summaries = re.findall(r"<summary[^>]*>(.*?)</summary>", text, re.DOTALL)
            abstract = summaries[0].strip() if summaries else None

            # Published date
            published = re.findall(r"<published>(.*?)</published>", text)
            year = None
            if published:
                year_match = re.match(r"(\d{4})", published[0])
                if year_match:
                    year = int(year_match.group(1))

            return ResolvedMetadata(
                title=title,
                authors=authors,
                creators=creators,
                year=year,
                abstract=abstract,
                arxiv_id=arxiv_id,
                url=f"https://arxiv.org/abs/{arxiv_id}",
                document_type="preprint",
                source="arxiv",
                confidence=0.95,
            )
    except Exception as e:
        logger.warning("arXiv resolution failed for %s: %s", arxiv_id, str(e))
        return None


async def resolve_pmid(pmid: str) -> ResolvedMetadata | None:
    """Resolve PubMed ID via NCBI E-utilities."""
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            response = await client.get(
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi",
                params={"db": "pubmed", "id": pmid, "retmode": "json"},
            )
            if response.status_code != 200:
                return None

            data = response.json()
            result = data.get("result", {}).get(pmid, {})
            if not result or "error" in result:
                return None

            authors = []
            creators = []
            for author in result.get("authors", []):
                name = author.get("name", "")
                authors.append(name)
                # PubMed format: "LastName FirstInitial"
                parts = name.split()
                if len(parts) >= 2:
                    creators.append(Creator(first_name=" ".join(parts[1:]), last_name=parts[0], role="author"))
                elif parts:
                    creators.append(Creator(last_name=parts[0], role="author"))

            # Extract year from pubdate
            year = None
            pubdate = result.get("pubdate", "")
            year_match = re.match(r"(\d{4})", pubdate)
            if year_match:
                year = int(year_match.group(1))

            # Get DOI from articleids
            doi = None
            for aid in result.get("articleids", []):
                if aid.get("idtype") == "doi":
                    doi = aid.get("value")
                    break

            return ResolvedMetadata(
                title=result.get("title"),
                authors=authors,
                creators=creators,
                year=year,
                journal=result.get("fulljournalname") or result.get("source"),
                volume=result.get("volume"),
                issue=result.get("issue"),
                pages=result.get("pages"),
                doi=doi,
                pmid=pmid,
                url=f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/",
                document_type="journal_article",
                language=result.get("lang", [None])[0] if result.get("lang") else None,
                issn=result.get("issn"),
                source="pubmed",
                confidence=0.90,
            )
    except Exception as e:
        logger.warning("PubMed resolution failed for PMID %s: %s", pmid, str(e))
        return None


async def resolve_identifier(identifier_type: str, identifier_value: str) -> ResolvedMetadata | None:
    """Resolve any identifier type to metadata."""
    resolvers = {
        "doi": resolve_doi,
        "isbn": resolve_isbn,
        "arxiv": resolve_arxiv,
        "pmid": resolve_pmid,
    }
    resolver = resolvers.get(identifier_type)
    if not resolver:
        logger.warning("Unknown identifier type: %s", identifier_type)
        return None
    return await resolver(identifier_value)


async def resolve_from_identifiers(
    dois: list[str] = None,
    isbns: list[str] = None,
    pmids: list[str] = None,
    arxiv_ids: list[str] = None,
) -> ResolvedMetadata | None:
    """
    Resolve metadata from extracted identifiers.
    Priority: arXiv → DOI → ISBN → PMID (matching Zotero).
    """
    # arXiv first (highest signal for preprints)
    if arxiv_ids:
        result = await resolve_arxiv(arxiv_ids[0])
        if result:
            return result

    # DOI (highest confidence for published articles)
    if dois:
        result = await resolve_doi(dois[0])
        if result:
            return result

    # ISBN (books)
    if isbns:
        result = await resolve_isbn(isbns[0])
        if result:
            return result

    # PMID (biomedical)
    if pmids:
        result = await resolve_pmid(pmids[0])
        if result:
            return result

    return None
