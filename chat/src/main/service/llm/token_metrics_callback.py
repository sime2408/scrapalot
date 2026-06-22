"""
LangChain callback handler for automatic token metrics tracking.
Integrates with the TokenMetricsTracker to store metrics in message_metadata.
"""

import logging
import time
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.outputs import LLMResult
from sqlalchemy.orm import Session

from src.main.utils.llm.usage_tracker import increment_token_usage

from .token_metrics import TokenMetricsTracker

logger = logging.getLogger(__name__)

# Per-million-token pricing (input, output) for cost estimation when no callback is available
_MODEL_PRICING: dict[str, tuple[float, float]] = {
    "gpt-4o": (2.50, 10.00),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4-turbo": (10.00, 30.00),
    "gpt-4": (30.00, 60.00),
    "gpt-3.5-turbo": (0.50, 1.50),
    "o1": (15.00, 60.00),
    "o1-mini": (3.00, 12.00),
    "o3-mini": (1.10, 4.40),
    "claude-3-5-sonnet": (3.00, 15.00),
    "claude-3-5-haiku": (0.80, 4.00),
    "claude-3-opus": (15.00, 75.00),
    "claude-sonnet-4": (3.00, 15.00),
    "claude-haiku-4": (0.80, 4.00),
    "gemini-2.0-flash": (0.10, 0.40),
    "gemini-1.5-pro": (1.25, 5.00),
    "gemini-1.5-flash": (0.075, 0.30),
    "deepseek-chat": (0.27, 1.10),
    "deepseek-reasoner": (0.55, 2.19),
}


def _estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate cost from known model pricing. Returns 0.0 for unknown models."""
    model_lower = (model or "").lower()
    for name, (inp_price, out_price) in _MODEL_PRICING.items():
        if name in model_lower:
            return (input_tokens * inp_price + output_tokens * out_price) / 1_000_000
    return 0.0


class TokenMetricsCallback(BaseCallbackHandler):
    """
    LangChain callback handler that tracks token usage and stores in message_metadata.
    """

    def __init__(
        self,
        metrics_tracker: TokenMetricsTracker,
        db: Session,
        provider: str,
        model: str,
        message_id: str | None = None,
        user_id: str | None = None,
        is_system_provider: bool = True,
    ):
        """
        Initialize the callback handler.
        """
        super().__init__()
        self.metrics_tracker = metrics_tracker
        self.db = db
        self.provider = provider
        self.model = model
        self.message_id = message_id
        self.user_id = user_id
        self.is_system_provider = is_system_provider
        self.start_time: float | None = None
        self.first_token_time: float | None = None
        self.real_cost_usd: float | None = None  # Store real cost from LangChain
        self._openai_callback = None  # Will be set by LLM factory for OpenAI providers
        self.last_metrics: Any | None = None  # Populated after on_llm_end for stream_end packet

    def set_message_id(self, message_id: str) -> None:
        """Set the message ID for storing metrics."""
        self.message_id = message_id

    def on_llm_start(self, serialized: dict[str, Any], prompts: list[str], **kwargs: Any) -> None:
        """Called when LLM starts running."""
        self.start_time = time.time()
        logger.debug("LLM request started: %s/%s", self.provider, self.model)

    def on_llm_new_token(self, token: str, **kwargs: Any) -> None:
        """Called on new token during streaming."""
        if self.first_token_time is None:
            self.first_token_time = time.time()

    def on_llm_end(self, response: LLMResult, **kwargs: Any) -> None:
        """Called when LLM ends running."""
        if self.start_time is None:
            logger.warning("LLM end called without start time")
            return

        try:
            latency_seconds = time.time() - self.start_time

            # Log the full LLM response at DEBUG level
            if logger.isEnabledFor(logging.DEBUG):
                try:
                    # Extract the actual text response
                    if response.generations and len(response.generations) > 0:
                        generation = response.generations[0][0]
                        response_text = generation.text if hasattr(generation, "text") else str(generation)
                        logger.debug(
                            "LLM Response [%s/%s]:\n%s\n%s\n%s",
                            self.provider,
                            self.model,
                            "=" * 80,
                            response_text,
                            "=" * 80,
                        )
                except Exception as e:
                    logger.debug("Could not extract LLM response text: %s", e)

            # Extract token usage from response
            input_tokens, output_tokens = self._extract_token_usage(response)

            if input_tokens > 0 or output_tokens > 0:
                # Calculate latency
                latency_ms = latency_seconds * 1000

                # Calculate time to first token
                time_to_first_token = None
                if self.first_token_time and self.start_time:
                    time_to_first_token = (self.first_token_time - self.start_time) * 1000

                # Extract real cost from OpenAI callback if available
                if self._openai_callback:
                    cost_usd = self._openai_callback.total_cost
                    logger.info("Using OpenAI callback cost: $%s", cost_usd)
                elif self.real_cost_usd:
                    cost_usd = self.real_cost_usd
                    logger.info("Using LangChain real cost: $%s", cost_usd)
                else:
                    cost_usd = _estimate_cost(self.model, input_tokens, output_tokens)
                    if cost_usd > 0:
                        logger.info("Estimated cost from pricing table: $%s", cost_usd)

                # Create metrics object (always set last_metrics for stream_end packet)
                metrics = self.metrics_tracker.create_metrics(
                    provider=self.provider,
                    model=self.model,
                    input_tokens=input_tokens,
                    output_tokens=output_tokens,
                    latency=latency_seconds,
                    time_to_first_token=time_to_first_token,
                )
                metrics.cost_usd = cost_usd
                self.last_metrics = metrics

                # Store in message metadata if message_id is available
                if self.message_id:
                    import asyncio

                    try:
                        loop = asyncio.get_event_loop()
                        if loop.is_running():
                            loop.create_task(self.metrics_tracker.update_message_metadata(self.db, message_id=self.message_id, metrics=metrics))
                        else:
                            loop.run_until_complete(
                                self.metrics_tracker.update_message_metadata(self.db, message_id=self.message_id, metrics=metrics)
                            )
                    except RuntimeError:
                        asyncio.run(self.metrics_tracker.update_message_metadata(self.db, message_id=self.message_id, metrics=metrics))

                cost_source = "LangChain" if self.real_cost_usd is not None else "estimated"
                logger.info(
                    "Token metrics for message %s: %s input, %s output tokens, $%.6f cost (%s), %sms latency",
                    self.message_id or "(stream_end only)",
                    input_tokens,
                    output_tokens,
                    cost_usd,
                    cost_source,
                    latency_ms,
                )

                # Increment user-level token usage for quota tracking
                try:
                    if self.user_id:
                        increment_token_usage(
                            self.db,
                            user_id=self.user_id,
                            input_tokens=input_tokens,
                            output_tokens=output_tokens,
                            cost_usd=cost_usd,
                            is_system_provider=self.is_system_provider,
                        )
                        logger.debug("Incremented user-level token usage for user %s", self.user_id)
                except Exception as user_usage_error:
                    logger.error("Error incrementing user token usage: %s", user_usage_error)

        except Exception as e:
            logger.error("Error updating token metrics: %s", e)

    def on_llm_error(self, error: Exception | KeyboardInterrupt, **kwargs: Any) -> None:
        """Called when LLM errors."""
        if self.start_time is not None:
            latency = time.time() - self.start_time
            logger.warning("LLM request failed: %s/%s after %.2fs - %s", self.provider, self.model, latency, error)

    def _extract_token_usage(self, response: LLMResult) -> tuple[int, int]:
        """
        Extract token usage from LLM response.

        Args:
            response: LLM response object

        Returns:
            Tuple of (input_tokens, output_tokens)
        """
        input_tokens = 0
        output_tokens = 0

        try:
            # Check for usage in llm_output (OpenAI, Anthropic)
            if hasattr(response, "llm_output") and response.llm_output:
                usage = response.llm_output.get("usage", {})
                if usage:
                    input_tokens = usage.get("prompt_tokens", 0)
                    output_tokens = usage.get("completion_tokens", 0)

                    # Alternative field names
                    if input_tokens == 0:
                        input_tokens = usage.get("input_tokens", 0)
                    if output_tokens == 0:
                        output_tokens = usage.get("output_tokens", 0)

            # Check for usage in generations (some providers)
            if input_tokens == 0 and output_tokens == 0 and hasattr(response, "generations") and response.generations:
                for generation_list in response.generations:
                    for generation in generation_list:
                        if hasattr(generation, "generation_info") and generation.generation_info:
                            usage = generation.generation_info.get("usage", {})
                            if usage:
                                input_tokens += usage.get("prompt_tokens", 0)
                                output_tokens += usage.get("completion_tokens", 0)

                                # Alternative field names
                                if input_tokens == 0:
                                    input_tokens += usage.get("input_tokens", 0)
                                if output_tokens == 0:
                                    output_tokens += usage.get("output_tokens", 0)

            # Check for usage_metadata on generation message (LangChain streaming with stream_usage=True)
            if input_tokens == 0 and output_tokens == 0 and hasattr(response, "generations") and response.generations:
                for generation_list in response.generations:
                    for generation in generation_list:
                        msg = getattr(generation, "message", None)
                        if msg and hasattr(msg, "usage_metadata") and msg.usage_metadata:
                            um = msg.usage_metadata
                            input_tokens = (
                                getattr(um, "input_tokens", 0) or um.get("input_tokens", 0)
                                if isinstance(um, dict)
                                else getattr(um, "input_tokens", 0)
                            )
                            output_tokens = (
                                getattr(um, "output_tokens", 0) or um.get("output_tokens", 0)
                                if isinstance(um, dict)
                                else getattr(um, "output_tokens", 0)
                            )
                            if input_tokens > 0 or output_tokens > 0:
                                break
                    if input_tokens > 0 or output_tokens > 0:
                        break

            # Provider-specific extraction
            if input_tokens == 0 and output_tokens == 0:
                input_tokens, output_tokens = self._extract_provider_specific_usage(response)

            # Fallback: estimate from response text length when no usage data available
            if input_tokens == 0 and output_tokens == 0 and hasattr(response, "generations") and response.generations:
                total_text = ""
                for generation_list in response.generations:
                    for generation in generation_list:
                        total_text += getattr(generation, "text", "")
                if total_text:
                    output_tokens = max(1, len(total_text) // 4)
                    logger.debug("Estimated output tokens from text length: %d", output_tokens)

        except Exception as e:
            logger.error("Error extracting token usage: %s", e)

        return input_tokens, output_tokens

    def _extract_provider_specific_usage(self, response: LLMResult) -> tuple[int, int]:
        """
        Extract token usage using provider-specific methods.

        Args:
            response: LLM response object

        Returns:
            Tuple of (input_tokens, output_tokens)
        """
        input_tokens = 0
        output_tokens = 0

        try:
            if self.provider.lower() == "openrouter":
                # OpenRouter includes usage in response metadata
                if hasattr(response, "llm_output") and response.llm_output:
                    usage = response.llm_output.get("usage", {})
                    input_tokens = usage.get("prompt_tokens", 0)
                    output_tokens = usage.get("completion_tokens", 0)

            elif self.provider.lower() == "anthropic":
                # Anthropic usage extraction
                if hasattr(response, "llm_output") and response.llm_output:
                    usage = response.llm_output.get("usage", {})
                    input_tokens = usage.get("input_tokens", 0)
                    output_tokens = usage.get("output_tokens", 0)

            elif self.provider.lower() == "google":
                # Google/Gemini usage extraction
                if hasattr(response, "llm_output") and response.llm_output:
                    usage = response.llm_output.get("usage_metadata", {})
                    input_tokens = usage.get("prompt_token_count", 0)
                    output_tokens = usage.get("candidates_token_count", 0)

            elif self.provider.lower() == "ollama":
                # Ollama doesn't provide token counts by default
                # We'll estimate based on text length
                if hasattr(response, "generations") and response.generations:
                    total_text = ""
                    for generation_list in response.generations:
                        for generation in generation_list:
                            total_text += generation.text

                    # Rough estimation: ~4 characters per token
                    output_tokens = len(total_text) // 4
                    input_tokens = 0  # Can't estimate input without prompt

        except Exception as e:
            logger.error("Error in provider-specific usage extraction: %s", e)

        return input_tokens, output_tokens


def extract_token_metrics_from_llm(llm) -> dict:
    """Extract token metrics from an LLM instance's TokenMetricsCallback.

    Returns a dict with stream_end-compatible fields, or empty dict if no metrics.
    """
    if not hasattr(llm, "callbacks") or not llm.callbacks:
        return {}
    for cb in llm.callbacks:
        if isinstance(cb, TokenMetricsCallback) and cb.last_metrics is not None:
            m = cb.last_metrics
            # noinspection PyUnresolvedReferences
            return {
                "input_tokens": m.input_tokens,
                "output_tokens": m.output_tokens,
                "total_tokens": m.total_tokens,
                "tokens_per_second": m.tokens_per_second,
                "cost_usd": m.cost_usd,
                "latency_ms": m.latency_ms,
                "provider": m.provider,
                "model": m.model,
            }
    return {}
