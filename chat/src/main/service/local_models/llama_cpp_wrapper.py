"""
LlamaCpp wrapper for LangChain integration with model_service.py.

This module provides a wrapper around LlamaCpp models loaded by model_service.py
to make them compatible with LangChain's BaseChatModel interface.
"""

from typing import Any

from langchain_core.callbacks.manager import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.outputs import ChatGeneration, ChatResult

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class LlamaCppChatModel(BaseChatModel):
    """
    LangChain compatible chat model wrapper for LlamaCpp models loaded by model_service.py.

    This wrapper makes the LlamaCpp models compatible with LangChain's BaseChatModel
    interface, allowing them to be used in LangChain chains and agents.
    """

    llm: Any  # The LlamaCpp model instance
    model_name: str = "LlamaCpp"
    temperature: float = 0.1
    max_tokens: int = 800

    def __init__(self, llm: Any, model_name: str = "LlamaCpp", temperature: float = 0.1, max_tokens: int = 800, **kwargs):
        """
        Initialize the LlamaCppChatModel.

        Args:
                llm: The LlamaCpp model instance
                model_name: Name of the model
                temperature: Temperature for generation
                max_tokens: Maximum number of tokens to generate
                **kwargs: Additional keyword arguments
        """
        # Ensure the llm parameter is provided to prevent pydantic validation errors
        if llm is None:
            raise ValueError("The 'llm' parameter is required for LlamaCppChatModel")

        # Create a dictionary with our parameters to pass to the parent class
        model_kwargs = {"llm": llm, "model_name": model_name, "temperature": temperature, "max_tokens": max_tokens}
        # Add any additional kwargs
        model_kwargs.update(kwargs)

        # Pass the complete dictionary to the parent constructor
        super().__init__(**model_kwargs)

        # Also set the attributes directly in case the parent constructor doesn't
        self.llm = llm
        self.model_name = model_name
        self.temperature = temperature
        self.max_tokens = max_tokens

    @property
    def _llm_type(self) -> str:
        """Return the type of LLM."""
        return "llama_cpp"

    @staticmethod
    def _format_messages_as_prompt(messages: list[BaseMessage]) -> str:
        """
        Format a list of messages as a prompt for the LlamaCpp model.

        Args:
                messages: List of messages to format

        Returns:
                Formatted prompt string
        """
        prompt = ""

        for message in messages:
            if isinstance(message, SystemMessage):
                prompt += f"<s>[SYSTEM] {message.content} </s>\n"
            elif isinstance(message, HumanMessage):
                prompt += f"<s>[USER] {message.content} </s>\n"
            elif isinstance(message, AIMessage):
                prompt += f"<s>[ASSISTANT] {message.content} </s>\n"
            else:
                prompt += f"<s>{message.content}</s>\n"

        # Add the final assistant prompt
        prompt += "<s>[ASSISTANT] "

        return prompt

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs,
    ) -> ChatResult:
        """
        Generate a response from the LlamaCpp model.

        Args:
                messages: List of messages to generate a response for
                stop: Optional list of stop sequences
                run_manager: Optional callback manager
                **kwargs: Additional keyword arguments

        Returns:
                ChatResult containing the generated response
        """
        # Format the messages as a prompt
        prompt = self._format_messages_as_prompt(messages)

        # Generate a response from the LlamaCpp model
        try:
            # Add timeout handling for LlamaCpp model invocation
            import platform
            import signal

            def timeout_handler(_signum, _frame):
                raise TimeoutError("LlamaCpp model invocation timed out")

            # Set timeout (30 seconds) - only on non-Windows platforms
            timeout_seconds = kwargs.get("timeout", 30)
            old_handler = None
            if platform.system().lower() != "windows":
                # Use signal-based timeout on Unix-like systems
                old_handler = signal.signal(signal.SIGALRM, timeout_handler)
                signal.alarm(timeout_seconds)

            try:
                response = self.llm(
                    prompt=prompt,
                    max_tokens=kwargs.get("max_tokens", self.max_tokens),
                    temperature=kwargs.get("temperature", self.temperature),
                    stop=stop,
                )
            finally:
                if platform.system().lower() != "windows" and old_handler is not None:
                    # Clear the alarm and restore the old handler
                    signal.alarm(0)
                    signal.signal(signal.SIGALRM, old_handler)

            # Extract the generated text
            if isinstance(response, dict) and "choices" in response:
                # Handle the case where the response is a dict with choices
                text = response["choices"][0]["text"]
            elif isinstance(response, dict) and "text" in response:
                # Handle the case where the response is a dict with text
                text = response["text"]
            else:
                # Handle the case where the response is a string
                text = str(response)

            # Create a ChatGeneration object
            message = AIMessage(content=text)
            generation = ChatGeneration(message=message)

            # Create and return a ChatResult
            return ChatResult(generations=[generation])

        except Exception as e:
            logger.error("Error generating response from LlamaCpp model: %s", str(e))
            # Return an empty response in case of error
            message = AIMessage(content="Error generating response.")
            generation = ChatGeneration(message=message)
            return ChatResult(generations=[generation])

    async def _agenerate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs,
    ) -> ChatResult:
        """
        Asynchronously generate a response from the LlamaCpp model.

        This is a simple wrapper around _generate since LlamaCpp doesn't support async.

        Args:
                messages: List of messages to generate a response for
                stop: Optional list of stop sequences
                run_manager: Optional callback manager
                **kwargs: Additional keyword arguments

        Returns:
                ChatResult containing the generated response
        """
        # LlamaCpp doesn't support async, so we just call _generate
        return self._generate(messages, stop, run_manager, **kwargs)
