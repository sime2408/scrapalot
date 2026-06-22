"""Zotero connector for Scrapalot Chat.

Workspace connector for syncing research libraries from Zotero.
Uses pyzotero library for Zotero Web API v3.

Supports:
- API key authentication (user or group libraries)
- Full library sync with incremental updates (version-based)
- PDF attachment download from Zotero Storage
- Annotation and highlight extraction
- Collection-based file listing
- Rich academic metadata (authors, DOI, journal, tags)
"""

from collections.abc import Generator
from datetime import UTC, datetime
from typing import Any

from pyzotero import zotero  # type: ignore[import-untyped]

from src.main.connectors.exceptions import (
    ConnectorAuthError,
    ConnectorError,
    ConnectorMissingCredentialError,
    ConnectorRateLimitError,
    ConnectorValidationError,
)
from src.main.connectors.factory import register_connector
from src.main.connectors.interfaces import (
    FileListingConnector,
    GenerateDocumentsOutput,
    LoadConnector,
    PollConnector,
    SecondsSinceUnixEpoch,
)
from src.main.connectors.models import (
    ConnectorCheckpoint,
    ConnectorSource,
    Document,
    DocumentMetadata,
    TextSection,
)
from src.main.utils.core.datetime_utils import parse_iso_datetime
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Zotero item types that represent academic documents
ACADEMIC_ITEM_TYPES = {
    "journalArticle",
    "book",
    "bookSection",
    "conferencePaper",
    "thesis",
    "report",
    "preprint",
    "manuscript",
    "magazineArticle",
    "newspaperArticle",
    "encyclopediaArticle",
    "dictionaryEntry",
    "document",
    "webpage",
    "presentation",
    "patent",
}

# Zotero item types to skip (non-document items)
SKIP_ITEM_TYPES = {"attachment", "note", "annotation"}


def _parse_zotero_date(date_str: str | None) -> datetime | None:
    """Parse Zotero date string to datetime. Zotero dates can be partial (e.g., '2024', '2024-03')."""
    if not date_str:
        return None
    try:
        # Full ISO date
        return parse_iso_datetime(date_str)
    except ValueError:
        logger.debug("Zotero date %r is not full ISO, trying partial formats", date_str)
    try:
        # Year-month
        if len(date_str) == 7:
            return datetime.strptime(date_str, "%Y-%m").replace(tzinfo=UTC)
        # Year only
        if len(date_str) == 4:
            return datetime.strptime(date_str, "%Y").replace(tzinfo=UTC)
    except ValueError:
        logger.debug("Could not parse partial Zotero date %r", date_str)
    return None


def _extract_authors(creators: list[dict[str, str]]) -> list[str]:
    """Extract author names from the Zotero creators list."""
    authors = []
    for creator in creators:
        if creator.get("creatorType") in ("author", "editor", "contributor"):
            first = creator.get("firstName", "")
            last = creator.get("lastName", "")
            name = creator.get("name", "")
            if name:
                authors.append(name)
            elif first or last:
                authors.append(f"{first} {last}".strip())
    return authors


def _extract_year(data: dict[str, Any]) -> int | None:
    """Extract publication year from Zotero item data."""
    date_str = data.get("date", "")
    if not date_str:
        return None
    try:
        # Try to find a 4-digit year
        for part in date_str.replace("/", "-").split("-"):
            part = part.strip()
            if len(part) == 4 and part.isdigit():
                return int(part)
    except (ValueError, IndexError) as e:
        logger.debug("Could not extract year from Zotero date %r: %s", date_str, e)
    return None


@register_connector(ConnectorSource.ZOTERO)
class ZoteroConnector(LoadConnector, PollConnector, FileListingConnector):
    """Zotero connector for syncing research libraries to Scrapalot.

    Connects to a user's Zotero library via the Web API v3 using an API key.
    Supports personal and group libraries, PDF downloads, annotations,
    and incremental sync via Zotero's version-based tracking.

    Arguments:
        connector_id: UUID of the connector
        workspace_id: UUID of the workspace
        config: Connector configuration
    """

    def __init__(
        self,
        connector_id: str,
        workspace_id: str,
        config: dict[str, Any],
    ) -> None:
        super().__init__()
        self.connector_id = connector_id
        self.workspace_id = workspace_id
        self.config = config

        # Configuration
        self.batch_size = config.get("batch_size", 50)
        self.library_type = config.get("library_type", "user")  # "user" or "group"
        self.library_id = config.get("library_id", "")
        self.collection_key = config.get("collection_key")  # Sync specific collection
        self.include_annotations = config.get("include_annotations", True)
        self.include_attachments = config.get("include_attachments", True)
        self.item_types = config.get("item_types", [])  # Filter by item types

        # Zotero client
        self.zot: zotero.Zotero | None = None

    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        """Load Zotero API key and initialize client.

        Expects credentials with:
        - api_key: Zotero API key (from https://www.zotero.org/settings/keys)
        - library_id: User ID or group ID (overrides config if present)
        - library_type: "user" or "group" (overrides config if present)
        """
        api_key = credentials.get("api_key") or credentials.get("access_token")
        if not api_key:
            raise ConnectorMissingCredentialError("Zotero")

        # Credentials can override config for library_id and library_type
        library_id = credentials.get("library_id") or self.library_id
        library_type = credentials.get("library_type") or self.library_type

        if not library_id:
            raise ConnectorValidationError("Zotero library_id is required. Find your user ID at https://www.zotero.org/settings/keys")

        self.library_id = library_id
        self.library_type = library_type

        try:
            self.zot = zotero.Zotero(library_id, library_type, api_key)
            # Verify connection by fetching key info
            self.zot.key_info()
            logger.info("Zotero client initialized (library_type=%s, library_id=%s)", library_type, library_id)
        except Exception as e:
            error_msg = str(e)
            if "403" in error_msg or "401" in error_msg:
                raise ConnectorAuthError(f"Zotero API key is invalid or lacks permissions: {error_msg}") from e
            raise ConnectorError(f"Failed to initialize Zotero client: {error_msg}") from e

        return None

    def validate_connector_settings(self) -> None:
        """Validate Zotero connector settings and credentials."""
        if self.zot is None:
            raise ConnectorMissingCredentialError("Zotero credentials not loaded.")

        try:
            # Verify access by fetching a single item
            self.zot.top(limit=1)
            logger.info("Zotero connector validation successful")
        except Exception as e:
            error_msg = str(e)
            if "403" in error_msg or "401" in error_msg:
                raise ConnectorAuthError(f"Zotero API key is invalid: {error_msg}") from e
            if "429" in error_msg:
                raise ConnectorRateLimitError("Zotero API rate limit exceeded during validation.") from e
            raise ConnectorValidationError(f"Unexpected Zotero error during validation: {error_msg}") from e

    def load_from_state(self) -> GenerateDocumentsOutput:
        """Load all items from Zotero library."""
        return self.poll_source(None, None)

    def poll_source(
        self,
        start: SecondsSinceUnixEpoch | None,
        end: SecondsSinceUnixEpoch | None,
    ) -> GenerateDocumentsOutput:
        """Poll for items updated within a time range."""
        if self.zot is None:
            raise ConnectorMissingCredentialError("Zotero")

        batch: list[Document] = []

        for item in self._iterate_items():
            data = item.get("data", {})

            # Skip non-document items
            item_type = data.get("itemType", "")
            if item_type in SKIP_ITEM_TYPES:
                continue

            # Time-based filtering
            if start or end:
                modified = data.get("dateModified")
                if modified:
                    mod_dt = _parse_zotero_date(modified)
                    if mod_dt:
                        mod_ts = mod_dt.timestamp()
                        if start and mod_ts < start:
                            continue
                        if end and mod_ts > end:
                            continue

            try:
                doc = self._item_to_document(item)
                if doc:
                    batch.append(doc)

                if len(batch) >= self.batch_size:
                    yield batch
                    batch = []

            except Exception as e:
                logger.error("Error processing Zotero item %s: %s", item.get("key", "?"), e)

        if batch:
            yield batch

    def list_files(
        self,
        checkpoint: ConnectorCheckpoint | None = None,
    ) -> Generator[dict[str, Any], None, ConnectorCheckpoint]:
        """List items from the Zotero library with metadata."""
        if self.zot is None:
            raise ConnectorMissingCredentialError("Zotero")

        logger.info("Listing Zotero library items...")
        all_processed = []

        for item in self._iterate_items():
            data = item.get("data", {})
            item_type = data.get("itemType", "")

            if item_type in SKIP_ITEM_TYPES:
                continue

            item_key = item.get("key", "")
            title = data.get("title", "Untitled")
            modified = data.get("dateModified")
            mod_dt = _parse_zotero_date(modified) if modified else None

            file_metadata = {
                "file_id": item_key,
                "file_name": f"{title}.txt",
                "file_path": self._get_collection_path(item),
                "file_type": item_type,
                "file_size": None,
                "modified_time": mod_dt,
                "extra": {
                    "item_type": item_type,
                    "creators": data.get("creators", []),
                    "tags": [t.get("tag", "") for t in data.get("tags", [])],
                    "url": data.get("url", ""),
                    "doi": data.get("DOI", ""),
                },
            }
            yield file_metadata
            all_processed.append(item_key)

        return ConnectorCheckpoint(
            page_token=None,
            last_sync_time=datetime.now(UTC),
            processed_files=all_processed,
            has_more=False,
        )

    def fetch_file(self, file_id: str) -> Document:
        """Fetch a single Zotero item by key and return as Document."""
        if self.zot is None:
            raise ConnectorMissingCredentialError("Zotero")

        logger.info("Fetching Zotero item: %s", file_id)

        try:
            item = self.zot.item(file_id)
            doc = self._item_to_document(item)
            if not doc:
                raise ConnectorError(f"Could not convert Zotero item {file_id} to document")
            return doc
        except Exception as e:
            logger.error("Failed to fetch Zotero item %s: %s", file_id, e)
            raise ConnectorError(f"Failed to fetch Zotero item: {e}") from e

    # ─── Internal helpers ───────────────────────────────────────────────

    def _iterate_items(self):
        """Iterate through all Zotero items with pagination."""
        start = 0
        limit = min(self.batch_size, 100)  # Zotero API max is 100

        while True:
            try:
                if self.collection_key:
                    items = self.zot.collection_items(self.collection_key, start=start, limit=limit)
                else:
                    items = self.zot.top(start=start, limit=limit)
            except Exception as e:
                error_msg = str(e)
                if "429" in error_msg:
                    raise ConnectorRateLimitError("Zotero API rate limit exceeded.") from e
                raise ConnectorError(f"Failed to fetch Zotero items: {error_msg}") from e

            if not items:
                break

            yield from items
            start += limit

            if len(items) < limit:
                break

    def _item_to_document(self, item: dict[str, Any]) -> Document | None:
        """Convert a Zotero item to a Scrapalot Document."""
        data = item.get("data", {})
        item_key = item.get("key", "")
        item_type = data.get("itemType", "")

        # Skip non-document items
        if item_type in SKIP_ITEM_TYPES:
            return None

        title = data.get("title") or "Untitled"
        abstract = data.get("abstractNote", "")
        creators = data.get("creators", [])
        tags = [t.get("tag", "") for t in data.get("tags", [])]
        date_modified = data.get("dateModified")
        url = data.get("url", "")
        doi = data.get("DOI", "")

        # Build text content sections
        sections: list[TextSection] = []

        # Abstract
        if abstract:
            sections.append(TextSection(text=f"Abstract:\n{abstract}"))

        # Try to get full-text content from Zotero's indexed text
        fulltext = self._get_fulltext(item_key)
        if fulltext:
            sections.append(TextSection(text=fulltext))

        # Annotations and highlights
        if self.include_annotations:
            annotation_text = self._get_annotations(item_key)
            if annotation_text:
                sections.append(TextSection(text=f"Annotations and Highlights:\n{annotation_text}"))

        # Notes
        notes_text = self._get_notes(item_key)
        if notes_text:
            sections.append(TextSection(text=f"Notes:\n{notes_text}"))

        # If no content at all, use title + metadata as minimal content
        if not sections:
            meta_parts = [f"Title: {title}"]
            authors = _extract_authors(creators)
            if authors:
                meta_parts.append(f"Authors: {', '.join(authors)}")
            if doi:
                meta_parts.append(f"DOI: {doi}")
            if url:
                meta_parts.append(f"URL: {url}")
            sections.append(TextSection(text="\n".join(meta_parts)))

        # Extract academic metadata
        authors = _extract_authors(creators)
        year = _extract_year(data)
        venue = data.get("publicationTitle") or data.get("proceedingsTitle") or data.get("bookTitle", "")
        mod_dt = _parse_zotero_date(date_modified) if date_modified else None
        published_date = data.get("date", "")
        pub_dt = _parse_zotero_date(published_date)

        # Determine source type
        source_type_map = {
            "journalArticle": "journal_article",
            "conferencePaper": "conference_paper",
            "book": "book",
            "bookSection": "book_section",
            "thesis": "thesis",
            "report": "report",
            "preprint": "preprint",
        }
        source_type = source_type_map.get(item_type, "academic_paper")

        metadata = DocumentMetadata(
            connector_id=self.connector_id,
            workspace_id=self.workspace_id,
            file_id=item_key,
            file_name=f"{title}.txt",
            file_path=self._get_collection_path(item),
            file_type=item_type,
            last_modified=mod_dt,
            # Academic metadata
            title=title,
            authors=authors if authors else None,
            year=year,
            url=url or None,
            doi=doi or None,
            venue=venue or None,
            source_type=source_type,
            published_date=pub_dt.isoformat() if pub_dt else None,
            updated_date=mod_dt.isoformat() if mod_dt else None,
            categories=tags if tags else None,
            extra={
                "item_type": item_type,
                "library_type": self.library_type,
                "library_id": self.library_id,
                "zotero_key": item_key,
                "isbn": data.get("ISBN", ""),
                "issn": data.get("ISSN", ""),
                "language": data.get("language", ""),
                "journal_abbreviation": data.get("journalAbbreviation", ""),
                "volume": data.get("volume", ""),
                "issue": data.get("issue", ""),
                "pages": data.get("pages", ""),
                "series": data.get("series", ""),
                "publisher": data.get("publisher", ""),
                "rights": data.get("rights", ""),
            },
        )

        return Document(
            id=f"zotero:{item_key}",
            sections=sections,
            source=ConnectorSource.ZOTERO,
            semantic_identifier=title,
            metadata=metadata,
            title=title,
            doc_updated_at=mod_dt,
        )

    def _get_fulltext(self, item_key: str) -> str | None:
        """Get indexed full-text content for an item's attachments."""
        if not self.include_attachments:
            return None

        try:
            children = self.zot.children(item_key)
            for child in children:
                child_data = child.get("data", {})
                if child_data.get("itemType") != "attachment":
                    continue
                if child_data.get("contentType") not in ("application/pdf", "application/epub+zip", "text/html"):
                    continue

                child_key = child.get("key", "")
                # noinspection PyBroadException
                try:
                    fulltext_data = self.zot.fulltext(child_key)
                    content = fulltext_data.get("content", "")
                    if content and len(content) > 50:
                        return content
                except Exception as e:
                    # Full-text may not be available for all attachments
                    logger.debug("No full-text for attachment %s: %s", child_key, e)
        except Exception as e:
            logger.debug("Could not fetch full-text for item %s: %s", item_key, e)

        return None

    def _get_annotations(self, item_key: str) -> str | None:
        """Extract annotations and highlights from an item's PDF attachments."""
        try:
            children = self.zot.children(item_key)
            annotations = []

            for child in children:
                child_data = child.get("data", {})

                # Direct annotation children
                if child_data.get("itemType") == "annotation":
                    ann_type = child_data.get("annotationType", "")
                    text = child_data.get("annotationText", "")
                    comment = child_data.get("annotationComment", "")
                    page = child_data.get("annotationPageLabel", "")

                    parts = []
                    if ann_type == "highlight" and text:
                        parts.append(f'[Highlight p.{page}] "{text}"')
                    elif ann_type == "note" and comment:
                        parts.append(f"[Note p.{page}] {comment}")
                    elif text:
                        parts.append(f"[{ann_type} p.{page}] {text}")

                    if comment and ann_type == "highlight":
                        parts.append(f"  Comment: {comment}")

                    if parts:
                        annotations.append("\n".join(parts))

                # Annotations nested under attachment children
                elif child_data.get("itemType") == "attachment":
                    child_key = child.get("key", "")
                    try:
                        grandchildren = self.zot.children(child_key)
                        for gc in grandchildren:
                            gc_data = gc.get("data", {})
                            if gc_data.get("itemType") != "annotation":
                                continue

                            ann_type = gc_data.get("annotationType", "")
                            text = gc_data.get("annotationText", "")
                            comment = gc_data.get("annotationComment", "")
                            page = gc_data.get("annotationPageLabel", "")

                            parts = []
                            if ann_type == "highlight" and text:
                                parts.append(f'[Highlight p.{page}] "{text}"')
                            elif ann_type == "note" and comment:
                                parts.append(f"[Note p.{page}] {comment}")
                            elif text:
                                parts.append(f"[{ann_type} p.{page}] {text}")

                            if comment and ann_type == "highlight":
                                parts.append(f"  Comment: {comment}")

                            if parts:
                                annotations.append("\n".join(parts))
                    except Exception as e:
                        logger.debug("Suppressed exception: %s", e)

            if annotations:
                return "\n\n".join(annotations)

        except Exception as e:
            logger.debug("Could not fetch annotations for item %s: %s", item_key, e)

        return None

    def _get_notes(self, item_key: str) -> str | None:
        """Extract notes attached to an item."""
        try:
            children = self.zot.children(item_key)
            notes = []

            for child in children:
                child_data = child.get("data", {})
                if child_data.get("itemType") != "note":
                    continue

                note_content = child_data.get("note", "")
                if note_content:
                    # Strip HTML tags from note content
                    import re

                    clean_note = re.sub(r"<[^>]+>", "", note_content).strip()
                    if clean_note:
                        notes.append(clean_note)

            if notes:
                return "\n\n---\n\n".join(notes)

        except Exception as e:
            logger.debug("Could not fetch notes for item %s: %s", item_key, e)

        return None

    def _get_collection_path(self, item: dict[str, Any]) -> str:
        """Build a path string from the item's collection membership."""
        data = item.get("data", {})
        collections = data.get("collections", [])

        if not collections or not self.zot:
            return "/"

        # Use the first collection to build a path
        try:
            col = self.zot.collection(collections[0])
            col_data = col.get("data", {})
            col_name = col_data.get("name", "")
            if col_name:
                return f"/{col_name}"
        except Exception as e:
            logger.debug("Suppressed exception: %s", e)

        return "/"
