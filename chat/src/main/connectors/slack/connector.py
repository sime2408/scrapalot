"""Slack connector for Scrapalot Chat.

Supports:
- OAuth authentication via Slack Bot Token
- Fetch messages from public and private channels
- Thread-aware message retrieval
- Message cleaning (removes user IDs, channel mentions, formatting)
- Incremental sync with checkpointing
"""

from collections.abc import Generator
from datetime import UTC, datetime
import re
from typing import Any

from pydantic import BaseModel
from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError

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
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

_SLACK_PAGE_SIZE = 200
_SLACK_TIMEOUT = 30


class SlackChannel(BaseModel):
    """Represents a Slack channel."""

    id: str
    name: str
    is_private: bool
    is_archived: bool
    is_member: bool
    created: int


class SlackMessage(BaseModel):
    """Represents a Slack message."""

    ts: str
    user: str | None = None
    text: str
    thread_ts: str | None = None
    type: str = "message"
    subtype: str | None = None


class SlackTextCleaner:
    """Utility to clean Slack-specific formatting from messages."""

    def __init__(self, client: WebClient):
        self.client = client
        self._user_cache: dict[str, str] = {}

    def _get_user_name(self, user_id: str) -> str:
        """Fetch username from user ID with caching."""
        if user_id not in self._user_cache:
            try:
                response = self.client.users_info(user=user_id)
                user_data = response.get("user", {})
                profile = user_data.get("profile", {})
                # Prefer display name, fallback to real name
                name = profile.get("display_name") or profile.get("real_name") or user_id
                self._user_cache[user_id] = name
            except SlackApiError as e:
                logger.warning("Error fetching user %s: %s", user_id, e)
                self._user_cache[user_id] = user_id

        return self._user_cache[user_id]

    def clean(self, text: str) -> str:
        """Clean Slack formatting from message text."""
        # Replace user mentions: <@U123456> -> @username
        user_ids = re.findall(r"<@(.*?)>", text)
        for user_id in user_ids:
            username = self._get_user_name(user_id)
            text = text.replace(f"<@{user_id}>", f"@{username}")

        # Replace channel mentions: <#C123456|channel-name> -> #channel-name
        text = re.sub(r"<#.*?\|(.*?)>", r"#\1", text)

        # Replace special mentions
        text = text.replace("<!channel>", "@channel")
        text = text.replace("<!here>", "@here")
        text = text.replace("<!everyone>", "@everyone")

        # Remove other special formatting
        text = re.sub(r"<!([^|]+)\|([^>]+)>", r"\2", text)

        return text


@register_connector(ConnectorSource.SLACK)
class SlackConnector(LoadConnector, PollConnector):
    """Slack connector that fetches messages and threads from Slack channels.

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
        self.channels = config.get("channels", [])  # List of channel names to sync
        self.include_private = config.get("include_private", True)
        self.batch_size = config.get("batch_size", 50)

        self.client: WebClient | None = None
        self.text_cleaner: SlackTextCleaner | None = None

        # Track processed threads
        self.seen_threads: set[str] = set()

    def load_credentials(self, credentials: dict[str, Any]) -> dict[str, Any] | None:
        """Load and validate Slack bot token."""
        bot_token = credentials.get("bot_token")

        if not bot_token:
            raise ConnectorMissingCredentialError("Slack bot token is required")

        try:
            client = WebClient(token=str(bot_token), timeout=_SLACK_TIMEOUT)
            self.client = client
            self.text_cleaner = SlackTextCleaner(client)

            # Test authentication
            response = client.auth_test()
            if not response.get("ok"):
                raise ConnectorAuthError(f"Slack auth failed: {response.get('error')}")

            logger.info("Successfully authenticated with Slack workspace: %s", response.get("team"))
            return credentials

        except SlackApiError as e:
            raise ConnectorAuthError(f"Slack authentication failed: {e}") from e
        except Exception as e:
            raise ConnectorError(f"Error initializing Slack client: {e}") from e

    def _get_channels(self) -> list[SlackChannel]:
        """Fetch all accessible channels."""
        if not self.client:
            raise ConnectorMissingCredentialError("Slack")

        channels = []
        try:
            # Fetch public channels
            cursor = None
            while True:
                response = self.client.conversations_list(
                    exclude_archived=True,
                    types="public_channel",
                    limit=_SLACK_PAGE_SIZE,
                    cursor=cursor,
                )

                for channel_data in response.get("channels", []):
                    channels.append(
                        SlackChannel(
                            **{
                                "id": channel_data["id"],
                                "name": channel_data["name"],
                                "is_private": channel_data.get("is_private", False),
                                "is_archived": channel_data.get("is_archived", False),
                                "is_member": channel_data.get("is_member", False),
                                "created": channel_data.get("created", 0),
                            }
                        )
                    )

                cursor = response.get("response_metadata", {}).get("next_cursor")
                if not cursor:
                    break

            # Fetch private channels if enabled
            if self.include_private:
                cursor = None
                while True:
                    try:
                        response = self.client.conversations_list(
                            exclude_archived=True,
                            types="private_channel",
                            limit=_SLACK_PAGE_SIZE,
                            cursor=cursor,
                        )

                        for channel_data in response.get("channels", []):
                            channels.append(
                                SlackChannel(
                                    **{
                                        "id": channel_data["id"],
                                        "name": channel_data["name"],
                                        "is_private": True,
                                        "is_archived": channel_data.get("is_archived", False),
                                        "is_member": channel_data.get("is_member", False),
                                        "created": channel_data.get("created", 0),
                                    }
                                )
                            )

                        cursor = response.get("response_metadata", {}).get("next_cursor")
                        if not cursor:
                            break

                    except SlackApiError as e:
                        logger.warning("Unable to fetch private channels: %s", e)
                        break

            # Filter channels if specific channels are configured
            if self.channels:
                filtered = [c for c in channels if c.name in self.channels]
                logger.info("Filtered %s channels to %s based on config", len(channels), len(filtered))
                return filtered

            logger.info("Found %s accessible channels", len(channels))
            return channels

        except SlackApiError as e:
            raise ConnectorError(f"Error fetching channels: {e}") from e

    def _get_channel_messages(
        self,
        channel: SlackChannel,
        oldest: float | None = None,
        latest: float | None = None,
    ) -> list[SlackMessage]:
        """Fetch messages from a channel."""
        if not self.client:
            raise ConnectorMissingCredentialError("Slack")

        messages = []

        # Join channel if not a member
        if not channel.is_member:
            try:
                self.client.conversations_join(
                    channel=channel.id,
                    is_private=channel.is_private,
                )
                logger.info("Joined channel: %s", channel.name)
            except SlackApiError as e:
                logger.warning("Unable to join channel %s: %s", channel.name, e)
                return messages

        try:
            cursor = None
            while True:
                response = self.client.conversations_history(
                    channel=channel.id,
                    oldest=str(oldest) if oldest else None,
                    latest=str(latest) if latest else None,
                    limit=_SLACK_PAGE_SIZE,
                    cursor=cursor,
                )

                for msg_data in response.get("messages", []):
                    # Skip bot messages and system messages
                    if msg_data.get("bot_id") or msg_data.get("subtype") in ["channel_join", "channel_leave"]:
                        continue

                    messages.append(
                        SlackMessage(
                            **{
                                "ts": msg_data["ts"],
                                "user": msg_data.get("user"),
                                "text": msg_data.get("text", ""),
                                "thread_ts": msg_data.get("thread_ts"),
                                "type": msg_data.get("type", "message"),
                                "subtype": msg_data.get("subtype"),
                            }
                        )
                    )

                cursor = response.get("response_metadata", {}).get("next_cursor")
                if not cursor:
                    break

            logger.info("Fetched %s messages from channel: %s", len(messages), channel.name)
            return messages

        except SlackApiError as e:
            raise ConnectorError(f"Error fetching messages from {channel.name}: {e}") from e

    def _get_thread_messages(self, channel_id: str, thread_ts: str) -> list[SlackMessage]:
        """Fetch all messages in a thread."""
        if not self.client:
            raise ConnectorMissingCredentialError("Slack")

        messages = []
        try:
            cursor = None
            while True:
                response = self.client.conversations_replies(
                    channel=channel_id,
                    ts=thread_ts,
                    limit=_SLACK_PAGE_SIZE,
                    cursor=cursor,
                )

                for msg_data in response.get("messages", []):
                    # Skip bot messages
                    if msg_data.get("bot_id"):
                        continue

                    messages.append(
                        SlackMessage(
                            **{
                                "ts": msg_data["ts"],
                                "user": msg_data.get("user"),
                                "text": msg_data.get("text", ""),
                                "thread_ts": msg_data.get("thread_ts"),
                                "type": msg_data.get("type", "message"),
                                "subtype": msg_data.get("subtype"),
                            }
                        )
                    )

                cursor = response.get("response_metadata", {}).get("next_cursor")
                if not cursor:
                    break

            return messages

        except SlackApiError as e:
            logger.warning("Error fetching thread %s: %s", thread_ts, e)
            return []

    def _build_message_link(self, channel_id: str, message_ts: str, thread_ts: str | None = None) -> str:
        """Build Slack message permalink."""
        if not self.client:
            return ""

        try:
            # Get workspace URL
            auth_response = self.client.auth_test()
            base_url = auth_response.get("url", "").rstrip("/")

            # Remove dot from timestamp for URL
            ts_no_dot = message_ts.replace(".", "")

            link = f"{base_url}/archives/{channel_id}/p{ts_no_dot}"
            if thread_ts:
                link += f"?thread_ts={thread_ts}"

            return link
        except Exception as e:
            logger.warning("Error building message link: %s", e)
            return f"slack://channel/{channel_id}/message/{message_ts}"

    def _message_to_document(
        self,
        channel: SlackChannel,
        messages: list[SlackMessage],
    ) -> Document:
        """Convert Slack messages (thread or single message) to a Document."""
        if not self.text_cleaner:
            raise ConnectorError("Text cleaner not initialized")

        first_message = messages[0]
        thread_ts = first_message.thread_ts or first_message.ts

        # Build document sections from messages
        sections = []
        for msg in messages:
            cleaned_text = self.text_cleaner.clean(msg.text)
            link = self._build_message_link(channel.id, msg.ts, msg.thread_ts)
            sections.append(
                TextSection(
                    text=cleaned_text,
                    link=link,
                )
            )

        # Generate semantic identifier
        first_text = self.text_cleaner.clean(first_message.text)
        snippet = first_text[:50] + "..." if len(first_text) > 50 else first_text
        semantic_id = f"#{channel.name}: {snippet}".replace("\n", " ")

        # Get update time from last message
        last_ts = float(messages[-1].ts)
        doc_updated_at = datetime.fromtimestamp(last_ts, tz=UTC)

        return Document(
            id=f"{channel.id}_{thread_ts}",
            sections=sections,
            source=ConnectorSource.SLACK,
            semantic_identifier=semantic_id,
            doc_updated_at=doc_updated_at,
            metadata=DocumentMetadata(
                connector_id=self.connector_id,
                workspace_id=self.workspace_id,
                file_name=semantic_id,
                file_id=thread_ts,
                file_path=f"#{channel.name}",
                file_type="slack_thread" if len(messages) > 1 else "slack_message",
                last_modified=doc_updated_at,
            ),
        )

    def _process_channel(
        self,
        channel: SlackChannel,
        oldest: float | None = None,
        latest: float | None = None,
    ) -> Generator[list[Document], None, None]:
        """Process all messages from a channel and yield documents."""
        messages = self._get_channel_messages(channel, oldest, latest)

        documents = []
        for message in messages:
            # If message is part of a thread, fetch the entire thread
            if message.thread_ts and message.thread_ts not in self.seen_threads:
                thread_messages = self._get_thread_messages(channel.id, message.thread_ts)
                if thread_messages:
                    doc = self._message_to_document(channel, thread_messages)
                    documents.append(doc)
                    self.seen_threads.add(message.thread_ts)

            # If message is not part of a thread, create a single-message document
            elif not message.thread_ts:
                doc = self._message_to_document(channel, [message])
                documents.append(doc)

            # Yield in batches
            if len(documents) >= self.batch_size:
                yield documents
                documents = []

        # Yield remaining documents
        if documents:
            yield documents

    def load_from_state(self) -> GenerateDocumentsOutput:
        """Load all messages from all accessible channels."""
        if not self.client:
            raise ConnectorMissingCredentialError("Slack")

        logger.info("Starting Slack connector load_from_state")

        channels = self._get_channels()

        for channel in channels:
            logger.info("Processing channel: %s", channel.name)
            try:
                yield from self._process_channel(channel)
            except Exception as e:
                logger.exception("Error processing channel %s: %s", channel.name, e)
                continue

        logger.info("Completed Slack connector load_from_state")

    def poll_source(
        self,
        start: SecondsSinceUnixEpoch,
        end: SecondsSinceUnixEpoch,
    ) -> GenerateDocumentsOutput:
        """Poll for messages updated between start and end time."""
        if not self.client:
            raise ConnectorMissingCredentialError("Slack")

        logger.info("Starting Slack connector poll_source from %s to %s", start, end)

        channels = self._get_channels()

        for channel in channels:
            logger.info("Polling channel: %s", channel.name)
            try:
                yield from self._process_channel(channel, oldest=start, latest=end)
            except Exception as e:
                logger.exception("Error polling channel %s: %s", channel.name, e)
                continue

        logger.info("Completed Slack connector poll_source")
