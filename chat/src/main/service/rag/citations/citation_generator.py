"""
Citation Generator for RAG responses.

This module handles the extraction of retrieval results and formatting them
as structured citations for frontend consumption with multiple citation styles.
"""

from datetime import UTC, datetime
from enum import Enum
import os
from typing import Any

from langchain_core.documents import Document

from src.main.utils.core.datetime_utils import parse_iso_datetime
from src.main.utils.core.logger import get_logger
from src.main.utils.text.formatting import truncate_at_word_boundary

logger = get_logger(__name__)

try:
    from src.main.service.rag.citations.section_page_mapper import SectionPageMapper

    SECTION_MAPPING_AVAILABLE = True
except ImportError:
    logger.debug("Section page mapper not available")
    SECTION_MAPPING_AVAILABLE = False
    SectionPageMapper = None


class CitationStyle(Enum):
    """Supported citation styles."""

    INTERNAL = "internal"
    ACADEMIC_APA = "academic_apa"
    LEGAL_BLUEBOOK = "legal_bluebook"
    ISO = "iso"


class EnhancedCitationFormatter:
    """Formats citations in multiple academic and legal styles."""

    def __init__(self, style: CitationStyle = CitationStyle.INTERNAL):
        self.style = style

    def format_citation(self, citation: dict[str, Any]) -> str:
        """
        Format a citation according to the specified style.

        Args:
            citation: Citation dictionary with metadata

        Returns:
            Formatted citation string
        """
        if self.style == CitationStyle.INTERNAL:
            return self._format_internal(citation)
        elif self.style == CitationStyle.ACADEMIC_APA:
            return self._format_apa(citation)
        elif self.style == CitationStyle.LEGAL_BLUEBOOK:
            return self._format_bluebook(citation)
        elif self.style == CitationStyle.ISO:
            return self._format_iso(citation)
        else:
            return self._format_internal(citation)  # Fallback

    @staticmethod
    def _format_internal(citation: dict[str, Any]) -> str:
        """Internal reference style with version and timestamp."""
        source = citation.get("source", "Unknown")
        page = citation.get("page", 1)
        version = citation.get("document_version", "1.0")
        timestamp = citation.get("extraction_timestamp", "")

        # Include section information if available
        section_info = citation.get("primary_section")
        section_page_range = citation.get("section_page_range")

        # Extract date from ISO timestamp
        date_str = ""
        if timestamp:
            try:
                dt = parse_iso_datetime(timestamp)
                date_str = dt.strftime("%Y-%m-%d")
            except Exception as e:
                logger.debug("Suppressed exception: %s", e)

        # Format: "Tech Manual v1.0 §2.3 (p. 15-18, extracted 2025-12-05)"
        result = f"{source} v{version}"

        # Add section reference if available
        if section_info:
            result += f" §{section_info}"

        if page:
            # Use section page range if available, otherwise single page
            page_ref = section_page_range if section_page_range else f"p. {page}"
            result += f" ({page_ref}"
            if date_str:
                result += f", extracted {date_str}"
            result += ")"

        return result

    @staticmethod
    def _format_apa(citation: dict[str, Any]) -> str:
        """Academic APA style citation."""
        source = citation.get("source", "Unknown Document")
        page = citation.get("page", 1)
        timestamp = citation.get("extraction_timestamp", "")

        # Extract year from timestamp
        year = "n.d."
        if timestamp:
            try:
                dt = parse_iso_datetime(timestamp)
                year = str(dt.year)
            except Exception as e:
                logger.debug("Suppressed exception: %s", e)

        # Remove file extension from source
        if "." in source:
            source = source.rsplit(".", 1)[0]

        # Format: "Technical Manual. (2024). Organization., p. 15."
        return f"{source}. ({year}). p. {page}."

    @staticmethod
    def _format_bluebook(citation: dict[str, Any]) -> str:
        """Legal Bluebook style citation."""
        source = citation.get("source", "Unknown Document")
        page = citation.get("page", 1)
        timestamp = citation.get("extraction_timestamp", "")

        # Extract year from timestamp
        year = ""
        if timestamp:
            try:
                dt = parse_iso_datetime(timestamp)
                year = str(dt.year)
            except Exception as e:
                logger.debug("Suppressed exception: %s", e)

        # Remove file extension from source
        if "." in source:
            source = source.rsplit(".", 1)[0]

        # Format: "Technical Manual, at 15 (2024)."
        return f"{source}, at {page}{f' ({year})' if year else ''}."

    @staticmethod
    def _format_iso(citation: dict[str, Any]) -> str:
        """ISO standard reference style."""
        source = citation.get("source", "Unknown Document")
        page = citation.get("page", 1)
        version = citation.get("document_version", "1.0")
        timestamp = citation.get("extraction_timestamp", "")

        # Extract year from timestamp
        year = ""
        if timestamp:
            try:
                dt = parse_iso_datetime(timestamp)
                year = str(dt.year)
            except Exception as e:
                logger.debug("Suppressed exception: %s", e)

        # Remove file extension from source
        if "." in source:
            source = source.rsplit(".", 1)[0]

        # Format: "Organization Technical Manual, Edition 1.0:2024, Page 15"
        result = f"{source}, Edition {version}"
        if year:
            result += f":{year}"
        result += f", Page {page}"

        return result


class CitationGenerator:
    """Generates structured citations from retrieval results."""

    def __init__(self, citation_style: str | None = None):
        self.citation_counter = 0

        # Load citation style from configuration or use default
        if citation_style:
            try:
                self.citation_style = CitationStyle(citation_style)
            except ValueError:
                logger.warning("Invalid citation style '%s', using default internal", citation_style)
                self.citation_style = CitationStyle.INTERNAL
        else:
            # Load from config or use default
            self.citation_style = self._load_citation_style_from_config()

        self.formatter = EnhancedCitationFormatter(self.citation_style)

    @staticmethod
    def _load_citation_style_from_config() -> CitationStyle:
        """Load citation style from system configuration."""
        try:
            # noinspection PyUnresolvedReferences
            from src.main.service.system_settings_service import SystemSettingsService

            settings_service = SystemSettingsService()
            style_name = settings_service.get_setting("citation_default_style", "internal")

            try:
                return CitationStyle(style_name)
            except ValueError:
                logger.warning("Invalid citation style in config '%s', using internal", style_name)
                return CitationStyle.INTERNAL

        except Exception as e:
            logger.debug("Could not load citation style from config: %s", str(e))
            return CitationStyle.INTERNAL

    def generate_citations_from_documents(
        self, documents: list[Document], max_citations: int = 10, enable_section_mapping: bool = True
    ) -> list[dict[str, Any]]:
        """
        Generate structured citations from retrieved documents.

        Args:
            documents: List of retrieved documents from RAG
            max_citations: Maximum number of citations to generate
            enable_section_mapping: Whether to include section-to-page mapping

        Returns:
            List of citation dictionaries with structured metadata
        """
        citations = []
        self.citation_counter = 0

        # Create section mappings if enabled
        section_mappings = {}
        if enable_section_mapping and SECTION_MAPPING_AVAILABLE:
            try:
                mapper = SectionPageMapper()
                # Convert documents to format expected by mapper
                doc_list = []
                for doc in documents:
                    doc_list.append({"page_content": doc.page_content, "metadata": doc.metadata})
                section_mappings = mapper.create_section_mappings(doc_list)
                logger.debug("Created %d section mappings", len(section_mappings))
            except Exception as e:
                logger.warning("Failed to create section mappings: %s", str(e))

        for doc in documents[:max_citations]:
            try:
                citation = self._create_citation_from_document(doc, section_mappings)
                if citation:
                    citations.append(citation)
            except Exception as e:
                logger.warning("Failed to create citation from document: %s", str(e))
                continue

        logger.info("Generated %d citations from %d documents", len(citations), len(documents))
        return citations

    def _create_citation_from_document(self, doc: Document, section_mappings: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """
        Create a single citation from a document.

        Args:
            doc: LangChain Document object
            section_mappings: Optional section-to-page mappings

        Returns:
            Citation dictionary or None if creation fails
        """
        try:
            self.citation_counter += 1

            # Extract metadata from document
            metadata = doc.metadata or {}

            # Debug: Log metadata to understand available fields
            logger.debug("Document metadata for citation: %s", metadata)

            # Get document source information
            source = metadata.get("source", "Unknown Document")
            # Extract filename from path (handles both Unix and Windows paths)
            if "/" in source or "\\" in source:
                # Split by both separators and get the last part
                source = os.path.basename(source)

            # Get page information
            page_raw = metadata.get("page", metadata.get("page_number", 1))
            if isinstance(page_raw, str):
                try:
                    page = int(page_raw)
                except ValueError:
                    page = 1
            else:
                # noinspection PyTypeChecker
                page = int(page_raw) if page_raw is not None else 1

            # Get chunk information
            chunk_index = metadata.get("chunk_index", metadata.get("chunk_id", 0))
            if isinstance(chunk_index, str):
                try:
                    chunk_index = int(chunk_index)
                except ValueError:
                    chunk_index = 0

            # Get document content (truncate if too long)
            content = doc.page_content or ""
            if len(content) > 200:
                content = content[:200] + "..."

            # Construct URL for PDF viewer
            # The URL should be in the format: /documents/file/data/upload/{user_id}/{workspace_id}/{collection_id}/{filename}
            # Extract the relative path from the full path
            full_path = metadata.get("file_path") or metadata.get("document_path") or metadata.get("source", "")
            logger.debug("Citation generator: full_path from metadata: '%s'", full_path)

            # Extract the path starting from "data/upload/" using shared utility
            from src.main.utils.files.paths import normalize_upload_path_to_url

            # noinspection PyTypeChecker
            url = normalize_upload_path_to_url(str(full_path), source)
            logger.debug("Citation generator: normalized URL: '%s'", url)

            # Get enhanced section metadata if available
            section_metadata = {}
            if section_mappings and SECTION_MAPPING_AVAILABLE:
                try:
                    mapper = SectionPageMapper()
                    section_metadata = mapper.get_enhanced_citation_metadata(section_mappings, page, content)
                except Exception as e:
                    logger.debug("Failed to get section metadata: %s", str(e))

            # Create title with section information if available
            title = f"{source} - Page {page}"
            if "title" in metadata:
                title = f"{metadata['title']} - Page {page}"
            if section_metadata.get("primary_section"):
                title = f"{source} - {section_metadata['primary_section']} (Page {page})"

            citation = {
                "id": self.citation_counter,
                "source": source,
                "page": page,
                "chunk_index": chunk_index,
                "text": content,
                "url": url,
                "title": title,
                "score": metadata.get("score", metadata.get("relevance_score", 0.0)),
                "position_top_percent": metadata.get("position_top_percent"),
                "position_bottom_percent": metadata.get("position_bottom_percent"),
                # Legal compliance metadata
                "extraction_timestamp": metadata.get("extraction_timestamp"),
                "document_hash": metadata.get("document_hash"),
                "processing_pipeline": metadata.get("processing_pipeline"),
                "document_version": metadata.get("document_version", "1.0"),
                # Section mapping metadata
                **section_metadata,
                # Enhanced citation format with section information
                "formatted_citation": self.formatter.format_citation(
                    {
                        "source": source,
                        "page": page,
                        "extraction_timestamp": metadata.get("extraction_timestamp"),
                        "document_hash": metadata.get("document_hash"),
                        "document_version": metadata.get("document_version", "1.0"),
                        **section_metadata,
                    }
                ),
            }

            return citation

        except Exception as e:
            logger.error("Error creating citation from document: %s", str(e))
            return None

    @staticmethod
    def add_citations_to_response(response_content: str, citations: list[dict[str, Any]]) -> str:
        """
        Add citation markers to response content.

        Args:
            response_content: The generated response text
            citations: List of citation dictionaries

        Returns:
            Response content with citation markers added
        """
        if not citations:
            return response_content

        # For now, append citation markers at the end
        # In a more sophisticated implementation, you could analyze the content
        # and insert citations where relevant information is mentioned

        citation_markers = []
        for i, _citation in enumerate(citations, 1):
            citation_markers.append(f"[{i}]")

        if citation_markers:
            # Add citation markers to the end of the response
            response_content += f"\n\nSources: {' '.join(citation_markers)}"

        return response_content

    @staticmethod
    def create_citation_from_packet(packet_obj: dict[str, Any], retrieved_docs: list[Document]) -> dict[str, Any] | None:
        """
        Create a citation from a streaming citation_info packet.
        This method matches the working logic from chat.py for streaming citations.

        Args:
            packet_obj: The citation_info packet object from streaming
            retrieved_docs: List of retrieved documents for additional metadata

        Returns:
            Citation dictionary or None if creation fails
        """
        try:
            citation_num = packet_obj.get("citation_num")
            if not citation_num:
                logger.warning("Citation packet missing citation_num")
                return None

            # noinspection PyTypeChecker
            doc_index = int(citation_num) - 1 if citation_num else 0

            # Extract basic fields from packet
            source = packet_obj.get("document_title", "Unknown")
            citation_url = packet_obj.get("url")

            # Initialize fields that may come from document
            text = ""
            chunk_index = 0
            file_path = ""

            # Extract additional fields from the document if available
            if retrieved_docs and 0 <= doc_index < len(retrieved_docs):
                doc = retrieved_docs[doc_index]
                text = truncate_at_word_boundary(doc.page_content, 800)
                chunk_index = doc.metadata.get(
                    "chunk_index",
                    doc.metadata.get("chunk_id", 0),
                )
                file_path = doc.metadata.get(
                    "file_path",
                    doc.metadata.get("document_path", ""),
                )

            logger.debug(
                "Citation [%s] URL from packet: '%s' (type: %s)",
                citation_num,
                citation_url,
                type(citation_url).__name__,
            )

            citation_info = {
                "id": citation_num,
                "citation_num": citation_num,
                "document_id": packet_obj.get("document_id"),
                "document_title": packet_obj.get("document_title"),
                "source": source,
                "file_path": file_path,
                "url": citation_url,
                "page": packet_obj.get("page"),
                "chunk_index": chunk_index,
                "text": text,
                "score": packet_obj.get("score"),
            }

            logger.debug(
                "Created citation %s from packet with URL: '%s'",
                citation_info["id"],
                citation_url,
            )

            return citation_info

        except Exception as e:
            logger.error("Error creating citation from packet: %s", str(e))
            return None

    @staticmethod
    def create_message_metadata(
        citations: list[dict[str, Any]],
        rag_strategy: str = "adaptive",
        model_used: str = "unknown",
    ) -> dict[str, Any]:
        """
        Create message metadata with citations for storage in a database.

        Args:
            citations: List of citation dictionaries
            rag_strategy: Name of RAG strategy used
            model_used: Name of a model used for generation

        Returns:
            Message metadata dictionary
        """
        metadata = {
            "timestamp": datetime.now(UTC).isoformat(),
            "model_used": model_used,
            "rag_strategy": rag_strategy,
            "retrieval_results": len(citations),
            "citations": citations,
        }

        return metadata
