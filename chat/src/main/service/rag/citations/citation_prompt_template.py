"""
Citation-aware prompt templates for RAG responses.

This module provides structured prompt templates that instruct LLMs to generate
responses with proper citation markers and structured outputs.
"""

from langchain_core.documents import Document
from langchain_core.prompts import PromptTemplate

from src.main.utils.config.loader import resolved_prompts
from src.main.utils.core.logger import get_logger
from src.main.utils.tokens.budget import TokenBudget

logger = get_logger(__name__)


class CitationPromptTemplate:
    """Generates citation-aware prompts for RAG responses."""

    @staticmethod
    def create_citation_aware_prompt() -> PromptTemplate:
        """
        Create a prompt template that instructs the LLM to generate responses
        with proper citation markers.

        Returns:
            PromptTemplate configured for citation-aware responses
        """

        # Load existing template_system from prompts.yaml which now includes citation instructions
        template = resolved_prompts.get("rag_templates", {}).get("template_system", "")

        if not template:
            logger.error("template_system not found in prompts.yaml - this is a configuration error")
            raise ValueError("template_system must be configured in config.yaml under rag.prompt.template_system")

        return PromptTemplate(template=template, input_variables=["context", "chat_history", "question"])

    @staticmethod
    def create_structured_citation_prompt() -> PromptTemplate:
        """
        Create a prompt template for structured citation generation with JSON output.

        Returns:
            PromptTemplate configured for structured citation responses
        """

        # Load existing template_system from prompts.yaml which now includes citation instructions
        template = resolved_prompts.get("rag_templates", {}).get("template_system", "")

        if not template:
            logger.error("template_system not found in prompts.yaml - this is a configuration error")
            raise ValueError("template_system must be configured in config.yaml under rag.prompt.template_system")

        return PromptTemplate(template=template, input_variables=["context", "chat_history", "question"])

    @staticmethod
    def format_context_with_citations(documents: list[Document], max_context_tokens: int = 0) -> str:
        """
        Format retrieved documents with citation numbers for the prompt.

        Args:
            documents: List of retrieved documents
            max_context_tokens: If > 0, enforce token budget for total context.
                When 0, falls back to character-based truncation (backward compatible).

        Returns:
            Formatted context string with citation markers
        """
        if not documents:
            return "No relevant context documents found."

        budget = TokenBudget(max_context_tokens, reserve_tokens=1000) if max_context_tokens > 0 else None
        formatted_context = []

        for i, doc in enumerate(documents, 1):
            # Get document metadata
            metadata = doc.metadata or {}
            source = metadata.get("source", f"Document {i}")
            page = metadata.get("page", "Unknown")

            # Distinguish web-supplement chunks from library chunks in the
            # header so the LLM knows which citations come from the user's
            # own library (priority 1) and which were pulled from a web
            # cascade (priority 2). Library-first is the user's explicit
            # ordering preference — see SPARSE_DOCS_THRESHOLD in
            # rag_strategy.py.
            if metadata.get("source_type") == "web":
                url = metadata.get("url", "")
                title = metadata.get("title", source)
                doc_header = f"[{i}] WEB Source: {title} ({url})"
            else:
                doc_header = f"[{i}] LIBRARY Source: {source}, Page: {page}"
            doc_content = doc.page_content or "No content available"

            if budget:
                # Token-based truncation
                header_and_separator = f"{doc_header}\n"
                budget.add(header_and_separator)
                if budget.is_exhausted:
                    logger.info("Citation context budget exhausted at document %d/%d", i, len(documents))
                    break
                doc_content = budget.truncate_to_fit(doc_content)
                if not doc_content:
                    logger.info("Citation context budget exhausted during document %d/%d", i, len(documents))
                    break
            else:
                # Character-based truncation (backward compatible)
                if len(doc_content) > 2000:
                    doc_content = doc_content[:2000] + "..."

            formatted_context.append(f"{doc_header}\n{doc_content}")

        return "\n\n".join(formatted_context)

    @staticmethod
    def create_reasoning_citation_prompt() -> PromptTemplate:
        """
        Create a prompt template specifically for reasoning models with citation support.

        Returns:
            PromptTemplate configured for reasoning models with citations
        """

        # Load existing template_system from prompts.yaml which now includes citation instructions
        template = resolved_prompts.get("rag_templates", {}).get("template_system", "")

        if not template:
            logger.error("template_system not found in prompts.yaml - this is a configuration error")
            raise ValueError("template_system must be configured in config.yaml under rag.prompt.template_system")

        return PromptTemplate(template=template, input_variables=["context", "chat_history", "question"])


def get_citation_prompt_for_model_type(model_type: str = "NORMAL") -> PromptTemplate:
    """
    Get the appropriate citation prompt template based on model type.

    Args:
        model_type: Type of model ("NORMAL", "EMBEDDING", etc.)

    Returns:
        Appropriate PromptTemplate for the model type
    """
    template_factory = CitationPromptTemplate()

    # All models now use dynamic reasoning detection
    if model_type == "STRUCTURED":
        return template_factory.create_structured_citation_prompt()
    else:
        return template_factory.create_citation_aware_prompt()
