"""
Intelligent Chunking Service for Document Processing Pipeline.

This service implements Stage 2 of the ingestion-indexing pipeline as described in
03-ingestion-indexing.md. It provides intelligent chunking that respects meaning
boundaries and document structure.

Features:
- Strategy-based chunking with user preference support via user_settings table
- Document type detection for optimal strategy selection
- Performance optimization with caching
- Integration with document processing pipeline
"""

import hashlib
import json
import re
from typing import Any

from src.main.service.rag.chunking import (
    get_available_strategies,
    get_chunking_strategy,
)
from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class ChunkingService:
    """
    Intelligent chunking service that integrates with the document processing pipeline.

    This service follows the existing codebase pattern of storing user preferences
    in the user_settings table rather than using config-based settings.
    """

    def __init__(self):
        self.config = resolved_config.get("rag", {})
        self.default_strategy = self.config.get("default_strategy", "enhanced_markdown")
        self._chunk_cache = {}
        self._cache_max_size = 100  # Reasonable cache size

    def chunk_document(
        self,
        text: str,
        document_metadata: dict[str, Any],
        user_id: str = None,
        strategy_override: str = None,
        db_session=None,
        chunk_size: int | None = None,
        chunk_overlap: int | None = None,
        min_chunk_size: int | None = None,
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """
        Chunk a document using intelligent strategy selection.

        Args:
                text: Document text to chunk
                document_metadata: Document metadata for strategy selection
                user_id: User ID for preference lookup
                strategy_override: Explicit strategy to use (overrides user preference)
                db_session: Database session for user preference lookup
                chunk_size: Optional chunk size override from user settings
                chunk_overlap: Optional chunk overlap override from user settings
                min_chunk_size: Optional minimum chunk size (chunks to ignore) from user settings

        Returns:
                Tuple of (chunk_results, document_hierarchy):
                - chunk_results: List of chunk dictionaries with text, metadata, and strategy info
                - document_hierarchy: Dict containing document structure information (or empty dict)

        Note:
                For markdown/semantic splitters: chunk_size and chunk_overlap are guidance/limits
                For recursive splitter: chunk_size and chunk_overlap are strict character counts
        """
        try:
            # Determine chunking strategy
            strategy_name = self._determine_strategy(document_metadata, user_id, strategy_override, db_session)

            # Get strategy parameters from user settings or defaults
            strategy_params = self._get_strategy_parameters(strategy_name, user_id, db_session)

            # Override with explicitly provided parameters (from user settings)
            if chunk_size is not None:
                # Auto-adjust chunk_size if too small for the strategy
                adjusted_chunk_size = self._apply_minimum_chunk_size_for_strategy(strategy_name, chunk_size)
                strategy_params["chunk_size"] = adjusted_chunk_size
                if adjusted_chunk_size != chunk_size:
                    logger.info(
                        "Auto-adjusted chunk_size from %d to %d for strategy %s (minimum required)",
                        chunk_size,
                        adjusted_chunk_size,
                        strategy_name,
                    )
                else:
                    logger.debug(
                        "Using user-specified chunk_size: %d for strategy %s",
                        chunk_size,
                        strategy_name,
                    )
            if chunk_overlap is not None:
                strategy_params["chunk_overlap"] = chunk_overlap
                logger.debug(
                    "Using user-specified chunk_overlap: %d for strategy %s",
                    chunk_overlap,
                    strategy_name,
                )
            if min_chunk_size is not None:
                strategy_params["min_chunk_size"] = min_chunk_size
                logger.debug(
                    "Using user-specified min_chunk_size: %d for strategy %s",
                    min_chunk_size,
                    strategy_name,
                )

            # Check cache
            cache_key = self._get_cache_key(text, strategy_name, strategy_params)
            if cache_key in self._chunk_cache:
                logger.debug("Using cached chunking result for strategy %s", strategy_name)
                return self._chunk_cache[cache_key]

            # Get a chunking strategy instance
            chunking_strategy = get_chunking_strategy(strategy_name, **strategy_params)

            # Perform chunking - check if strategy supports hierarchy extraction
            document_hierarchy = {}
            chunks_with_metadata = None

            if hasattr(chunking_strategy, "split_text_with_hierarchy"):
                # Enhanced strategies return (chunks, hierarchy)
                try:
                    chunks_with_metadata, document_hierarchy = chunking_strategy.split_text_with_hierarchy(text)
                    # Extract text for backward compatibility
                    chunks = [chunk["text"] for chunk in chunks_with_metadata]
                    logger.debug(
                        "Extracted hierarchy with %d top-level sections using %s strategy",
                        len(document_hierarchy),
                        strategy_name,
                    )
                except Exception as e:
                    logger.warning(
                        "Failed to extract hierarchy using %s strategy: %s. Falling back to split_text().",
                        strategy_name,
                        str(e),
                    )
                    # Fallback to standard split_text if hierarchy extraction fails
                    chunks = chunking_strategy.split_text(text)
            else:
                # Fallback for strategies without hierarchy support
                chunks = chunking_strategy.split_text(text)

            # Format results with metadata
            chunk_results = []
            for i, chunk_text in enumerate(chunks):
                # Get enhanced metadata if available from hierarchy extraction
                enhanced_metadata = {}
                # noinspection PyTypeChecker
                if chunks_with_metadata is not None and i < len(chunks_with_metadata):
                    # Sanitize section_title: reject garbage headings from PDF parsing
                    # noinspection PyUnresolvedReferences
                    raw_section = chunks_with_metadata[i].get("section_title", "")
                    raw_section = self._sanitize_section_heading(raw_section)
                    # noinspection PyUnresolvedReferences
                    enhanced_metadata = {
                        "parent_chunk_range": chunks_with_metadata[i].get("parent_chunk_range", [i, i]),
                        "section_chunk_range": chunks_with_metadata[i].get("section_chunk_range", [i, i]),
                        "section_heading": raw_section,
                        "chapter_number": chunks_with_metadata[i].get("chapter_number", 1),
                        "section_number": chunks_with_metadata[i].get("section_number", 1),
                        "chapter_title": chunks_with_metadata[i].get("chapter_title", ""),
                        "header_level": chunks_with_metadata[i].get("header_level"),
                        "is_new_chapter": chunks_with_metadata[i].get("is_new_chapter", False),
                        "is_new_section": chunks_with_metadata[i].get("is_new_section", False),
                    }

                chunk_result = {
                    "text": chunk_text,
                    "index": i,
                    "strategy": strategy_name,
                    "metadata": {
                        **document_metadata,
                        **enhanced_metadata,  # Add hierarchy metadata
                        "chunk_index": i,
                        "total_chunks": len(chunks),
                        "strategy_used": strategy_name,
                        "chunk_size": len(chunk_text),
                    },
                }
                chunk_results.append(chunk_result)

            # BUG FIX #7: Filter micro-chunks that hurt retrieval quality
            # Footnote fragments (38-87 chars) and other noise should be removed
            # noinspection PyPep8Naming
            MIN_CHUNK_CHARS = 80
            pre_filter_count = len(chunk_results)
            chunk_results = [c for c in chunk_results if len(c.get("text", "")) >= MIN_CHUNK_CHARS]
            filtered_count = pre_filter_count - len(chunk_results)
            if filtered_count > 0:
                logger.info(
                    "Filtered %d micro-chunks (<%d chars) from %d total",
                    filtered_count,
                    MIN_CHUNK_CHARS,
                    pre_filter_count,
                )
                # Re-index after filtering
                for i, chunk in enumerate(chunk_results):
                    chunk["index"] = i
                    chunk["metadata"]["chunk_index"] = i
                    chunk["metadata"]["total_chunks"] = len(chunk_results)

            # When the primary strategy produces no usable chunks (e.g. all content was
            # stripped as headers/footers by enhanced_markdown), fall back to recursive
            # chunking on the original text so the page content is not silently lost.
            if not chunk_results and strategy_name != "recursive":
                logger.info(
                    "Strategy %s produced 0 chunks; falling back to recursive chunking",
                    strategy_name,
                )
                chunk_results = self._fallback_chunking(text, document_metadata)
                document_hierarchy = {}

            # Return hierarchy separately as a tuple to avoid attribute assignment error
            # Python built-in list type doesn't support custom attributes
            if document_hierarchy:
                logger.info(
                    "Chunked document using %s strategy: %d chunks, %d hierarchy sections",
                    strategy_name,
                    len(chunk_results),
                    len(document_hierarchy),
                )
            else:
                logger.info(
                    "Chunked document using %s strategy: %d chunks",
                    strategy_name,
                    len(chunk_results),
                )

            # Cache result (with size limit)
            if len(self._chunk_cache) >= self._cache_max_size:
                # Remove oldest entry (simple FIFO)
                oldest_key = next(iter(self._chunk_cache))
                del self._chunk_cache[oldest_key]

            # Cache the full tuple so that callers unpacking (chunk_results, hierarchy) get the
            # correct types regardless of whether this is a cache hit or a fresh computation.
            result = (chunk_results, document_hierarchy if document_hierarchy else {})
            self._chunk_cache[cache_key] = result
            return result

        except Exception as e:
            logger.error("Error in intelligent chunking: %s", str(e))
            # Fallback to simple chunking - return tuple with empty hierarchy
            return self._fallback_chunking(text, document_metadata), {}

    # Known valid short acronyms that should be kept as section headings
    _VALID_ACRONYMS = frozenset(
        {
            "FAQ",
            "USA",
            "EU",
            "UN",
            "WHO",
            "GMO",
            "DNA",
            "RNA",
            "GDP",
            "FAO",
            "USDA",
            "NATO",
            "UNESCO",
            "IAEA",
            "IEEE",
            "OECD",
            "OPEC",
            "NASA",
            "CERN",
        }
    )

    _LEGAL_PHRASES = frozenset(
        [
            "the author(s)",
            "under exclusive license",
            "copyright",
            "all rights reserved",
            "isbn",
            "doi:",
            "springer",
            "published by",
            "©",
            "publishing",
            "press",
        ]
    )

    @staticmethod
    def _sanitize_section_heading(raw: str) -> str:
        """Reject garbage headings from PDF parsing — mirrors node_factory.py validation."""
        if not raw or not raw.strip():
            return ""
        raw = raw.strip()

        # Must start with uppercase letter or digit
        if not raw[0].isupper() and not raw[0].isdigit():
            return ""
        # Too short (single char, "I", "T")
        if len(raw) < 3:
            return ""
        # Pure numeric with optional separators: "1", "123", "1.2", "3-4"
        if raw.replace(".", "").replace("-", "").replace(" ", "").isdigit():
            return ""
        # Roman numerals: "I", "IV", "XII", "XLII"
        if re.match(r"^[IVXLCDM]+$", raw):
            return ""
        # Generic "Section N"
        if re.match(r"^Section\s+\d+$", raw):
            return ""
        # Short all-caps abbreviations (2-5 chars) that aren't known acronyms
        if re.match(r"^[A-Z]{2,5}$", raw) and raw not in ChunkingService._VALID_ACRONYMS:
            return ""
        # Legal/copyright/publisher content
        if any(phrase in raw.lower() for phrase in ChunkingService._LEGAL_PHRASES):
            return ""
        # Table/code headers: contain brackets, or mostly uppercase tokens with numbers
        # e.g., "SA SV 1M [II] MA 2M 1H 2H"
        if re.search(r"\[.*\]", raw):
            return ""
        # Mostly short uppercase tokens with numbers — likely table column headers
        tokens = raw.split()
        if len(tokens) >= 3 and all(len(t) <= 3 for t in tokens):
            return ""
        # Mixed-case OCR artifacts: words with uppercase in the middle (e.g., "foreST invenTorieS")
        if any(re.search(r"[a-z][A-Z]", word) for word in raw.split()):
            return ""
        # Content leak detection
        if (
            len(raw) > 80
            or re.search(r"[,;&]\s", raw)  # commas, semicolons, ampersands within text
            or raw.rstrip().endswith((",", ".", ";"))  # trailing punctuation
            or re.match(r"^\d+\.\s+[A-Z][a-z]", raw)  # numbered paragraph "7. In crossing..."
            or raw.startswith(".")
            or re.search(r"[()]\s*;?", raw)  # contains parentheses: citation fragments
            or re.search(r"\d{2,}$", raw)  # ends with page number: "Conclusion 161"
            or re.search(r'[""\u201C\u201D]', raw)  # contains quotes: sentence fragment
            or re.search(r"[°±²³]", raw)  # degree/math symbols: garbage coordinates
        ):
            return ""
        # Sentence fragment: >5 words with lowercase function words = likely a sentence, not a heading
        words = raw.split()
        function_words = {
            "the",
            "a",
            "an",
            "of",
            "in",
            "on",
            "to",
            "for",
            "and",
            "or",
            "is",
            "was",
            "are",
            "were",
            "has",
            "have",
            "had",
            "into",
            "with",
            "that",
            "this",
            "from",
        }
        if len(words) > 5 and sum(1 for w in words if w.lower() in function_words) >= 2:
            return ""
        # Short garbage: <=3 chars that aren't known acronyms (catches OCR artifacts like "CtiD")
        if len(raw) <= 4 and not raw.isupper():
            return ""
        return raw

    def _determine_strategy(
        self,
        document_metadata: dict[str, Any],
        user_id: str = None,
        strategy_override: str = None,
        db_session=None,
    ) -> str:
        """
        Determine the best chunking strategy based on user preferences and document type.
        """
        # 1. Use explicit override if provided
        if strategy_override:
            return strategy_override

        # 2. Check user preferences from user_settings table
        if user_id and db_session:
            user_strategy = self._get_user_chunking_preference(user_id, db_session)
            if user_strategy:
                return user_strategy

        # 3. Check if graph features are enabled and use graph-optimized chunking
        graph_config = self.config.get("graph", {})
        graph_enabled = graph_config.get("enabled", False)

        if graph_enabled:
            graph_chunking_config = self.config.get("rag", {}).get("graph_optimized_chunking", {})
            if graph_chunking_config.get("enabled", True):
                return self._determine_graph_optimized_strategy(document_metadata, graph_chunking_config)

        # 4. Auto-detect based on document type (original logic)
        document_type = document_metadata.get("type", "")
        file_name = document_metadata.get("file_name", "").lower()

        if document_type == "pdf" or file_name.endswith(".pdf"):
            # PDFs often have structured content, enhanced markdown works well
            return "enhanced_markdown"
        elif file_name.endswith((".md", ".markdown")):
            # Markdown files should use enhanced markdown chunking
            return "enhanced_markdown"
        elif file_name.endswith((".txt", ".text")):
            # Plain text files work well with semantic chunking
            return "semantic"

        # 5. Fall back to configured default
        return self.default_strategy

    @staticmethod
    def _determine_graph_optimized_strategy(document_metadata: dict[str, Any], graph_chunking_config: dict[str, Any]) -> str:
        """
        Determine the best chunking strategy for graph construction.

        Prioritizes semantic coherence over structural boundaries for entity extraction.
        """
        try:
            strategy_selection = graph_chunking_config.get("strategy_selection", {})
            file_name = document_metadata.get("file_name", "").lower()
            document_type = document_metadata.get("type", "").lower()

            # Check document category and content type
            if any(keyword in file_name for keyword in ["paper", "research", "journal", "article"]):
                return strategy_selection.get("academic_papers", "semantic")
            elif any(keyword in file_name for keyword in ["manual", "guide", "doc", "specification"]):
                return strategy_selection.get("technical_docs", "semantic")
            elif any(keyword in file_name for keyword in ["book", "chapter", "novel"]):
                return strategy_selection.get("books", "semantic")
            elif file_name.endswith((".md", ".markdown")):
                return strategy_selection.get("markdown_files", "enhanced_markdown")
            elif file_name.endswith((".txt", ".text")) or document_type == "text":
                return strategy_selection.get("plain_text", "semantic")

            # Default to preferred strategy for graph construction
            return graph_chunking_config.get("preferred_strategy", "semantic")

        except Exception as e:
            logger.warning("Error determining graph-optimized strategy: %s", str(e))
            return graph_chunking_config.get("fallback_strategy", "enhanced_markdown")

    @staticmethod
    def _get_user_chunking_preference(user_id: str, db_session) -> str | None:
        """
        Get user's chunking strategy preference from user_settings table.

        This follows the existing pattern used for document_embedding_settings.
        """
        try:
            from sqlalchemy import text

            # Query user settings following the established pattern
            # First try document_processing settings (preferred)
            query = text("""
                SELECT setting_value FROM user_settings
                WHERE user_id = :user_id AND setting_key = 'document_processing'
            """)

            result = db_session.execute(query, {"user_id": user_id}).fetchone()

            if result and result[0]:
                settings = result[0] if isinstance(result[0], dict) else json.loads(result[0])
                logger.debug(
                    "Found document_processing settings for user %s: %s",
                    user_id,
                    settings,
                )

                # Use splitter_type from frontend settings (preferred)
                splitter_type = settings.get("splitter_type")
                if splitter_type:
                    logger.info(
                        "Using splitter_type from document_processing settings: %s",
                        splitter_type,
                    )
                    return splitter_type

                # Check for chunking_strategy setting
                chunking_strategy = settings.get("chunking_strategy")
                if chunking_strategy:
                    return chunking_strategy

            # Fallback to document_embedding_settings for backward compatibility
            query = text("""
                SELECT setting_value FROM user_settings
                WHERE user_id = :user_id AND setting_key = 'document_embedding_settings'
            """)

            result = db_session.execute(query, {"user_id": user_id}).fetchone()

            if result and result[0]:
                settings = result[0] if isinstance(result[0], dict) else json.loads(result[0])
                logger.debug(
                    "Found document_embedding_settings for user %s: %s",
                    user_id,
                    settings,
                )

                # Map old splitter_type to new strategy names for backward compatibility
                splitter_type = settings.get("splitter_type", "")
                strategy_map = {
                    # Basic strategies
                    "recursive": "recursive",
                    "semantic": "semantic",
                    "markdown": "enhanced_markdown",  # Upgrade to enhanced version
                    "enhanced_markdown": "enhanced_markdown",
                    "proposition": "proposition",
                    # Advanced strategies
                    "hierarchical": "hierarchical",
                    "topic_based": "topic_based",
                    "sliding_window": "sliding_window",
                    "agentic": "agentic",
                    "concept_aware": "concept_aware",
                    "narrative_structure": "narrative_structure",
                    # LangChain strategies
                    "token_based": "token_based",
                    "gpt_token": "gpt_token",
                    "claude_token": "claude_token",
                    "openai_semantic": "openai_semantic",
                    "huggingface_semantic": "huggingface_semantic",
                    "document_structure": "document_structure",
                    "langchain_markdown": "langchain_markdown",
                    "html": "html",
                    "code": "code",
                }
                mapped_strategy = strategy_map.get(splitter_type)
                if mapped_strategy:
                    logger.info(
                        "Using mapped strategy from document_embedding_settings: %s -> %s",
                        splitter_type,
                        mapped_strategy,
                    )
                    return mapped_strategy

        except Exception as e:
            logger.warning("Could not retrieve user chunking preference: %s", str(e))

        return None

    def _get_strategy_parameters(self, strategy_name: str, user_id: str = None, db_session=None) -> dict[str, Any]:
        """
        Get parameters for the chunking strategy from user settings or defaults.
        """
        params = {}

        # Get user-specific parameters if available
        if user_id and db_session:
            user_params = self._get_user_strategy_parameters(user_id, db_session)
            params.update(user_params)

        # Check if graph features are enabled for optimized parameters
        graph_config = self.config.get("graph", {})
        graph_enabled = graph_config.get("enabled", False)
        graph_chunking_config = self.config.get("rag", {}).get("graph_optimized_chunking", {})

        if graph_enabled and graph_chunking_config.get("enabled", True):
            # Use graph-optimized parameters
            params.update(self._get_graph_optimized_parameters(strategy_name, graph_chunking_config))
        else:
            # Use standard strategy-specific defaults
            self._apply_standard_strategy_defaults(strategy_name, params)

        return params

    @staticmethod
    def _get_graph_optimized_parameters(strategy_name: str, graph_chunking_config: dict[str, Any]) -> dict[str, Any]:
        """
        Get graph-optimized parameters for chunking strategies.

        These parameters prioritize semantic coherence and entity context preservation.
        """
        params = {}

        # Base parameters from graph config
        min_chunk_size = graph_chunking_config.get("min_chunk_size", 200)
        max_chunk_size = graph_chunking_config.get("max_chunk_size", 1200)
        overlap_ratio = graph_chunking_config.get("overlap_ratio", 0.25)

        # Calculate overlap based on average chunk size
        avg_chunk_size = (min_chunk_size + max_chunk_size) // 2
        chunk_overlap = int(avg_chunk_size * overlap_ratio)

        if strategy_name == "semantic":
            params.update(
                {
                    "chunk_size": max_chunk_size,
                    "chunk_overlap": chunk_overlap,
                    "min_chunk_size": min_chunk_size,
                    "max_chunk_size": max_chunk_size,
                    "method": "percentile",
                    "threshold": graph_chunking_config.get("semantic_threshold", 85),
                }
            )
        elif strategy_name == "enhanced_markdown":
            fallback_params = graph_chunking_config.get("fallback_params", {})
            params.update(
                {
                    "chunk_size": max_chunk_size,
                    "chunk_overlap": chunk_overlap,
                    "preserve_elements": fallback_params.get("preserve_elements", True),
                    "enable_semantic_boundaries": fallback_params.get("enable_semantic_boundaries", True),
                    "min_section_length": fallback_params.get("min_section_length", 150),
                }
            )
        elif strategy_name == "recursive":
            # Convert to token-based sizing for recursive strategy
            token_chunk_size = max_chunk_size // 4  # Rough char to token conversion
            token_overlap = chunk_overlap // 4
            params.update({"chunk_size": token_chunk_size, "chunk_overlap": token_overlap})
        elif strategy_name == "proposition":
            # Slightly larger for propositions
            params.update({"chunk_size": min_chunk_size + 100, "chunk_overlap": chunk_overlap})
        elif strategy_name == "two_phase":
            # Two-phase chunking with structure preservation and size optimization
            params.update(
                {
                    "target_chunk_size": max_chunk_size,
                    "max_chunk_size": int(max_chunk_size * 1.5),  # Allow 50% larger for structure preservation
                    "min_chunk_size": min_chunk_size,
                    "overlap_size": chunk_overlap,
                    "enable_smart_merging": True,
                    "preserve_boundaries": True,
                }
            )

        return params

    @staticmethod
    def _apply_standard_strategy_defaults(strategy_name: str, params: dict[str, Any]):
        """Apply standard strategy-specific defaults (original logic)"""
        if strategy_name == "semantic":
            params.setdefault("chunk_size", 1000)
            params.setdefault("chunk_overlap", 200)
            params.setdefault("method", "percentile")
            params.setdefault("threshold", 90)
        elif strategy_name == "enhanced_markdown":
            params.setdefault("chunk_size", 1000)
            params.setdefault("chunk_overlap", 200)
            params.setdefault("preserve_elements", True)
            params.setdefault("enable_semantic_boundaries", True)
        elif strategy_name == "recursive":
            # Convert character-based sizes to token-based for recursive strategy
            chunk_size = params.get("chunk_size", 256)
            if chunk_size > 2000:  # Assume it's in characters, convert to tokens
                chunk_size = chunk_size // 4  # Rough conversion
            params["chunk_size"] = chunk_size
            params.setdefault("chunk_overlap", 64)
        elif strategy_name == "proposition":
            params.setdefault("chunk_size", 500)
            params.setdefault("chunk_overlap", 100)
        elif strategy_name == "two_phase":
            # Two-phase chunking defaults
            params.setdefault("target_chunk_size", 1000)
            params.setdefault("max_chunk_size", 2000)
            params.setdefault("min_chunk_size", 200)
            params.setdefault("overlap_size", 100)
            params.setdefault("enable_smart_merging", True)
            params.setdefault("preserve_boundaries", True)

    @staticmethod
    def _apply_minimum_chunk_size_for_strategy(strategy_name: str, chunk_size: int) -> int:
        """
        Apply minimum chunk size based on strategy to prevent breaking document structure.

        Different strategies have different minimum requirements:
        - Markdown/Enhanced Markdown: Need larger chunks to preserve paragraphs and structure
        - Semantic: Need enough context for semantic boundaries
        - Recursive: Can work with smaller chunks since it splits anywhere

        Args:
            strategy_name: The chunking strategy being used
            chunk_size: The requested chunk size

        Returns:
            Adjusted chunk size (original or increased to minimum)
        """
        # Define minimum chunk sizes for each strategy
        minimum_sizes = {
            "enhanced_markdown": 512,  # Paragraphs can be 200-500 chars
            "markdown": 512,  # Same as enhanced
            "semantic": 400,  # Need context for semantic boundaries
            "recursive": 200,  # Can split anywhere
            "proposition": 300,  # Propositions need some context
            "sliding_window": 200,  # Flexible splitting
            "token_based": 200,  # Token-based can be smaller
            "two_phase": 600,  # Two-phase needs larger chunks for intelligent merging
        }

        min_size = minimum_sizes.get(strategy_name, 400)  # Default to 400

        if chunk_size < min_size:
            logger.warning(
                "Chunk size %d is too small for strategy '%s' (min: %d). Auto-adjusting to prevent structure breaking.",
                chunk_size,
                strategy_name,
                min_size,
            )
            return min_size

        return chunk_size

    @staticmethod
    def _get_user_strategy_parameters(user_id: str, db_session) -> dict[str, Any]:
        """
        Get user-specific strategy parameters from user_settings table.
        """
        try:
            from sqlalchemy import text

            query = text("""
                SELECT setting_value FROM user_settings
                WHERE user_id = :user_id AND setting_key = 'document_processing_settings'
            """)

            result = db_session.execute(query, {"user_id": user_id}).fetchone()

            if result and result[0]:
                settings = result[0] if isinstance(result[0], dict) else json.loads(result[0])

                # Extract chunking parameters from user settings
                params = {}

                # Map UI chunk size values to actual sizes
                chunk_size = settings.get("chunk_size")
                if isinstance(chunk_size, str):
                    size_mapping = {
                        "low": 256,
                        "medium": 512,
                        "high": 1024,
                        "highest": 2048,
                    }
                    params["chunk_size"] = size_mapping.get(chunk_size, 512)
                elif isinstance(chunk_size, int):
                    params["chunk_size"] = chunk_size

                # Map UI chunk overlap values
                chunk_overlap = settings.get("chunk_overlap")
                if isinstance(chunk_overlap, str):
                    overlap_mapping = {
                        "low": 64,
                        "medium": 128,
                        "high": 256,
                        "highest": 512,
                    }
                    params["chunk_overlap"] = overlap_mapping.get(chunk_overlap, 128)
                elif isinstance(chunk_overlap, int):
                    params["chunk_overlap"] = chunk_overlap

                # Extract semantic chunking settings
                semantic_settings = settings.get("semantic_chunking", {})
                if semantic_settings.get("enabled"):
                    params["method"] = semantic_settings.get("method", "percentile")
                    params["threshold"] = semantic_settings.get("threshold", 90)

                # Extract markdown chunking settings
                markdown_settings = settings.get("markdown_chunking", {})
                if markdown_settings.get("enabled"):
                    params["return_each_line"] = markdown_settings.get("return_each_line", False)
                    params["strip_headers"] = markdown_settings.get("strip_headers", False)

                return params

        except Exception as e:
            logger.warning("Could not retrieve user strategy parameters: %s", str(e))

        return {}

    @staticmethod
    def _get_cache_key(text: str, strategy_name: str, params: dict[str, Any]) -> str:
        """Generate a cache key for a chunking result."""
        content = f"{strategy_name}:{json.dumps(params, sort_keys=True)}:{text[:100]}"
        return hashlib.md5(content.encode()).hexdigest()

    @staticmethod
    def _fallback_chunking(text: str, document_metadata: dict[str, Any]) -> list[dict[str, Any]]:
        """Fallback chunking when intelligent chunking fails."""
        try:
            chunking_strategy = get_chunking_strategy("recursive", chunk_size=512, chunk_overlap=128)
            chunks = chunking_strategy.split_text(text)

            chunk_results = []
            for i, chunk_text in enumerate(chunks):
                chunk_result = {
                    "text": chunk_text,
                    "index": i,
                    "strategy": "recursive_fallback",
                    "metadata": {
                        **document_metadata,
                        "chunk_index": i,
                        "total_chunks": len(chunks),
                        "strategy_used": "recursive_fallback",
                        "chunk_size": len(chunk_text),
                    },
                }
                chunk_results.append(chunk_result)

            logger.warning("Used fallback chunking strategy: %d chunks", len(chunk_results))
            return chunk_results

        except Exception as e:
            logger.error("Fallback chunking also failed: %s", str(e))
            # Ultimate fallback - simple text splitting
            chunk_size = 1000
            chunks = [text[i : i + chunk_size] for i in range(0, len(text), chunk_size)]
            return [
                {
                    "text": chunk,
                    "index": i,
                    "strategy": "simple_fallback",
                    "metadata": {
                        **document_metadata,
                        "chunk_index": i,
                        "total_chunks": len(chunks),
                    },
                }
                for i, chunk in enumerate(chunks)
            ]

    def get_available_strategies(self) -> dict[str, dict[str, str]]:
        """Get dictionary of available chunking strategies with their details.

        Not cached: the underlying call returns a small static dict and using
        `@lru_cache` on an instance method holds self alive for the lifetime
        of the cache, which is a memory leak (ruff B019). If this ever shows
        up as a hotspot, cache the module-level `get_available_strategies()`
        call with `functools.cache` instead.
        """
        return get_available_strategies()

    def clear_cache(self):
        """Clear the chunking cache."""
        self._chunk_cache.clear()
        logger.info("Chunking cache cleared")


# Global instance management
_chunking_service = None


def get_chunking_service() -> ChunkingService:
    """Get a global chunking service instance."""
    global _chunking_service
    if _chunking_service is None:
        _chunking_service = ChunkingService()
    return _chunking_service
