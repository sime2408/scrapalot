"""Notion connector for Scrapalot Chat.

Supports:
- OAuth authentication via Notion Integration Token
- Load all pages from workspace
- Poll for updated pages
- Recursive page indexing
- Database and child page support
"""

from collections.abc import Generator
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel
import requests
from retry import retry

from src.main.connectors.exceptions import (
    ConnectorAuthError,
    ConnectorMissingCredentialError,
    ConnectorValidationError,
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
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


_NOTION_PAGE_SIZE = 100
_NOTION_CALL_TIMEOUT = 30  # 30 seconds


class NotionPage(BaseModel):
    """Represents a Notion Page object"""

    id: str
    created_time: str
    last_edited_time: str
    archived: bool
    properties: dict[str, Any]
    url: str
    database_name: str | None = None  # Only applicable to the database type page (wiki)


class NotionBlock(BaseModel):
    """Represents a Notion Block object"""

    id: str  # Used for the URL
    text: str
    # In a plaintext representation of the page, how this block should be joined
    # with the existing text up to this point, separated out from text for clarity
    prefix: str


class NotionSearchResponse(BaseModel):
    """Represents the response from the Notion Search API"""

    results: list[dict[str, Any]]
    next_cursor: str | None = None
    has_more: bool = False


@register_connector(ConnectorSource.NOTION)
class NotionConnector(LoadConnector, PollConnector):
    """Notion Page connector that reads all Notion pages this integration has been granted access to.

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
        self.batch_size = config.get("batch_size", 50)
        self.recursive_index_enabled = config.get("recursive_index_enabled", False)
        self.root_page_id = config.get("root_page_id")

        # Headers for Notion API
        self.headers = {
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28",
        }

        # Track indexed pages to avoid duplicates
        self.indexed_pages: set[str] = set()

    @retry(tries=3, delay=1, backoff=2)
    def _fetch_child_blocks(self, block_id: str, cursor: str | None = None) -> dict[str, Any] | None:
        """Fetch all child blocks via the Notion API."""
        logger.debug("Fetching children of block with ID '%s'", block_id)
        block_url = f"https://api.notion.com/v1/blocks/{block_id}/children"
        query_params = None if not cursor else {"start_cursor": cursor}

        try:
            res = requests.get(
                block_url,
                headers=self.headers,
                params=query_params,
                timeout=_NOTION_CALL_TIMEOUT,
            )
            res.raise_for_status()
            return res.json()
        except Exception as e:
            exc_response = getattr(e, "response", None)
            if exc_response is not None and getattr(exc_response, "status_code", None) == 404:
                # This happens when a page is not shared with the integration
                logger.error(
                    "Unable to access block with ID '%s'. This is likely due to the block not being shared with the Scrapalot integration. Exact exception:\n\n%s",
                    block_id,
                    e,
                )
            else:
                logger.exception("Error fetching blocks: %s", e)
            return None

    @retry(tries=3, delay=1, backoff=2)
    def _fetch_page(self, page_id: str) -> NotionPage:
        """Fetch a page from its ID via the Notion API."""
        logger.debug("Fetching page for ID '%s'", page_id)
        page_url = f"https://api.notion.com/v1/pages/{page_id}"
        res = requests.get(
            page_url,
            headers=self.headers,
            timeout=_NOTION_CALL_TIMEOUT,
        )
        try:
            res.raise_for_status()
        except Exception as e:
            logger.warning("Failed to fetch page, trying database for ID '%s'. Exception: %s", page_id, e)
            # Try fetching as a database if page fetch fails
            return self._fetch_database_as_page(page_id)
        return NotionPage(**res.json())

    @retry(tries=3, delay=1, backoff=2)
    def _fetch_database_as_page(self, database_id: str) -> NotionPage:
        """Attempt to fetch a database as a page."""
        logger.debug("Fetching database for ID '%s' as a page", database_id)
        database_url = f"https://api.notion.com/v1/databases/{database_id}"
        res = requests.get(
            database_url,
            headers=self.headers,
            timeout=_NOTION_CALL_TIMEOUT,
        )
        res.raise_for_status()

        database_name = res.json().get("title")
        database_name = database_name[0].get("text", {}).get("content") if database_name else None

        return NotionPage(**res.json(), database_name=database_name)

    @retry(tries=3, delay=1, backoff=2)
    def _fetch_database(self, database_id: str, cursor: str | None = None) -> dict[str, Any]:
        """Fetch a database from its ID via the Notion API."""
        logger.debug("Fetching database for ID '%s'", database_id)
        block_url = f"https://api.notion.com/v1/databases/{database_id}/query"
        body = None if not cursor else {"start_cursor": cursor}

        try:
            res = requests.post(
                block_url,
                headers=self.headers,
                json=body,
                timeout=_NOTION_CALL_TIMEOUT,
            )
            res.raise_for_status()
            return res.json()
        except Exception as e:
            if hasattr(e, "response"):
                json_data = e.response.json()
                code = json_data.get("code")
                if code == "object_not_found" or (code == "validation_error" and "does not contain any data sources" in json_data.get("message", "")):
                    # Database isn't shared with integration
                    logger.error(
                        "Unable to access database with ID '%s'. This is likely due to the database not being shared with the Scrapalot integration.",
                        database_id,
                    )
                    return {"results": [], "next_cursor": None}
            logger.exception("Error fetching database: %s", e)
            raise

    @staticmethod
    def _properties_to_str(properties: dict[str, Any]) -> str:
        """Converts Notion properties to a string"""

        def _recurse_list_properties(inner_list: list[Any]) -> str | None:
            list_properties: list[str | None] = []
            for item in inner_list:
                if item and isinstance(item, dict):
                    list_properties.append(_recurse_properties(item))
                elif item and isinstance(item, list):
                    list_properties.append(_recurse_list_properties(item))
                else:
                    list_properties.append(str(item))
            return ", ".join([lp for lp in list_properties if lp is not None]) or None

        def _recurse_properties(inner_dict: dict[str, Any]) -> str | None:
            sub_inner_dict: Any = inner_dict
            while isinstance(sub_inner_dict, dict) and "type" in sub_inner_dict:
                type_name = sub_inner_dict["type"]
                sub_inner_dict = sub_inner_dict[type_name]

                # If the innermost layer is None, the value is not set
                if not sub_inner_dict:
                    return None

            if isinstance(sub_inner_dict, list):
                return _recurse_list_properties(sub_inner_dict)
            elif isinstance(sub_inner_dict, str):
                return sub_inner_dict
            elif isinstance(sub_inner_dict, dict):
                if "name" in sub_inner_dict:
                    return sub_inner_dict["name"]
                if "content" in sub_inner_dict:
                    return sub_inner_dict["content"]
                start = sub_inner_dict.get("start")
                end = sub_inner_dict.get("end")
                if start is not None:
                    if end is not None:
                        return f"{start} - {end}"
                    return start
                elif end is not None:
                    return f"Until {end}"

                if "id" in sub_inner_dict:
                    # This is not useful to index
                    logger.debug("Skipping Notion object id field property")
                    return None

            logger.debug("Unreadable property from innermost prop: %s", sub_inner_dict)
            return None

        result = ""
        for prop_name, prop in properties.items():
            if not prop or not isinstance(prop, dict):
                continue

            try:
                inner_value = _recurse_properties(prop)
            except Exception as e:
                logger.warning("Error recursing properties for %s: %s", prop_name, e)
                continue

            if inner_value:
                result += f"{prop_name}: {inner_value}\t"

        return result

    def _read_pages_from_database(self, database_id: str) -> tuple[list[NotionBlock], list[str]]:
        """Returns a list of top-level blocks and all page IDs in the database"""
        result_blocks: list[NotionBlock] = []
        result_pages: list[str] = []
        cursor = None

        while True:
            data = self._fetch_database(database_id, cursor)

            for result in data["results"]:
                obj_id = result["id"]
                obj_type = result["object"]
                text = self._properties_to_str(result.get("properties", {}))
                if text:
                    result_blocks.append(NotionBlock(id=obj_id, text=text, prefix="\n"))

                if self.recursive_index_enabled:
                    if obj_type == "page":
                        logger.debug("Found page with ID '%s' in database '%s'", obj_id, database_id)
                        result_pages.append(result["id"])
                    elif obj_type == "database":
                        logger.debug("Found database with ID '%s' in database '%s'", obj_id, database_id)
                        # The inner contents are ignored at this level
                        _, child_pages = self._read_pages_from_database(obj_id)
                        result_pages.extend(child_pages)

            if data["next_cursor"] is None:
                break

            cursor = data["next_cursor"]

        return result_blocks, result_pages

    def _read_blocks(self, base_block_id: str) -> tuple[list[NotionBlock], list[str]]:
        """Reads all child blocks for the specified block, returns a list of blocks and child page ids"""
        result_blocks: list[NotionBlock] = []
        child_pages: list[str] = []
        cursor = None

        while True:
            data = self._fetch_child_blocks(base_block_id, cursor)

            # This happens when a block is not shared with the integration
            if data is None:
                return result_blocks, child_pages

            for result in data["results"]:
                logger.debug("Found child block for block with ID '%s': %s", base_block_id, result)
                result_block_id = result["id"]
                result_type = result["type"]
                result_obj = result[result_type]

                # Skip unsupported block types
                if result_type in ["ai_block", "unsupported", "external_object_instance_page"]:
                    logger.warning(
                        "Skipping unsupported block type '%s' ('%s') for base block '%s'",
                        result_type,
                        result_block_id,
                        base_block_id,
                    )
                    continue

                cur_result_text_arr = []
                if "rich_text" in result_obj:
                    for rich_text in result_obj["rich_text"]:
                        # Skip if it doesn't have text object
                        if "text" in rich_text:
                            text = rich_text["text"]["content"]
                            cur_result_text_arr.append(text)

                if result["has_children"]:
                    if result_type == "child_page":
                        # Child pages will not be included at this top level
                        child_pages.append(result_block_id)
                    else:
                        logger.debug("Entering sub-block: %s", result_block_id)
                        subblocks, subblock_child_pages = self._read_blocks(result_block_id)
                        logger.debug("Finished sub-block: %s", result_block_id)
                        result_blocks.extend(subblocks)
                        child_pages.extend(subblock_child_pages)

                if result_type == "child_database":
                    inner_blocks, inner_child_pages = self._read_pages_from_database(result_block_id)
                    # A database on a page often looks like a table
                    result_blocks.extend(inner_blocks)

                    if self.recursive_index_enabled:
                        child_pages.extend(inner_child_pages)

                if cur_result_text_arr:
                    new_block = NotionBlock(
                        id=result_block_id,
                        text="\n".join(cur_result_text_arr),
                        prefix="\n",
                    )
                    result_blocks.append(new_block)

            if data["next_cursor"] is None:
                break

            cursor = data["next_cursor"]

        return result_blocks, child_pages

    @staticmethod
    def _read_page_title(page: NotionPage) -> str | None:
        """Extracts the title from a Notion page"""
        page_title = None
        if hasattr(page, "database_name") and page.database_name:
            return page.database_name

        for _, prop in page.properties.items():
            if prop["type"] == "title" and len(prop["title"]) > 0:
                page_title = " ".join([t["plain_text"] for t in prop["title"]]).strip()
                break

        return page_title

    def _read_pages(
        self,
        pages: list[NotionPage],
    ) -> Generator[Document, None, None]:
        """Reads pages for rich text content and generates Documents"""
        all_child_page_ids: list[str] = []

        for page in pages:
            if page.id in self.indexed_pages:
                logger.debug("Already indexed page with ID '%s'. Skipping.", page.id)
                continue

            logger.info("Reading page with ID '%s', with url %s", page.id, page.url)
            page_blocks, child_page_ids = self._read_blocks(page.id)
            all_child_page_ids.extend(child_page_ids)

            # Okay to mark here since there's no way for this to not succeed
            # without a critical failure
            self.indexed_pages.add(page.id)

            raw_page_title = self._read_page_title(page)
            page_title = raw_page_title or f"Untitled Page with ID {page.id}"

            if not page_blocks:
                if not raw_page_title:
                    logger.warning("No blocks OR title found for page with ID '%s'. Skipping.", page.id)
                    continue

                logger.debug("No blocks found for page with ID '%s'", page.id)
                text = page_title
                if page.properties:
                    text += "\n\n" + "\n".join([f"{key}: {value}" for key, value in page.properties.items()])
                sections = [
                    TextSection(
                        link=f"{page.url}",
                        text=text,
                    )
                ]
            else:
                sections = [
                    TextSection(
                        link=f"{page.url}#{block.id.replace('-', '')}",
                        text=block.prefix + block.text,
                    )
                    for block in page_blocks
                ]

            # Create metadata
            metadata = DocumentMetadata(
                source=ConnectorSource.NOTION,
                connector_id=self.connector_id,
                workspace_id=self.workspace_id,
                file_id=page.id,
                file_name=page_title,
                file_path=page.url,
                created_at=datetime.fromisoformat(page.created_time).astimezone(UTC),
                updated_at=datetime.fromisoformat(page.last_edited_time).astimezone(UTC),
                last_modified=datetime.fromisoformat(page.last_edited_time).astimezone(UTC),
                extra={"url": page.url},
            )

            yield Document(
                id=f"notion:{page.id}",
                sections=sections,
                source=ConnectorSource.NOTION,
                semantic_identifier=page_title,
                metadata=metadata,
                title=page_title,
                doc_updated_at=datetime.fromisoformat(page.last_edited_time).astimezone(UTC),
            )

        if self.recursive_index_enabled and all_child_page_ids:
            # Batch process child pages
            batch_size = self.batch_size or 10
            for i in range(0, len(all_child_page_ids), batch_size):
                child_page_batch_ids = all_child_page_ids[i : i + batch_size]
                child_page_batch = [self._fetch_page(page_id) for page_id in child_page_batch_ids if page_id not in self.indexed_pages]
                yield from self._read_pages(child_page_batch)

    @retry(tries=3, delay=1, backoff=2)
    def _search_notion(self, query_dict: dict[str, Any]) -> NotionSearchResponse:
        """Search for pages from a Notion database."""
        logger.debug("Searching for pages in Notion with query_dict: %s", query_dict)
        res = requests.post(
            "https://api.notion.com/v1/search",
            headers=self.headers,
            json=query_dict,
            timeout=_NOTION_CALL_TIMEOUT,
        )
        res.raise_for_status()
        return NotionSearchResponse(**res.json())

    @staticmethod
    def _filter_pages_by_time(
        pages: list[dict[str, Any]],
        start: SecondsSinceUnixEpoch,
        end: SecondsSinceUnixEpoch,
        filter_field: str = "last_edited_time",
    ) -> list[NotionPage]:
        """Filter out pages outside a time range."""
        filtered_pages: list[NotionPage] = []
        for page in pages:
            # Parse ISO 8601 timestamp and convert to UTC epoch time
            timestamp = page[filter_field].replace(".000Z", "+00:00")
            compare_time = datetime.fromisoformat(timestamp).timestamp()
            if start < compare_time <= end:
                filtered_pages.append(NotionPage(**page))
        return filtered_pages

    def _recursive_load(self) -> GenerateDocumentsOutput:
        """Recursively load pages from a root page."""
        if self.root_page_id is None or not self.recursive_index_enabled:
            raise RuntimeError("Recursive page lookup is not enabled, but we are trying to recursively load pages. This should never happen.")

        root_page_id = str(self.root_page_id)
        logger.info("Recursively loading pages from Notion based on root page with ID: %s", root_page_id)
        pages = [self._fetch_page(page_id=root_page_id)]

        # Batch the documents
        batch = []
        for doc in self._read_pages(pages):
            batch.append(doc)
            if len(batch) >= (self.batch_size or 10):
                yield batch
                batch = []
        if batch:
            yield batch

    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        """Applies integration token to headers"""
        token = credentials.get("notion_integration_token")
        if not token:
            raise ConnectorMissingCredentialError("Notion")

        self.headers["Authorization"] = f"Bearer {token}"
        return None

    def load_from_state(self) -> GenerateDocumentsOutput:
        """Loads all page data from a Notion workspace.

        Returns:
            Iterator yielding batches of documents.
        """
        # Recursive load if enabled
        if self.recursive_index_enabled and self.root_page_id:
            yield from self._recursive_load()
            return

        query_dict: dict[str, Any] = {
            "filter": {"property": "object", "value": "page"},
            "page_size": _NOTION_PAGE_SIZE,
        }

        while True:
            db_res = self._search_notion(query_dict)
            pages = [NotionPage(**page) for page in db_res.results]

            # Batch the documents
            batch = []
            for doc in self._read_pages(pages):
                batch.append(doc)
                if len(batch) >= (self.batch_size or 10):
                    yield batch
                    batch = []
            if batch:
                yield batch

            if db_res.has_more:
                query_dict["start_cursor"] = db_res.next_cursor
            else:
                break

    def poll_source(self, start: SecondsSinceUnixEpoch, end: SecondsSinceUnixEpoch) -> GenerateDocumentsOutput:
        """Uses the Notion search API to fetch updated pages within a time period."""
        # Recursive load if enabled
        if self.recursive_index_enabled and self.root_page_id:
            yield from self._recursive_load()
            return

        query_dict: dict[str, Any] = {
            "page_size": _NOTION_PAGE_SIZE,
            "sort": {"timestamp": "last_edited_time", "direction": "descending"},
            "filter": {"property": "object", "value": "page"},
        }

        while True:
            db_res = self._search_notion(query_dict)
            pages = self._filter_pages_by_time(db_res.results, start, end, filter_field="last_edited_time")

            if len(pages) > 0:
                # Batch the documents
                batch = []
                for doc in self._read_pages(pages):
                    batch.append(doc)
                    if len(batch) >= (self.batch_size or 10):
                        yield batch
                        batch = []
                if batch:
                    yield batch

                if db_res.has_more:
                    query_dict["start_cursor"] = db_res.next_cursor
                else:
                    break
            else:
                break

    def validate_connector_settings(self) -> None:
        """Validate Notion connector settings and credentials."""
        if not self.headers.get("Authorization"):
            raise ConnectorMissingCredentialError("Notion credentials not loaded.")

        try:
            # Perform a minimal search call to confirm accessibility
            if self.root_page_id:
                # If root_page_id is set, fetch the specific page
                res = requests.get(
                    f"https://api.notion.com/v1/pages/{self.root_page_id}",
                    headers=self.headers,
                    timeout=_NOTION_CALL_TIMEOUT,
                )
            else:
                # Perform a minimal search
                test_query = {
                    "filter": {"property": "object", "value": "page"},
                    "page_size": 1,
                }
                res = requests.post(
                    "https://api.notion.com/v1/search",
                    headers=self.headers,
                    json=test_query,
                    timeout=_NOTION_CALL_TIMEOUT,
                )
            res.raise_for_status()
            logger.info("Notion connector validation successful")

        except requests.exceptions.HTTPError as http_err:
            status_code = http_err.response.status_code if http_err.response else None

            if status_code == 401:
                raise ConnectorAuthError("Notion credential appears to be invalid or expired (HTTP 401).") from http_err
            elif status_code == 403:
                raise ConnectorAuthError("Your Notion token does not have sufficient permissions (HTTP 403).") from http_err
            elif status_code == 404:
                raise ConnectorValidationError("Notion resource not found or not shared with the integration (HTTP 404).") from http_err
            elif status_code == 429:
                raise ConnectorValidationError(
                    "Validation failed due to Notion rate-limits being exceeded (HTTP 429). Please try again later."
                ) from http_err
            else:
                raise ConnectorValidationError(f"Unexpected Notion HTTP error (status={status_code}): {http_err}") from http_err

        except Exception as exc:
            raise ConnectorValidationError(f"Unexpected error during Notion settings validation: {exc}") from exc
