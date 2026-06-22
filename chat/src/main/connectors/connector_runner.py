"""
Connector Runner

Wraps connector execution with batching, error handling, and progress tracking.
"""

from collections.abc import Generator
from datetime import UTC, datetime
from typing import Any

from src.main.connectors.exceptions import ConnectorError
from src.main.connectors.interfaces import BaseConnector
from src.main.connectors.models import Document
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class ConnectorRunner:
    """
    Handles connector execution with:
    - Batching of documents
    - Exception handling and logging
    - Progress tracking
    - Rate limiting integration
    """

    def __init__(
        self,
        connector: BaseConnector,
        batch_size: int = 50,
        start_time: datetime | None = None,
        end_time: datetime | None = None,
    ):
        """
        Initialize connector runner.

        Args:
            connector: The connector instance to run
            batch_size: Number of documents per batch
            start_time: Start time for incremental sync (optional)
            end_time: End time for incremental sync (optional)
        """
        self.connector = connector
        self.batch_size = batch_size
        self.start_time = start_time
        self.end_time = end_time

        self.total_docs_fetched = 0
        self.total_failures = 0
        self.start_run_time = datetime.now(UTC)

    def run(self) -> Generator[list[Document], None, None]:
        """
        Run the connector and yield batches of documents.

        Yields:
            Batches of Document objects

        Raises:
            ConnectorError: If connector fails critically
        """
        logger.info(
            "Starting connector run: connector_id=%s source=%s batch_size=%s",
            self.connector.connector_id,
            self.connector.__class__.__name__,
            self.batch_size,
        )

        try:
            # Fetch documents from connector
            # noinspection PyUnresolvedReferences
            documents_generator = self.connector.fetch_documents(start_time=self.start_time, end_time=self.end_time)

            # Batch documents
            batch: list[Document] = []

            for document in documents_generator:
                try:
                    # Validate document
                    if not document or not document.id:
                        logger.warning("Skipping invalid document (no ID)")
                        self.total_failures += 1
                        continue

                    batch.append(document)
                    self.total_docs_fetched += 1

                    # Yield batch when full
                    if len(batch) >= self.batch_size:
                        logger.debug("Yielding batch of %s documents", len(batch))
                        yield batch
                        batch = []

                except Exception as e:
                    logger.exception("Error processing document: %s", e)
                    self.total_failures += 1

                    # Create failure record

                    # Continue with next document
                    continue

            # Yield remaining documents
            if batch:
                logger.debug("Yielding final batch of %s documents", len(batch))
                yield batch

            # Log summary
            elapsed = (datetime.now(UTC) - self.start_run_time).total_seconds()
            logger.info(
                "Connector run completed: connector_id=%s total_docs=%s failures=%s elapsed=%ss",
                self.connector.connector_id,
                self.total_docs_fetched,
                self.total_failures,
                elapsed,
            )

        except Exception as e:
            logger.exception("Connector run failed: connector_id=%s error=%s", self.connector.connector_id, str(e))
            raise ConnectorError(f"Connector execution failed: {e!s}") from e

    def get_stats(self) -> dict[str, Any]:
        """
        Get connector run statistics.

        Returns:
            Dictionary with run statistics
        """
        elapsed = (datetime.now(UTC) - self.start_run_time).total_seconds()

        return {
            "connector_id": self.connector.connector_id,
            "source": self.connector.__class__.__name__,
            "total_docs_fetched": self.total_docs_fetched,
            "total_failures": self.total_failures,
            "elapsed_seconds": elapsed,
            "docs_per_second": self.total_docs_fetched / elapsed if elapsed > 0 else 0,
            "success_rate": ((self.total_docs_fetched - self.total_failures) / self.total_docs_fetched if self.total_docs_fetched > 0 else 0),
        }


def run_connector_with_rate_limiting(
    connector: BaseConnector,
    batch_size: int = 50,
    start_time: datetime | None = None,
    end_time: datetime | None = None,
) -> Generator[list[Document], None, None]:
    """
    Run connector with automatic rate limiting.

    This is a convenience function that wraps ConnectorRunner
    and applies rate limiting based on connector type.

    Args:
        connector: The connector instance
        batch_size: Documents per batch
        start_time: Start time for incremental sync
        end_time: End time for incremental sync

    Yields:
        Batches of documents
    """
    from src.main.background.rate_limiter import ConnectorRateLimiter

    # Get connector type for rate limiting
    connector_type = connector.source.value if hasattr(connector, "source") else "unknown"

    # Create runner
    runner = ConnectorRunner(connector=connector, batch_size=batch_size, start_time=start_time, end_time=end_time)

    # Run with rate limiting
    for batch in runner.run():
        # Apply rate limiting before yielding batch
        if not ConnectorRateLimiter.acquire_for_connector(connector_type, tokens=len(batch)):
            logger.warning("Rate limit exceeded for %s, waiting...", connector_type)
            # Rate limiter will block until tokens available
            ConnectorRateLimiter.acquire_for_connector(connector_type, tokens=len(batch), block=True)

        yield batch
