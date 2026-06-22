from collections.abc import AsyncIterator
import json

from langchain_core.callbacks import AsyncCallbackHandler
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from src.main.service.web_search.web_search_tools import final_answer, web_search
from src.main.utils.config.loader import resolved_config, resolved_prompts
from src.main.utils.core.logger import get_logger
from src.main.utils.llm.agents import (
    AgentCallbackHandler,
    StandardAgentProcessor,
    create_standard_agent_chain,
    execute_tool_call,
)

logger = get_logger(__name__)


class WebSearchCallbackHandler(AgentCallbackHandler, AsyncCallbackHandler):
    """Callback handler for streaming web search agent responses."""

    def __init__(self):
        tool_messages = {"final_answer": "Generating final answer", "web_search": "Searching the web"}

        super().__init__(tool_messages=tool_messages, final_tool_name="final_answer")  # Dynamic reasoning detection


# Tools are imported from web_search_tools module


class WebSearchAgent:
    """Web search agent that can search the web and provide answers with streaming."""

    def __init__(self, llm, chat_history: list[BaseMessage] = None):
        self.llm = llm
        self.chat_history: list[BaseMessage] = chat_history or []
        self.max_iterations = int(resolved_config.get("web_search", {}).get("max_tool_iterations", 3))
        self.collected_search_results = []

        # Set up tools with a tracking wrapper for web_search
        self.tools = [web_search, final_answer]
        # noinspection PyUnresolvedReferences
        original_web_search_coroutine = web_search.coroutine

        async def tracking_web_search(query: str):
            results = await original_web_search_coroutine(query=query)
            self.collected_search_results.extend(results)
            return results

        self.name2tool = {
            "web_search": tracking_web_search,
            # noinspection PyUnresolvedReferences
            "final_answer": final_answer.coroutine,
        }

        # Create the agent chain using shared utility
        # Get system prompt from prompts.yaml
        default_prompt = (
            "You are a helpful web search assistant. When answering a user's question, "
            "you should first search the web using the web_search tool to get current information. "
            "After gathering information from web search, you MUST use the final_answer tool "
            "to provide a comprehensive answer based on the search results. "
            "Always cite the sources you used in your final answer. "
            "Use tools to answer the user's CURRENT question, not previous questions."
        )
        system_prompt = resolved_prompts.get("rag_templates", {}).get("web_search_system", default_prompt)

        self.agent = create_standard_agent_chain(
            llm=self.llm,
            tools=self.tools,
            system_prompt=system_prompt,
            use_openai_format=False,  # Uses basic agent_scratchpad format
            tool_choice="any",
        )

    async def execute_tool(self, tool_call: AIMessage) -> ToolMessage:
        """Execute a tool call and return the result."""
        return await execute_tool_call(tool_call, self.name2tool)

    async def process_query(self, user_input: str, callback_handler: WebSearchCallbackHandler) -> AsyncIterator[str]:
        """Process a user query with web search and return streaming response."""
        # Use the standard agent processor to eliminate code duplication
        processor = StandardAgentProcessor(self.agent, self.chat_history, self.name2tool, self.max_iterations)

        success_config = {
            "type": "final_answer_data",
            "chat_content_key": "answer",
            "chat_content_prefix": "",
            "chat_content_default": "No answer provided",
        }

        error_config = {
            "no_result": "Could not generate a complete answer within the iteration limit",
            "exception_prefix": "An error occurred during web search: ",
        }

        async for content in processor.process_query_with_config(
            user_input=user_input,
            callback_handler=callback_handler,
            final_tool_name="final_answer",
            success_config=success_config,
            error_config=error_config,
        ):
            yield content

        # Yield collected search results for citation emission in the chat handler
        if self.collected_search_results:
            yield (
                json.dumps(
                    {
                        "type": "web_search_sources",
                        "content": [
                            {"title": r.title, "url": r.link, "source": r.source, "snippet": r.snippet} for r in self.collected_search_results
                        ],
                    }
                )
                + "\n"
            )
