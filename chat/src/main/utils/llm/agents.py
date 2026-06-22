"""
Comprehensive Agent Utilities Module

This module consolidates all agent-related utilities into a single cohesive module,
eliminating code duplication and circular dependencies across agent implementations.

Merged from:
- agent_execution_utils.py - Agent execution patterns and loops
- agent_streaming_utils.py - Streaming callbacks and tool execution
- agent_tool_utils.py - Tool execution utilities
- agent_utils.py - Agent chain creation utilities
"""

import asyncio
from collections.abc import AsyncIterator, Callable
import json
from typing import Any

from langchain_core.agents import AgentActionMessageLog, AgentFinish
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_core.output_parsers import BaseOutputParser
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_openai import ChatOpenAI

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# =============================================================================
# LangChain 1.x COMPATIBILITY - OpenAI Tools Agent Utilities
# =============================================================================
# These were removed in LangChain 1.2.0 (previously in langchain.agents.output_parsers.openai_tools
# and langchain.agents.format_scratchpad.openai_tools). Reimplemented here using langchain_core.


class OpenAIToolsAgentOutputParser(BaseOutputParser):
    """Parse AIMessage with tool_calls into AgentAction/AgentFinish objects.

    Replacement for the removed langchain.agents.output_parsers.openai_tools.OpenAIToolsAgentOutputParser.
    Extends BaseOutputParser so it is a valid LangChain Runnable for LCEL chains.
    """

    def parse_result(self, result, *, partial: bool = False):
        if not result:
            return AgentFinish(return_values={"output": ""}, log="")

        # noinspection PyUnresolvedReferences
        message = result[0].message
        if not isinstance(message, AIMessage):
            return AgentFinish(return_values={"output": str(message.content)}, log=str(message.content))

        if message.tool_calls:
            actions = []
            for tool_call in message.tool_calls:
                # noinspection PyArgumentList
                actions.append(
                    AgentActionMessageLog(
                        tool=tool_call["name"],
                        tool_input=tool_call.get("args", {}),
                        log=f"\nInvoking: `{tool_call['name']}` with `{tool_call.get('args', {})}`\n",
                        message_log=[message],
                    )
                )
            return actions

        return AgentFinish(
            return_values={"output": message.content or ""},
            log=str(message.content or ""),
        )

    def parse(self, text: str):
        raise ValueError("Can only parse message results, not raw text")

    @property
    def _type(self) -> str:
        return "openai_tools_agent_output_parser"


def format_to_openai_tool_messages(intermediate_steps):
    """Convert intermediate agent steps to OpenAI tool message format.

    Replacement for the removed langchain.agents.format_scratchpad.openai_tools.format_to_openai_tool_messages.

    Accepts either:
    - Legacy format: list of (AgentAction, observation_str) tuples
    - Message format: flat list of AIMessage/ToolMessage objects (from execute_and_update_scratchpad)
    """
    if not intermediate_steps:
        return []

    # If the scratchpad is already a flat list of message objects, return as-is
    first = intermediate_steps[0]
    if isinstance(first, (AIMessage, ToolMessage)):
        return list(intermediate_steps)

    messages = []
    for agent_action, observation in intermediate_steps:
        if isinstance(agent_action, AgentActionMessageLog):
            messages.extend(agent_action.message_log)
        else:
            messages.append(
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": agent_action.tool,
                            "args": agent_action.tool_input if isinstance(agent_action.tool_input, dict) else {},
                            "id": getattr(agent_action, "tool_call_id", agent_action.tool),
                        }
                    ],
                )
            )

        tool_call_id = getattr(agent_action, "tool_call_id", None)
        if not tool_call_id and isinstance(agent_action, AgentActionMessageLog) and agent_action.message_log:
            ai_msg = agent_action.message_log[0]
            if hasattr(ai_msg, "tool_calls") and ai_msg.tool_calls:
                tool_call_id = ai_msg.tool_calls[0].get("id", agent_action.tool)

        messages.append(
            ToolMessage(
                content=str(observation),
                tool_call_id=tool_call_id or agent_action.tool,
            )
        )

    return messages


# =============================================================================
# CORE AGENT EXECUTION UTILITIES
# =============================================================================


class AgentExecutionResult:
    """Result of agent execution containing final data and execution metadata."""

    def __init__(self, final_data: dict[str, Any] | None = None, iterations: int = 0):
        self.final_data = final_data
        self.iterations = iterations
        self.success = final_data is not None


# =============================================================================
# TOOL EXECUTION UTILITIES
# =============================================================================


async def execute_tool_call(tool_call: AIMessage, name2tool: dict[str, Any]) -> ToolMessage:
    """
    Execute a tool call and return the result.

    Args:
        tool_call: AIMessage containing tool call information
        name2tool: Dictionary mapping tool names to tool functions

    Returns:
        ToolMessage with the result
    """
    tool_name = tool_call.tool_calls[0]["name"]
    tool_args = tool_call.tool_calls[0]["args"]

    try:
        tool_output = await name2tool[tool_name](**tool_args)
        return ToolMessage(content=str(tool_output), tool_call_id=tool_call.tool_calls[0]["id"])
    except Exception as e:
        logger.error("Error executing tool %s: %s", tool_name, str(e))
        return ToolMessage(content=f"Error executing {tool_name}: {e!s}", tool_call_id=tool_call.tool_calls[0]["id"])


async def execute_and_update_scratchpad(
    tool_calls: list[Any], name2tool: dict[str, Any], agent_scratchpad: list[Any]
) -> tuple[list[Any], dict[str, Any]]:
    """
    Execute tool calls and update the agent scratchpad.

    This function handles the common pattern of:
    1. Executing multiple tool calls concurrently
    2. Creating a mapping of tool call IDs to result
    3. Updating the agent scratchpad with tool calls and results

    Args:
        tool_calls: List of tool calls to execute
        name2tool: Mapping of tool names to tool implementations
        agent_scratchpad: Current agent scratchpad to update

    Returns:
        Tuple of (updated_scratchpad, id2tool_result_mapping)
    """
    # Execute tool calls concurrently
    tool_results = await asyncio.gather(*[execute_tool_call(tool_call, name2tool) for tool_call in tool_calls])

    # Create mapping of tool call IDs to results
    id2tool_result = {tool_call.tool_call_id: tool_result for tool_call, tool_result in zip(tool_calls, tool_results, strict=False)}

    # Update agent scratchpad with tool calls and results
    for tool_call in tool_calls:
        agent_scratchpad.extend([tool_call, id2tool_result[tool_call.tool_call_id]])

    return agent_scratchpad, id2tool_result


def check_for_final_tool_call(tool_calls: list[Any], final_tool_name: str) -> tuple[bool, dict[str, Any]]:
    """
    Check if any tool call matches the final tool name and extract its arguments.

    Args:
        tool_calls: List of tool calls to check
        final_tool_name: Name of the final tool to look for

    Returns:
        Tuple of (found_final_tool, final_tool_args)
    """
    for tool_call in tool_calls:
        if tool_call.tool_calls[0]["name"] == final_tool_name:
            final_data = tool_call.tool_calls[0]["args"]
            return True, final_data

    return False, {}


# =============================================================================
# AGENT STREAMING UTILITIES
# =============================================================================


async def stream_agent_response(configured_agent, user_input: str, chat_history: list, agent_scratchpad: list) -> list[AIMessage]:
    """
    Stream agent response and return tool calls.

    Handles both raw AIMessage tokens (chains without output parser) and
    parsed AgentAction/AgentFinish objects (chains with OpenAIToolsAgentOutputParser).

    Args:
        configured_agent: The configured agent with callbacks
        user_input: User input string
        chat_history: Chat history
        agent_scratchpad: Agent scratchpad with previous interactions

    Returns:
        List of AIMessage objects with tool calls
    """
    outputs = []

    try:
        async for token in configured_agent.astream({"input": user_input, "chat_history": chat_history, "agent_scratchpad": agent_scratchpad}):
            # Handle parsed output from OpenAIToolsAgentOutputParser (LangChain 1.2.0+)
            if isinstance(token, list):
                for action in token:
                    if isinstance(action, AgentActionMessageLog):
                        _extract_tool_call_from_action(action, outputs)
            elif isinstance(token, AgentActionMessageLog):
                _extract_tool_call_from_action(token, outputs)
            elif isinstance(token, AgentFinish):
                # Agent finished without tool calls
                pass
            elif hasattr(token, "additional_kwargs"):
                # Raw AIMessage/AIMessageChunk token (streaming without parser)
                # LangChain 1.2.0+: check tool_call_chunks first, then additional_kwargs
                tool_call_chunks = getattr(token, "tool_call_chunks", None)
                tool_calls = token.additional_kwargs.get("tool_calls")

                if tool_call_chunks:
                    # LangChain 1.2.0+ format: tool_call_chunks with index, name, args, id
                    # noinspection PyTypeChecker
                    first_chunk = next(iter(tool_call_chunks)) if tool_call_chunks else {}
                    if first_chunk.get("id"):  # New tool call
                        outputs.append(token)
                    else:  # Continuation of the previous tool call
                        if outputs:
                            outputs[-1] += token
                        else:
                            outputs.append(token)
                elif tool_calls:
                    # Legacy format: additional_kwargs["tool_calls"]
                    if tool_calls[0].get("id"):  # New tool call
                        outputs.append(token)
                    else:  # Continuation of the previous tool call
                        if outputs:
                            outputs[-1] += token
                        else:
                            outputs.append(token)
    except Exception as e:
        logger.exception("Error streaming agent response: %s", str(e))
        raise

    # Convert to AIMessage objects with individual tool calls
    result = []
    for output in outputs:
        if hasattr(output, "tool_calls") and output.tool_calls:
            result.append(
                AIMessage(
                    content=output.content if hasattr(output, "content") else "",
                    tool_calls=output.tool_calls,
                    tool_call_id=output.tool_calls[0]["id"] if output.tool_calls else None,
                )
            )

    return result


def _extract_tool_call_from_action(action: AgentActionMessageLog, outputs: list) -> None:
    """Extract an AIMessage with a single tool call from an AgentActionMessageLog."""
    tool_call_id = action.tool
    # Try to get the real tool_call_id from the original message
    if action.message_log:
        for msg in action.message_log:
            if isinstance(msg, AIMessage) and msg.tool_calls:
                for tc in msg.tool_calls:
                    if tc["name"] == action.tool:
                        tool_call_id = tc.get("id", action.tool)
                        break
                break

    outputs.append(
        AIMessage(
            content="",
            tool_calls=[
                {
                    "name": action.tool,
                    "args": action.tool_input if isinstance(action.tool_input, dict) else {},
                    "id": tool_call_id,
                }
            ],
        )
    )


class BaseStreamingCallbackHandler:
    """Base callback handler for agent streaming operations."""

    def __init__(self):
        self.stream_queue = asyncio.Queue()
        self.step_name = None

    async def stream_generator(self) -> AsyncIterator[str]:
        """Generate streaming output from the queue."""
        while True:
            if self.stream_queue.empty():
                await asyncio.sleep(0.01)
                continue
            item = await self.stream_queue.get()
            if item == "<<DONE>>":
                return
            if item:
                yield item

    async def on_llm_new_token(self, *args, **kwargs) -> None:
        """Handle new LLM tokens."""
        try:
            chunk = kwargs.get("chunk")
            # LangChain 1.2.0: chunk may be ChatGenerationChunk, get message from it
            msg = getattr(chunk, "message", chunk) if chunk else None
            if not msg:
                return

            # Check both additional_kwargs and tool_call_chunks for tool calls
            tool_calls_kwargs = getattr(msg, "additional_kwargs", {}).get("tool_calls")
            tool_call_chunks = getattr(msg, "tool_call_chunks", None)

            if tool_calls_kwargs or tool_call_chunks:
                tool_call = (tool_calls_kwargs or [{}])[0] if tool_calls_kwargs else {}
                # noinspection PyUnresolvedReferences
                tool_name = tool_call.get("function", {}).get("name") or (tool_call_chunks[0].get("name") if tool_call_chunks else None)
                # noinspection PyUnresolvedReferences
                tool_args = tool_call.get("function", {}).get("arguments") or (tool_call_chunks[0].get("args") if tool_call_chunks else None)

                # Handle special tool names with custom messages
                tool_messages = getattr(self, "tool_messages", {})

                if tool_name and self.step_name != tool_name:
                    message = tool_messages.get(tool_name, f"Using {tool_name}")
                    await self.stream_queue.put(json.dumps({"type": "step_start", "content": message}) + "\n")
                    self.step_name = tool_name

                if tool_args:
                    await self.stream_queue.put(json.dumps({"type": "tool_arguments", "content": tool_args}) + "\n")

        except Exception as e:
            logger.error("Error in token handler: %s", str(e))

    async def on_llm_end(self, *args, **kwargs) -> None:
        """Handle LLM completion."""
        await self.handle_llm_end_common()

    async def handle_llm_end_common(self, final_seen: bool = False) -> None:
        """
        Common LLM end handling logic for agent streaming callbacks.

        Args:
            final_seen: Whether the final output has been seen (for specialized agents)
        """
        try:
            if self.step_name and not final_seen:
                await self.stream_queue.put(json.dumps({"type": "step_end", "content": f"Completed {self.step_name}"}) + "\n")
                self.step_name = None

            if final_seen:
                await self.finalize_stream()
            else:
                await self.stream_queue.put(json.dumps({"type": "step_end", "content": "Step completed"}) + "\n")
        except Exception as e:
            logger.error("Error in LLM end handler: %s", str(e))

    async def finalize_stream(self) -> None:
        """Finalize the streaming process."""
        await self.stream_queue.put("<<DONE>>")


class AgentCallbackHandler(BaseStreamingCallbackHandler):
    """Specialized callback handler for agent streaming with common patterns."""

    def __init__(self, tool_messages: dict[str, str] = None, final_tool_name: str = None):
        """
        Initialize the agent callback handler.

        Args:
            tool_messages: Dictionary mapping tool names to display messages
            final_tool_name: Name of the final tool that indicates completion
        """
        super().__init__()
        self.tool_messages = tool_messages or {}
        self.final_tool_name = final_tool_name
        self.final_tool_seen = False
        self.thinking_content = ""
        self.in_thinking_mode = False  # Will be set to True when reasoning content is detected

    async def __aiter__(self):
        """Async iterator for streaming responses."""
        async for item in self.stream_generator():
            yield item

    async def on_llm_new_token(self, *args, **kwargs) -> None:
        """Handle new LLM tokens with common agent patterns."""
        try:
            chunk = kwargs.get("chunk")

            # Get the message from the chunk (LangChain 1.2.0: chunk is ChatGenerationChunk)
            msg = getattr(chunk, "message", chunk) if chunk else None

            # Handle tool calls (check both additional_kwargs and tool_call_chunks)
            if msg:
                tool_calls_kwargs = getattr(msg, "additional_kwargs", {}).get("tool_calls")
                tool_call_chunks = getattr(msg, "tool_call_chunks", None)
                if tool_calls_kwargs or tool_call_chunks:
                    tool_call = (tool_calls_kwargs or [{}])[0] if tool_calls_kwargs else {}
                    # noinspection PyUnresolvedReferences
                    tool_name = tool_call.get("function", {}).get("name") or (tool_call_chunks[0].get("name") if tool_call_chunks else None)

                    # Check if this is the final tool
                    if tool_name and tool_name == self.final_tool_name:
                        self.final_tool_seen = True

                    # Use parent class method for common tool streaming logic
                    await super().on_llm_new_token(*args, **kwargs)

            # Always check for reasoning content - dynamic detection
            reasoning_content = None
            if chunk:
                # noinspection PyTypeChecker
                reasoning_content = self._extract_reasoning_content(chunk)

            # Send reasoning content as "think" type and enter thinking mode
            if reasoning_content:
                self.in_thinking_mode = True
                await self.stream_queue.put(json.dumps({"type": "think", "content": reasoning_content}) + "\n")

            # Handle regular content (LangChain 1.2.0: content is on message, not chunk)
            content = getattr(msg, "content", None) if msg else None
            if content:
                # Check if we're in thinking mode (dynamically detected)
                if self.in_thinking_mode:
                    # noinspection PyTypeChecker
                    if self._is_thinking_end(content):
                        self.in_thinking_mode = False
                        logger.info("Detected end of thinking mode, switching to bot_answer")
                        # Send this content as bot_answer since it's the actual response
                        await self.stream_queue.put(json.dumps({"type": "bot_answer", "content": content}) + "\n")
                    else:
                        # Still thinking content - send as a think type
                        await self.stream_queue.put(json.dumps({"type": "think", "content": content}) + "\n")
                else:
                    # Regular content or after thinking phase
                    await self.stream_queue.put(json.dumps({"type": "bot_answer", "content": content}) + "\n")

        except Exception as e:
            logger.error("Error in AgentCallbackHandler.on_llm_new_token: %s", str(e))

    @staticmethod
    def _extract_reasoning_content(chunk) -> str | None:
        """Extract reasoning content from various possible locations in the chunk."""
        # Check for reasoning in various possible locations (similar to rag_utils.py)
        if hasattr(chunk, "additional_kwargs") and chunk.additional_kwargs:
            if chunk.additional_kwargs.get("reasoning"):
                return chunk.additional_kwargs["reasoning"]
            elif hasattr(chunk, "choices") and chunk.choices:
                choice = chunk.choices[0] if chunk.choices else None
                if choice and hasattr(choice, "delta") and hasattr(choice.delta, "reasoning") and choice.delta.reasoning:
                    return choice.delta.reasoning

        elif hasattr(chunk, "response_metadata") and chunk.response_metadata:
            if chunk.response_metadata.get("reasoning"):
                return chunk.response_metadata["reasoning"]

        elif hasattr(chunk, "reasoning") and chunk.reasoning:
            return chunk.reasoning

        return None

    @staticmethod
    def _is_thinking_end(content: str) -> bool:
        """Determine if the content indicates the end of thinking mode."""
        content_lower = content.lower().strip()
        thinking_end_patterns = [
            content.strip().startswith("#"),  # Markdown headers
            content.strip().startswith("##"),  # Sub-headers
            "comprehensive overview" in content_lower,
            content.strip().startswith("**"),  # Bold markdown
            len(content.strip()) > 50 and any(word in content_lower for word in ["introduction", "overview", "summary", "conclusion"]),
        ]
        return any(thinking_end_patterns)

    async def on_llm_end(self, *args, **kwargs) -> None:
        """Handle LLM completion."""
        await self.handle_llm_end_common(final_seen=self.final_tool_seen)


# =============================================================================
# AGENT EXECUTION LOOPS
# =============================================================================


async def execute_agent_loop(
    configured_agent: Any,
    user_input: str,
    chat_history: list[Any],
    name2tool: dict[str, Any],
    max_iterations: int,
    final_tool_name: str,
    model_name: str | None = None,
) -> AgentExecutionResult:
    """
    Execute the standard agent loop pattern with tool calls and scratchpad management.

    Args:
        configured_agent: The configured agent with callback handlers
        user_input: The user's input query
        chat_history: The chat history for context
        name2tool: Mapping of tool names to tool instances
        max_iterations: Maximum number of iterations to run
        final_tool_name: Name of the tool that indicates completion (e.g., "final_answer", "final_research_paper")
        model_name: Optional model name to look up context_window from model_provider_models

    Returns:
        AgentExecutionResult containing the final data and execution metadata
    """
    # Look up the model's context window from the database (falls back to 128k)
    from src.main.utils.llm.model_utils import get_model_context_window

    _context_window_tokens = get_model_context_window(model_name) if model_name else 128_000
    # Reserve 20% for system prompt + user input + response headroom
    _max_scratchpad_tokens = int(_context_window_tokens * 0.75)
    _MAX_SCRATCHPAD_CHARS = _max_scratchpad_tokens * 4  # rough: 4 chars ≈ 1 token

    count = 0
    final_data = None
    agent_scratchpad: list[AIMessage | ToolMessage] = []

    # Max chars for a single tool result (~20k tokens = ~80k chars)
    _MAX_SINGLE_RESULT_CHARS = min(_MAX_SCRATCHPAD_CHARS // 3, 80_000)

    while count < max_iterations:
        # Step 1: Truncate oversized individual tool results.
        # A single get_content() can return 140k+ chars (e.g., Nature article)
        # which alone exceeds the entire context window.
        for i, m in enumerate(agent_scratchpad):
            content = getattr(m, "content", "") or ""
            if isinstance(m, ToolMessage) and len(content) > _MAX_SINGLE_RESULT_CHARS:
                truncated = content[:_MAX_SINGLE_RESULT_CHARS] + f"\n\n[Content truncated from {len(content)} to {_MAX_SINGLE_RESULT_CHARS} chars]"
                agent_scratchpad[i] = ToolMessage(content=truncated, tool_call_id=getattr(m, "tool_call_id", ""))
                logger.info(
                    "Context guard: truncated tool result %d from %d to %d chars",
                    i,
                    len(content),
                    _MAX_SINGLE_RESULT_CHARS,
                )

        # Step 2: Prune oldest entries when total still exceeds limit.
        _scratchpad_chars = sum(len(getattr(m, "content", "") or "") for m in agent_scratchpad)
        if _scratchpad_chars > _MAX_SCRATCHPAD_CHARS:
            # Keep the most recent 2/3 of entries (newer = more relevant)
            keep_from = len(agent_scratchpad) // 3
            # Make sure we don't split an AI+Tool pair — find the next AIMessage boundary
            while keep_from < len(agent_scratchpad) and not isinstance(agent_scratchpad[keep_from], AIMessage):
                keep_from += 1
            old_len = len(agent_scratchpad)
            agent_scratchpad = agent_scratchpad[keep_from:]
            logger.info(
                "Context window guard (model=%s, limit=%dk): pruned scratchpad from %d to %d entries (%d→%d chars)",
                model_name or "unknown",
                _context_window_tokens // 1000,
                old_len,
                len(agent_scratchpad),
                _scratchpad_chars,
                sum(len(getattr(m, "content", "") or "") for m in agent_scratchpad),
            )

        # Stream the agent response
        tool_calls = await stream_agent_response(configured_agent, user_input, chat_history, agent_scratchpad)

        if not tool_calls:
            logger.warning("No tool calls generated")
            break

        # Execute tool calls and update scratchpad using utility function
        agent_scratchpad, _ = await execute_and_update_scratchpad(tool_calls, name2tool, agent_scratchpad)

        # Check for the final tool call using utility function
        found_final, final_data = check_for_final_tool_call(tool_calls, final_tool_name)
        if found_final:
            return AgentExecutionResult(final_data, count + 1)

        count += 1

    return AgentExecutionResult(final_data, count)


async def execute_agent_with_streaming(
    configured_agent: Any,
    user_input: str,
    chat_history: list[Any],
    name2tool: dict[str, Any],
    max_iterations: int,
    final_tool_name: str,
    stream_processor: Callable[[AgentExecutionResult], AsyncIterator[str]],
) -> AsyncIterator[str]:
    """
    Execute agent loop and process results with streaming.

    Args:
        configured_agent: The configured agent with callback handlers
        user_input: The user's input query
        chat_history: The chat history for context
        name2tool: Mapping of tool names to tool instances
        max_iterations: Maximum number of iterations to run
        final_tool_name: Name of the tool that indicates completion
        stream_processor: Function to process the execution result and yield streaming content

    Yields:
        Streaming content from the stream_processor
    """
    try:
        result = await execute_agent_loop(configured_agent, user_input, chat_history, name2tool, max_iterations, final_tool_name)

        async for content in stream_processor(result):
            yield content

    except Exception as e:
        logger.error("Error in agent execution: %s", e)
        yield f"Error: {e!s}"


async def process_agent_iteration(
    configured_agent, user_input: str, chat_history: list, agent_scratchpad: list, name2tool: dict[str, Any]
) -> tuple[list, bool]:
    """
    Process a single agent iteration with tool execution.

    Args:
        configured_agent: The configured agent with callbacks
        user_input: User input string
        chat_history: Chat history
        agent_scratchpad: Agent scratchpad with previous interactions
        name2tool: Dictionary mapping tool names to tool functions

    Returns:
        Tuple of (updated_scratchpad, should_continue)
    """
    # Stream the agent response
    tool_calls = await stream_agent_response(configured_agent, user_input, chat_history, agent_scratchpad)

    if not tool_calls:
        logger.warning("No tool calls generated")
        return agent_scratchpad, False

    # Execute tool calls and update scratchpad using utility function
    agent_scratchpad, _id2tool_result = await execute_and_update_scratchpad(tool_calls, name2tool, agent_scratchpad)

    return agent_scratchpad, True


# =============================================================================
# STANDARDIZED AGENT PROCESSING
# =============================================================================


async def process_agent_query(
    agent: Any,
    user_input: str,
    callback_handler: Any,
    chat_history: list[Any],
    name2tool: dict[str, Any],
    max_iterations: int,
    final_tool_name: str,
    success_message_config: dict[str, str],
    error_message_config: dict[str, str],
    model_name: str | None = None,
) -> AsyncIterator[str]:
    """
    Common process_query pattern for agents with streaming response.

    Args:
        agent: The agent instance
        user_input: The user's input query
        callback_handler: The callback handler for streaming
        chat_history: The chat history for context
        name2tool: Mapping of tool names to tool instances
        max_iterations: Maximum number of iterations to run
        final_tool_name: Name of the tool that indicates completion
        success_message_config: Configuration for success messages with keys:
            - 'type': Type of the final data (e.g., 'final_paper_data', 'final_answer_data')
            - 'chat_content_key': Key to extract content for chat history (e.g., 'title', 'answer')
            - 'chat_content_prefix': Prefix for chat history content (e.g., 'Research paper: ', '')
            - 'chat_content_default': Default content if key not found
        error_message_config: Configuration for error messages with keys:
            - 'no_result': Message when no result is generated
            - 'exception_prefix': Prefix for exception messages
        model_name: Optional model name to look up context_window from model_provider_models

    Yields:
        Streaming JSON content from the agent execution
    """
    try:
        # Configure the agent with callback handler
        configured_agent = agent.with_config(callbacks=[callback_handler])

        # Execute agent loop using the reusable utility
        result = await execute_agent_loop(
            configured_agent=configured_agent,
            user_input=user_input,
            chat_history=chat_history,
            name2tool=name2tool,
            max_iterations=max_iterations,
            final_tool_name=final_tool_name,
            model_name=model_name,
        )

        # Update chat history
        if result.success and result.final_data:
            content_key = success_message_config.get("chat_content_key", "content")
            content_prefix = success_message_config.get("chat_content_prefix", "")
            content_default = success_message_config.get("chat_content_default", "No content provided")

            chat_content = result.final_data.get(content_key, content_default)
            if content_prefix:
                chat_content = f"{content_prefix}{chat_content}"

            chat_history.extend([HumanMessage(content=user_input), AIMessage(content=chat_content)])

            # Yield final data for the caller
            yield json.dumps({"type": success_message_config["type"], "content": result.final_data}) + "\n"
        else:
            logger.warning("No %s generated within iteration limit", final_tool_name)
            yield json.dumps({"type": "error", "content": error_message_config["no_result"]}) + "\n"

    except Exception as e:
        logger.error("Error in agent process_query: %s", str(e))
        yield json.dumps({"type": "error", "content": f"{error_message_config['exception_prefix']}{e!s}"}) + "\n"


async def execute_agent_with_standard_config(
    agent: Any,
    user_input: str,
    callback_handler: Any,
    chat_history: list[Any],
    name2tool: dict[str, Any],
    max_iterations: int,
    final_tool_name: str,
    success_config: dict[str, str],
    error_prefix: str,
) -> AsyncIterator[str]:
    """
    Execute an agent query with standard configuration pattern - eliminates duplicate agent execution calls.

    This function consolidates the common pattern found in agent classes where
    process_agent_query is called with similar configuration structures.

    Args:
        agent: The agent instance
        user_input: The user's input query
        callback_handler: The callback handler for streaming
        chat_history: The chat history for context
        name2tool: Mapping of tool names to tool instances
        max_iterations: Maximum number of iterations to run
        final_tool_name: Name of the tool that indicates completion
        success_config: Success message configuration dict
        error_prefix: Prefix for error messages

    Returns:
        AsyncIterator yielding agent response content
    """
    error_config = {
        "no_result": "Could not generate a complete answer within the iteration limit",
        "exception_prefix": f"An error occurred during {error_prefix}: ",
    }

    async for content in process_agent_query(
        agent=agent,
        user_input=user_input,
        callback_handler=callback_handler,
        chat_history=chat_history,
        name2tool=name2tool,
        max_iterations=max_iterations,
        final_tool_name=final_tool_name,
        success_message_config=success_config,
        error_message_config=error_config,
    ):
        yield content


class StandardAgentProcessor:
    """
    Standard agent processor that eliminates duplicate process_query patterns.

    This class encapsulates the common agent processing pattern to eliminate
    code duplication across different agent implementations.
    """

    def __init__(self, agent: Any, chat_history: list[Any], name2tool: dict[str, Any], max_iterations: int, model_name: str | None = None):
        self.agent = agent
        self.chat_history = chat_history
        self.name2tool = name2tool
        self.max_iterations = max_iterations
        self.model_name = model_name

    async def process_query_with_config(
        self,
        user_input: str,
        callback_handler: Any,
        final_tool_name: str,
        success_config: dict[str, str],
        error_config: dict[str, str],
    ) -> AsyncIterator[str]:
        """
        Process a query with the standard agent pattern.

        Args:
            user_input: The user's input query
            callback_handler: The callback handler for streaming
            final_tool_name: Name of the tool that indicates completion
            success_config: Success message configuration dict
            error_config: Error message configuration dict

        Returns:
            AsyncIterator yielding agent response content
        """
        async for content in process_agent_query(
            agent=self.agent,
            user_input=user_input,
            callback_handler=callback_handler,
            chat_history=self.chat_history,
            name2tool=self.name2tool,
            max_iterations=self.max_iterations,
            final_tool_name=final_tool_name,
            success_message_config=success_config,
            error_message_config=error_config,
            model_name=self.model_name,
        ):
            yield content


async def execute_standard_agent_process_query(
    agent: Any,
    user_input: str,
    callback_handler: Any,
    chat_history: list[Any],
    name2tool: dict[str, Any],
    max_iterations: int,
    final_tool_name: str,
    success_config: dict[str, str],
    error_config: dict[str, str],
) -> AsyncIterator[str]:
    """
    Standard agent process_query pattern - eliminates the exact duplicate code pattern.

    This function consolidates the identical process_agent_query call pattern
    found in multiple agent classes.

    Args:
        agent: The agent instance
        user_input: The user's input query
        callback_handler: The callback handler for streaming
        chat_history: The chat history for context
        name2tool: Mapping of tool names to tool instances
        max_iterations: Maximum number of iterations to run
        final_tool_name: Name of the tool that indicates completion
        success_config: Success message configuration dict
        error_config: Error message configuration dict

    Returns:
        AsyncIterator yielding agent response content
    """
    processor = StandardAgentProcessor(agent, chat_history, name2tool, max_iterations)
    async for content in processor.process_query_with_config(user_input, callback_handler, final_tool_name, success_config, error_config):
        yield content


# =============================================================================
# AGENT CHAIN CREATION UTILITIES
# =============================================================================


def create_standard_agent_prompt(system_prompt: str) -> ChatPromptTemplate:
    """
    Create a standardized agent prompt template.

    Args:
        system_prompt: The system prompt message for the agent

    Returns:
        ChatPromptTemplate: Configured prompt template with standard placeholders
    """
    return ChatPromptTemplate.from_messages(
        [
            ("system", system_prompt),
            MessagesPlaceholder(variable_name="chat_history"),
            ("human", "{input}"),
            MessagesPlaceholder(variable_name="agent_scratchpad"),
        ]
    )


def create_agent_chain_input_formatter(use_openai_format: bool = True) -> dict[str, Callable]:
    """
    Create standardized input formatter for agent chains.

    Args:
        use_openai_format: Whether to use OpenAI tool message formatting for agent_scratchpad

    Returns:
        dict[str, Callable]: Input formatter dictionary for agent chains
    """
    if use_openai_format:
        return {
            "input": lambda x: x["input"],
            "chat_history": lambda x: x["chat_history"],
            "agent_scratchpad": lambda x: format_to_openai_tool_messages(x["agent_scratchpad"]),
        }
    else:
        return {
            "input": lambda x: x["input"],
            "chat_history": lambda x: x["chat_history"],
            "agent_scratchpad": lambda x: x.get("agent_scratchpad", []),
        }


def create_standard_agent_chain(
    llm: ChatOpenAI,
    tools: list[Any],
    system_prompt: str,
    use_openai_format: bool = True,
    tool_choice: str | None = None,
):
    """
    Create a standardized agent chain with common configuration.

    Args:
        llm: The language model to use
        tools: List of tools available to the agent
        system_prompt: System prompt for the agent
        use_openai_format: Whether to use OpenAI tool message formatting
        tool_choice: Tool choice strategy ("any", "auto", or None)

    Returns:
        Agent chain ready for execution
    """
    # Create the prompt
    prompt = create_standard_agent_prompt(system_prompt)

    # Create input formatter
    input_formatter = create_agent_chain_input_formatter(use_openai_format)

    # Build the chain
    # noinspection PyTypeChecker
    chain = input_formatter | prompt

    # Bind tools to LLM
    if tool_choice:
        chain = chain | llm.bind_tools(tools, tool_choice=tool_choice)
    else:
        chain = chain | llm.bind_tools(tools)

    # Add output parser for OpenAI format
    if use_openai_format:
        chain = chain | OpenAIToolsAgentOutputParser()

    return chain


def create_agent_prompt_template():
    """
    Create a standard agent prompt template.

    Returns:
        ChatPromptTemplate for agent interactions
    """
    return ChatPromptTemplate.from_messages(
        [
            ("system", "You are a helpful AI assistant."),
            MessagesPlaceholder(variable_name="chat_history"),
            ("human", "{input}"),
            MessagesPlaceholder(variable_name="agent_scratchpad"),
        ]
    )


def create_agent_chain(llm, tools: list, prompt_template=None):
    """
    Create a standard agent chain configuration.

    Args:
        llm: Language model instance
        tools: List of available tools
        prompt_template: Optional custom prompt template

    Returns:
        Configured agent chain
    """
    if prompt_template is None:
        prompt_template = create_agent_prompt_template()

    first_message = prompt_template.messages[0] if prompt_template.messages else None
    system_prompt = getattr(getattr(first_message, "prompt", None), "template", None) or "You are a helpful AI assistant."
    return create_standard_agent_chain(
        llm,
        tools,
        system_prompt,
    )
