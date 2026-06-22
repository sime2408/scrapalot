"""
Document structure-aware chunking using LangChain's specialized splitters.

This implementation provides structure-aware splitting for various document types
including Markdown, HTML, code, and other structured formats.
"""

import re
from typing import Any

try:
    # noinspection PyProtectedMember
    from langchain_text_splitters import (
        HTMLHeaderTextSplitter,
        JavaScriptCodeTextSplitter,
        Language,
        MarkdownHeaderTextSplitter,
        PythonCodeTextSplitter,
        RecursiveCharacterTextSplitter,
    )

    LANGCHAIN_SPLITTERS_AVAILABLE = True
except ImportError:
    HTMLHeaderTextSplitter = None
    JavaScriptCodeTextSplitter = None
    Language = None
    MarkdownHeaderTextSplitter = None
    PythonCodeTextSplitter = None
    RecursiveCharacterTextSplitter = None
    LANGCHAIN_SPLITTERS_AVAILABLE = False

from src.main.service.rag.chunking.base_chunking import BaseChunkingStrategy
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class DocumentStructureChunkingStrategy(BaseChunkingStrategy):
    """
    Structure-aware chunking using LangChain's document-specific splitters.

    This strategy:
    1. Detects document type (Markdown, HTML, Code, etc.)
    2. Uses appropriate LangChain splitter for the document type
    3. Preserves document structure and metadata
    4. Handles mixed content documents
    """

    def __init__(
        self,
        chunk_size: int = 1000,
        chunk_overlap: int = 200,
        document_type: str = "auto",
        preserve_headers: bool = True,
        preserve_code_structure: bool = True,
        markdown_headers_to_split: list[tuple[str, str]] | None = None,
        html_headers_to_split: list[tuple[str, str]] | None = None,
        code_language: str = "python",
        **kwargs,
    ):
        """
        Initialize the document structure chunking strategy.

        Args:
            chunk_size: Target size of chunks in characters
            chunk_overlap: Amount of overlap between chunks
            document_type: Type of document ("auto", "markdown", "html", "code", "text")
            preserve_headers: Whether to preserve header structure in metadata
            preserve_code_structure: Whether to maintain code structure boundaries
            markdown_headers_to_split: Custom markdown headers for splitting
            html_headers_to_split: Custom HTML headers for splitting
            code_language: Programming language for code documents
            **kwargs: Additional parameters
        """
        super().__init__(chunk_size, chunk_overlap, **kwargs)

        self.document_type = document_type
        self.preserve_headers = preserve_headers
        self.preserve_code_structure = preserve_code_structure
        self.code_language = code_language

        # Default headers to split on
        self.markdown_headers_to_split = markdown_headers_to_split or [
            ("#", "Header 1"),
            ("##", "Header 2"),
            ("###", "Header 3"),
            ("####", "Header 4"),
            ("#####", "Header 5"),
            ("######", "Header 6"),
        ]

        self.html_headers_to_split = html_headers_to_split or [
            ("h1", "Header 1"),
            ("h2", "Header 2"),
            ("h3", "Header 3"),
            ("h4", "Header 4"),
            ("h5", "Header 5"),
            ("h6", "Header 6"),
        ]

    def split_text(self, text: str, document_metadata: dict[str, Any] | None = None) -> list[str]:
        """
        Split the input text based on document structure.

        Args:
            text: Input text to be chunked
            document_metadata: Optional metadata about the document

        Returns:
            List of text chunks
        """
        if not text or not text.strip():
            logger.warning("Empty text provided to document structure chunking")
            return []

        if not LANGCHAIN_SPLITTERS_AVAILABLE:
            logger.warning("LangChain text splitters not available, using fallback")
            return self._fallback_chunking(text)

        try:
            # Detect document type if set to auto
            detected_type = self._detect_document_type(text, document_metadata)

            # Split based on document type
            if detected_type == "markdown":
                chunks = self._split_markdown(text)
            elif detected_type == "html":
                chunks = self._split_html(text)
            elif detected_type == "code":
                chunks = self._split_code(text)
            else:
                chunks = self._split_generic_text(text)

            logger.info("Document structure chunking (%s) created %d chunks", detected_type, len(chunks))
            return chunks

        except Exception as e:
            logger.error("Error in document structure chunking: %s", str(e))
            return self._fallback_chunking(text)

    def _detect_document_type(self, text: str, metadata: dict[str, Any] | None = None) -> str:
        """
        Detect the document type based on content and metadata.

        Args:
            text: Document text
            metadata: Document metadata

        Returns:
            Detected document type
        """
        if self.document_type != "auto":
            return self.document_type

        # Check metadata first
        if metadata:
            file_name = metadata.get("file_name", "").lower()
            content_type = metadata.get("content_type", "").lower()

            if any(ext in file_name for ext in [".md", ".markdown"]):
                return "markdown"
            elif any(ext in file_name for ext in [".html", ".htm"]):
                return "html"
            elif any(ext in file_name for ext in [".py", ".js", ".java", ".cpp", ".c"]):
                return "code"
            elif "html" in content_type:
                return "html"
            elif "markdown" in content_type:
                return "markdown"

        # Analyze content patterns
        text_sample = text[:2000]  # Analyze first 2KB

        # Check for markdown patterns
        markdown_patterns = [
            r"^#{1,6}\s+",  # Headers
            r"^\*\s+",  # Bullet lists
            r"^\d+\.\s+",  # Numbered lists
            r"\*\*.*?\*\*",  # Bold text
            r"`.*?`",  # Inline code
            r"```.*?```",  # Code blocks
        ]

        markdown_score = sum(1 for pattern in markdown_patterns if re.search(pattern, text_sample, re.MULTILINE))

        # Check for HTML patterns
        html_patterns = [
            r"</?[a-zA-Z][^>]*>",  # HTML tags
            r"&[a-zA-Z0-9]+;",  # HTML entities
        ]

        html_score = sum(1 for pattern in html_patterns if re.search(pattern, text_sample))

        # Check for code patterns
        code_patterns = [
            r"(def|function|class|import|from|#include)\s+",  # Keywords
            r"[{}();]",  # Code syntax
            r"^\s*//.*$",  # Comments
            r"^\s*#.*$",  # Python comments
        ]

        code_score = sum(1 for pattern in code_patterns if re.search(pattern, text_sample, re.MULTILINE))

        # Determine type based on scores
        if markdown_score >= 2:
            return "markdown"
        elif html_score >= 2:
            return "html"
        elif code_score >= 3:
            return "code"
        else:
            return "text"

    def _split_markdown(self, text: str) -> list[str]:
        """Split Markdown text using MarkdownHeaderTextSplitter."""
        try:
            # Primary split by headers
            markdown_splitter = MarkdownHeaderTextSplitter(headers_to_split_on=self.markdown_headers_to_split, return_each_line=False)

            md_header_splits = markdown_splitter.split_text(text)

            # Secondary split if chunks are too large (based on token count)
            chunks = []
            for doc in md_header_splits:
                content = doc.page_content if hasattr(doc, "page_content") else str(doc)
                content_tokens = self.count_tokens(content)

                if content_tokens <= self.chunk_size:
                    chunks.append(content)
                else:
                    # Further split large chunks
                    sub_chunks = self._split_large_chunk(content)
                    chunks.extend(sub_chunks)

            return chunks

        except Exception as e:
            logger.error("Error in markdown splitting: %s", str(e))
            return self._split_generic_text(text)

    def _split_html(self, text: str) -> list[str]:
        """Split HTML text using HTMLHeaderTextSplitter."""
        try:
            # Primary split by headers
            html_splitter = HTMLHeaderTextSplitter(headers_to_split_on=self.html_headers_to_split)

            html_header_splits = html_splitter.split_text(text)

            # Secondary split if chunks are too large (based on token count)
            chunks = []
            for doc in html_header_splits:
                content = doc.page_content if hasattr(doc, "page_content") else str(doc)
                content_tokens = self.count_tokens(content)

                if content_tokens <= self.chunk_size:
                    chunks.append(content)
                else:
                    # Further split large chunks
                    sub_chunks = self._split_large_chunk(content)
                    chunks.extend(sub_chunks)

            return chunks

        except Exception as e:
            logger.error("Error in HTML splitting: %s", str(e))
            return self._split_generic_text(text)

    def _split_code(self, text: str) -> list[str]:
        """Split code text using language-specific splitters."""
        try:
            # Determine the appropriate code splitter
            if self.code_language.lower() == "python":
                code_splitter = PythonCodeTextSplitter(chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap)
            elif self.code_language.lower() in ["javascript", "js"]:
                # noinspection PyCallingNonCallable
                code_splitter = JavaScriptCodeTextSplitter(chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap)
            else:
                # Use generic recursive splitter with code-friendly separators
                # noinspection PyUnresolvedReferences
                code_splitter = RecursiveCharacterTextSplitter.from_language(
                    # noinspection PyUnresolvedReferences
                    language=Language.PYTHON,  # Default fallback
                    chunk_size=self.chunk_size,
                    chunk_overlap=self.chunk_overlap,
                )

            chunks = code_splitter.split_text(text)
            return chunks

        except Exception as e:
            logger.error("Error in code splitting: %s", str(e))
            return self._split_generic_text(text)

    def _split_generic_text(self, text: str) -> list[str]:
        """Split generic text using RecursiveCharacterTextSplitter."""
        try:
            text_splitter = RecursiveCharacterTextSplitter(
                chunk_size=self.chunk_size, chunk_overlap=self.chunk_overlap, separators=["\n\n", "\n", ". ", " ", ""]
            )

            return text_splitter.split_text(text)

        except Exception as e:
            logger.error("Error in generic text splitting: %s", str(e))
            return self._fallback_chunking(text)

    def _split_large_chunk(self, chunk: str) -> list[str]:
        """Split a chunk that's too large using centralized utility."""
        # noinspection PyUnresolvedReferences
        from src.main.utils.documents.utils import split_large_chunk_with_recursive_splitter

        return split_large_chunk_with_recursive_splitter(chunk, self.chunk_size, self.chunk_overlap)

    def _fallback_chunking(self, text: str) -> list[str]:
        """
        Fallback to simple paragraph-based chunking.

        Args:
            text: Text to chunk

        Returns:
            List of text chunks
        """
        logger.info("Using fallback paragraph-based chunking")

        # Use centralized paragraph-based chunking utility
        from src.main.utils.documents.utils import paragraph_based_chunking

        chunks = paragraph_based_chunking(text.strip(), self.chunk_size, overlap=True)

        return chunks

    def get_metadata(self) -> dict[str, Any]:
        """
        Get metadata about the chunking strategy.

        Returns:
            Dictionary containing strategy metadata
        """
        metadata = super().get_metadata()
        metadata.update(
            {
                "document_type": self.document_type,
                "preserve_headers": self.preserve_headers,
                "preserve_code_structure": self.preserve_code_structure,
                "code_language": self.code_language,
                "markdown_headers": self.markdown_headers_to_split,
                "html_headers": self.html_headers_to_split,
                "langchain_splitters_available": LANGCHAIN_SPLITTERS_AVAILABLE,
            }
        )
        return metadata


class MarkdownChunkingStrategy(DocumentStructureChunkingStrategy):
    """Specialized chunking for Markdown documents."""

    def __init__(self, **kwargs):
        """Initialize Markdown-specific chunking."""
        super().__init__(document_type="markdown", **kwargs)


class HTMLChunkingStrategy(DocumentStructureChunkingStrategy):
    """Specialized chunking for HTML documents."""

    def __init__(self, **kwargs):
        """Initialize HTML-specific chunking."""
        super().__init__(document_type="html", **kwargs)


class CodeChunkingStrategy(DocumentStructureChunkingStrategy):
    """Specialized chunking for code documents."""

    def __init__(self, language: str = "python", **kwargs):
        """
        Initialize code-specific chunking.

        Args:
            language: Programming language
            **kwargs: Additional parameters
        """
        super().__init__(document_type="code", code_language=language, **kwargs)
