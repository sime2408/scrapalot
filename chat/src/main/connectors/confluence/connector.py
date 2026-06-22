"""Simplified Confluence connector for Scrapalot Chat.

Supports:
- Confluence Cloud and Server authentication
- Page content retrieval
- Space and page filtering
- Basic CQL query support
- Incremental sync

Note: This is a simplified implementation. Advanced features like
attachment indexing, comment extraction, and permission sync are not included.
"""

from collections.abc import Generator
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from atlassian import Confluence
from bs4 import BeautifulSoup

from src.main.connectors.exceptions import (
    ConnectorAuthError,
    ConnectorError,
    ConnectorMissingCredentialError,
)
from src.main.connectors.factory import register_connector
from src.main.connectors.interfaces import (
    GenerateDocumentsOutput,
    LoadConnector,
    PollConnector,
    SecondsSinceUnixEpoch,
)
from src.main.connectors.models import (
    ConnectorSource,
    Document,
    DocumentMetadata,
    TextSection,
)
from src.main.utils.core.datetime_utils import parse_iso_datetime
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_BATCH_SIZE = 25
_PAGE_EXPANSION = "body.storage,version,space"


def extract_text_from_confluence_html(html_content: str) -> str:
    """Extract clean text from Confluence HTML."""
    if not html_content:
        return ""

    soup = BeautifulSoup(html_content, "html.parser")

    # Remove script and style elements
    for script in soup(["script", "style"]):
        script.decompose()

    # Get text
    text = soup.get_text()

    # Clean up whitespace
    lines = (line.strip() for line in text.splitlines())
    chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
    text = "\n".join(chunk for chunk in chunks if chunk)

    return text


@register_connector(ConnectorSource.CONFLUENCE)
class ConfluenceConnector(LoadConnector, PollConnector):
    """Simplified Confluence connector.

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
        """Initialize with parameters."""
        super().__init__()
        self.connector_id = connector_id
        self.workspace_id = workspace_id
        self.config = config

        # Configuration
        self.wiki_url = config.get("wiki_url", "")
        self.is_cloud = config.get("is_cloud", True)
        self.space_key = config.get("space", "")  # Empty = all spaces
        self.page_id = config.get("page_id", "")  # Empty = all pages
        self.batch_size = config.get("batch_size", _BATCH_SIZE)

        self.confluence: Confluence | None = None

    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        """Load and validate Confluence credentials."""
        username = credentials.get("username")
        password = credentials.get("password")  # API token for Cloud

        if not all([self.wiki_url, username, password]):
            raise ConnectorMissingCredentialError("Confluence requires wiki_url, username, and password/API token")

        try:
            # Create Confluence client
            confluence = Confluence(
                url=self.wiki_url,
                username=username,
                password=password,
                cloud=self.is_cloud,
            )
            self.confluence = confluence

            # Test connection
            try:
                confluence.get_all_spaces(start=0, limit=1)

                logger.info("Successfully authenticated with Confluence")
                return credentials

            except Exception as e:
                raise ConnectorAuthError(f"Confluence authentication failed: {e}") from e

        except Exception as e:
            raise ConnectorError(f"Error initializing Confluence client: {e}") from e

    def _build_cql_query(
        self,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> str:
        """Build CQL query for page retrieval."""
        cql = "type=page"

        # Add space filter
        if self.space_key:
            cql += f" and space='{quote(self.space_key)}'"

        # Add page ID filter
        if self.page_id:
            cql += f" and id='{self.page_id}'"

        # Add time filters
        if start_time:
            formatted_start = start_time.strftime("%Y-%m-%d %H:%M")
            cql += f" and lastmodified >= '{formatted_start}'"

        if end_time:
            formatted_end = end_time.strftime("%Y-%m-%d %H:%M")
            cql += f" and lastmodified <= '{formatted_end}'"

        # Order by modification time
        cql += " order by lastmodified asc"

        return cql

    def _get_pages(
        self,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> list[dict[str, Any]]:
        """Get pages using CQL query."""
        if not self.confluence:
            raise ConnectorMissingCredentialError("Confluence")

        cql = self._build_cql_query(start_time, end_time)

        logger.info("Executing CQL query: %s", cql)

        try:
            pages = []
            start = 0
            limit = 100

            while True:
                # Use CQL search
                results = self.confluence.cql(
                    cql=cql,
                    start=start,
                    limit=limit,
                    expand=_PAGE_EXPANSION,
                )

                if not results or "results" not in results:
                    break

                batch = results["results"]
                if not batch:
                    break

                pages.extend(batch)
                start += limit

                # Check if there are more results
                if len(batch) < limit:
                    break

            logger.info("Found %s pages", len(pages))
            return pages

        except Exception as e:
            raise ConnectorError(f"Error fetching pages: {e}") from e

    def _page_to_document(self, page: dict[str, Any]) -> Document:
        """Convert the Confluence page to Document."""
        try:
            page_id = page.get("id", "")
            title = page.get("title", "Untitled")

            # Extract page content
            body = page.get("body", {}).get("storage", {}).get("value", "")
            text_content = extract_text_from_confluence_html(body)

            # Get metadata
            version = page.get("version", {})
            version_number = version.get("number", 1)

            space = page.get("space", {})
            space_key = space.get("key", "")
            space_name = space.get("name", "")

            # Get modification time
            when = version.get("when")
            modified_at = None
            if when:
                try:
                    modified_at = parse_iso_datetime(when)
                except Exception as e:
                    logger.debug("Suppressed exception: %s", e)

            # Build web URL
            web_url = f"{self.wiki_url}/pages/viewpage.action?pageId={page_id}"
            if self.is_cloud:
                # Cloud URLs are different
                web_url = page.get("_links", {}).get("webui", "")
                if web_url and not web_url.startswith("http"):
                    web_url = f"{self.wiki_url}{web_url}"

            return Document(
                id=page_id,
                sections=[TextSection(text=text_content, link=web_url)],
                source=ConnectorSource.CONFLUENCE,
                semantic_identifier=title,
                doc_updated_at=modified_at,
                metadata=DocumentMetadata(
                    connector_id=self.connector_id,
                    workspace_id=self.workspace_id,
                    file_name=title,
                    file_id=page_id,
                    file_type="confluence_page",
                    last_modified=modified_at,
                    extra={
                        "space_key": space_key,
                        "space_name": space_name,
                        "version": version_number,
                    },
                ),
            )

        except Exception as e:
            logger.exception("Error converting page %s: %s", page.get("id", "unknown"), e)
            raise

    def _process_pages(
        self,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ) -> Generator[list[Document], None, None]:
        """Process pages and yield documents in batches."""
        pages = self._get_pages(start_time, end_time)

        documents = []
        for page in pages:
            try:
                doc = self._page_to_document(page)
                documents.append(doc)

                # Yield batch when ready
                if len(documents) >= self.batch_size:
                    yield documents
                    documents = []

            except Exception as e:
                logger.exception("Error processing page %s: %s", page.get("id", "unknown"), e)
                continue

        # Yield remaining documents
        if documents:
            yield documents

    def load_from_state(self) -> GenerateDocumentsOutput:
        """Load all pages from Confluence."""
        if not self.confluence:
            raise ConnectorMissingCredentialError("Confluence")

        logger.info("Starting Confluence connector load_from_state")

        yield from self._process_pages()

        logger.info("Completed Confluence connector load_from_state")

    def poll_source(
        self,
        start: SecondsSinceUnixEpoch,
        end: SecondsSinceUnixEpoch,
    ) -> GenerateDocumentsOutput:
        """Poll for pages modified between start and end time."""
        if not self.confluence:
            raise ConnectorMissingCredentialError("Confluence")

        logger.info("Starting Confluence connector poll_source from %s to %s", start, end)

        start_time = datetime.fromtimestamp(start, tz=UTC)
        end_time = datetime.fromtimestamp(end, tz=UTC)

        yield from self._process_pages(start_time, end_time)

        logger.info("Completed Confluence connector poll_source")
