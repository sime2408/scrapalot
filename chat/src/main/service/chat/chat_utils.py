"""
Chat Controller Utilities

Shared helper functions for chat handlers.
"""

from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
import json
from uuid import UUID

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


@dataclass
class StreamingResponseState:
    """State container for streaming response accumulation."""

    full_response: str = ""
    received_stream_end: bool = False
    packet_types_seen: set[str] = field(default_factory=set)


async def accumulate_streaming_response(
    packet_generator: AsyncGenerator[str, None],
    content_packet_types: tuple[str, ...] = ("message_delta", "bot_answer"),
) -> AsyncGenerator[tuple[str, StreamingResponseState], None]:
    """
    Wrap a packet generator to accumulate response content and track stream state.

    This utility extracts the repeated pattern of:
    1. Yielding packets to the client
    2. Tracking stream_end packets
    3. Accumulating content from message_delta/bot_answer packets

    Args:
        packet_generator: Async generator yielding JSON packet strings
        content_packet_types: Tuple of packet types to accumulate content from

    Yields:
        Tuple of (packet_string, state) where state contains accumulated response

    Example:
        state = StreamingResponseState()
        async for packet, state in accumulate_streaming_response(handler(...)):
            yield packet
        # After loop: state.full_response contains accumulated content
    """
    state = StreamingResponseState()

    async for packet in packet_generator:
        # Parse packet to track state
        try:
            if isinstance(packet, str):
                packet_data = json.loads(packet)
                # Handle both nested format {"obj": {"type": ...}} and flat format {"type": ...}
                packet_type = packet_data.get("obj", {}).get("type") if "obj" in packet_data else packet_data.get("type")

                if packet_type:
                    state.packet_types_seen.add(packet_type)

                    if packet_type == "stream_end":
                        state.received_stream_end = True

                    if packet_type in content_packet_types:
                        # Extract content from nested or flat format
                        content = packet_data.get("obj", packet_data).get("content", "")
                        state.full_response += content

        except (json.JSONDecodeError, KeyError, TypeError, AttributeError):
            # Invalid packet format, continue without tracking
            pass

        yield packet, state


def update_assistant_message_with_error(
    assistant_message_id: UUID,
    error_message: str,
) -> None:
    """
    Log an assistant message error. Errors are delivered to the UI via stream packets;
    the Kotlin backend owns the messages table, so no DB update is needed here.

    Args:
        assistant_message_id: ID of the assistant message
        error_message: User-friendly error message
    """
    logger.info(
        "Assistant message %s error (delivered via stream): %s",
        assistant_message_id,
        error_message[:100],
    )
