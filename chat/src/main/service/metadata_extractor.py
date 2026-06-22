"""
Metadata Extractor - Enhanced document metadata extraction using LLM.

This module provides intelligent metadata extraction capabilities that go beyond
basic file properties to extract semantic information from document content.
"""

from datetime import UTC, datetime
import json
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from src.main.service.llm.llm_factory import get_llm
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# LangChain imports for structured outputs
try:
    # noinspection PyUnresolvedReferences
    from langchain_core.output_parsers import PydanticOutputParser

    # noinspection PyUnresolvedReferences
    from langchain_core.prompts import PromptTemplate

    LANGCHAIN_AVAILABLE = True
except ImportError:
    logger.warning("LangChain not available for structured outputs")
    LANGCHAIN_AVAILABLE = False

# Import with fallbacks
try:
    from src.main.utils.config.loader import resolved_config
except ImportError:
    logger.warning("Could not import config_loader")
    resolved_config = {}

# PDF processing imports with fallbacks
try:
    # noinspection PyUnresolvedReferences
    import fitz  # PyMuPDF

    PYMUPDF_AVAILABLE = True
except ImportError:
    logger.warning("PyMuPDF not available for metadata extraction")
    PYMUPDF_AVAILABLE = False

try:
    # noinspection PyUnresolvedReferences
    from docling.backend.pypdfium2_backend import PyPdfiumDocumentBackend

    # noinspection PyUnresolvedReferences
    from docling.datamodel.base_models import InputFormat

    # noinspection PyUnresolvedReferences
    from docling.datamodel.pipeline_options import PdfPipelineOptions

    # noinspection PyUnresolvedReferences
    from docling.document_converter import DocumentConverter, PdfFormatOption

    # noinspection PyUnresolvedReferences
    from docling.pipeline.standard_pdf_pipeline import StandardPdfPipeline

    DOCLING_AVAILABLE = True
except ImportError:
    logger.warning("Docling not available for metadata extraction")
    DOCLING_AVAILABLE = False


class DocumentMetadata(BaseModel):
    """Pydantic model for document metadata validation and structured output"""

    title: str | None = Field(None, description="The main title of the document")
    author: str | None = Field(None, description="The author(s) of the document")
    subject: str | None = Field(None, description="The main subject or topic of the document")
    description: str | None = Field(None, description="A brief description or synopsis of the content")
    keywords: list[str] | None = Field(None, description="Important terms and concepts found in the content")
    category: str | None = Field(None, description="Document category (e.g., academic, technical, fiction, business)")
    language: str | None = Field(None, description="The language of the document")
    publisher: str | None = Field(None, description="The publisher or publishing organization")
    publication_date: str | None = Field(None, description="When the document was published")
    isbn: str | None = Field(None, description="ISBN number if present")
    page_count: int | None = Field(None, description="The total number of pages")


class MetadataExtractor:
    """Service for extracting and enriching document metadata"""

    def __init__(self, config: dict[str, Any] | None = None):
        """
        Initialize the metadata extractor.

        Args:
            config: Optional configuration dictionary (defaults to resolved_config)
        """
        self.config = config if config is not None else resolved_config

    def extract_pdf_metadata(self, file_path: str) -> dict[str, Any]:
        """
        Extract metadata from a PDF file using fallback methods.

        Args:
                file_path: Path to the PDF file

        Returns:
                Dictionary containing extracted metadata
        """
        metadata = {
            "source": "metadata_extractor",
            "extraction_method": [],
            "extracted_at": datetime.now(UTC).isoformat(),
            "file_path": file_path,
        }

        # Try PyMuPDF first (faster and more reliable)
        if PYMUPDF_AVAILABLE:
            pymupdf_metadata = self._extract_with_pymupdf(file_path)
            if pymupdf_metadata:
                metadata.update(pymupdf_metadata)
                # noinspection PyUnresolvedReferences
                metadata["extraction_method"].append("pymupdf")

        # Try Docling as fallback
        if DOCLING_AVAILABLE and not metadata.get("title"):
            docling_metadata = self._extract_with_docling(file_path)
            if docling_metadata:
                # Merge with existing metadata, preferring non-empty values
                for key, value in docling_metadata.items():
                    if value and (key not in metadata or not metadata[key]):
                        metadata[key] = value
                # noinspection PyUnresolvedReferences
                metadata["extraction_method"].append("docling")

        # Add basic file information
        try:
            import os

            stat = os.stat(file_path)
            file_info: dict[str, Any] = {
                "file_size": stat.st_size,
                "file_modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                "file_name": os.path.basename(file_path),
            }
            # noinspection PyTypeChecker
            metadata.update(file_info)
        except Exception as e:
            logger.warning("Could not get file stats: %s", str(e))

        return metadata

    def _extract_with_pymupdf(self, file_path: str) -> dict[str, Any] | None:
        """Extract metadata using PyMuPDF"""
        try:
            doc = fitz.open(file_path)
            metadata = doc.metadata

            # Clean and structure the metadata
            structured_metadata = {}

            # Map PyMuPDF fields to our standard fields
            # Only include useful metadata fields
            field_mapping = {
                "title": "title",
                "author": "author",
                "subject": "subject",
                "keywords": "keywords",
                "creationDate": "creation_date",
                "modDate": "modification_date",
            }

            for pdf_field, our_field in field_mapping.items():
                value = metadata.get(pdf_field)
                if value and value.strip():
                    structured_metadata[our_field] = value.strip()

            # Add page count
            structured_metadata["page_count"] = doc.page_count

            # Extract text from the first few pages for content analysis (3-5 pages for LLM)
            if doc.page_count > 0:
                first_page_text = ""
                for page_num in range(min(5, doc.page_count)):
                    page = doc[page_num]
                    first_page_text += page.get_text()

                # Store extracted content for LLM enrichment
                structured_metadata["extracted_content"] = first_page_text

                # Try to extract additional metadata from content using heuristics
                content_metadata = self._extract_from_content(first_page_text)
                structured_metadata.update(content_metadata)

            doc.close()
            return structured_metadata

        except Exception as e:
            logger.error("Error extracting metadata with PyMuPDF: %s", str(e))
            return None

    def _extract_with_docling(self, file_path: str) -> dict[str, Any] | None:
        """Extract metadata using Docling"""
        try:
            # Configure Docling for metadata extraction
            pipeline_options = PdfPipelineOptions()
            converter = DocumentConverter(
                format_options={
                    InputFormat.PDF: PdfFormatOption(
                        pipeline_cls=StandardPdfPipeline,
                        backend=PyPdfiumDocumentBackend,
                        pipeline_options=pipeline_options,
                    )
                }
            )

            # Convert document
            result = converter.convert(file_path)

            if not result or not result.document:
                return None

            # Extract metadata from Docling result
            metadata = {}

            # Get document metadata if available
            if hasattr(result.document, "meta") and result.document.meta:
                doc_meta = result.document.meta
                if hasattr(doc_meta, "title") and doc_meta.title:
                    metadata["title"] = doc_meta.title
                if hasattr(doc_meta, "authors") and doc_meta.authors:
                    metadata["author"] = ", ".join(doc_meta.authors)

            # Extract text for content analysis
            if hasattr(result.document, "export_to_markdown"):
                content = result.document.export_to_markdown()
                # Limit content for analysis (first 2000 characters)
                content_sample = content[:2000] if content else ""
                content_metadata = self._extract_from_content(content_sample)
                metadata.update(content_metadata)

            return metadata if metadata else None

        except Exception as e:
            logger.error("Error extracting metadata with Docling: %s", str(e))
            return None

    @staticmethod
    def _extract_from_content(content: str) -> dict[str, Any]:
        """Extract metadata from document content using heuristics"""
        metadata = {}

        if not content or len(content.strip()) < 50:
            return metadata

        lines = content.split("\n")
        cleaned_lines = [line.strip() for line in lines if line.strip()]

        # Try to find title (usually in the first few lines, often in caps or larger text)
        if not metadata.get("title") and cleaned_lines:
            # Look for potential title in the first 10 lines
            best_title_candidate = None
            best_title_score = 0

            for idx, line in enumerate(cleaned_lines[:10]):
                if 10 < len(line) < 200:
                    # Calculate a score for how likely this is a title
                    score = 0

                    # Strip quotes and whitespace for analysis
                    clean_line = line.strip("\"'").strip()
                    lower_line = clean_line.lower()

                    # Skip lines that look like headers/footers
                    if any(word in lower_line for word in ["page", "chapter", "section", "©", "copyright", "isbn"]):
                        continue

                    # Skip lines that look like sentences (end with period, comma, exclamation)
                    if clean_line.endswith((".", ",", "!", "?", ";", ":")):
                        continue

                    # Skip lines that start with quotes (likely blurbs/testimonials)
                    if line.startswith(('"', "'", '"', '"', """, """)):
                        continue

                    # Skip lines that start with common sentence starters (case-insensitive)
                    # NOTE: "the ", "a ", "an " deliberately excluded — too common in book titles
                    if any(
                        lower_line.startswith(prefix)
                        for prefix in [
                            "dr.",
                            "dr ",
                            "mr.",
                            "mr ",
                            "mrs.",
                            "mrs ",
                            "ms.",
                            "ms ",
                            "in ",
                            "this ",
                            "that ",
                        ]
                    ):
                        continue

                    # Skip lines that contain praise/review indicators (likely blurbs)
                    if any(
                        word in lower_line
                        for word in [
                            "provided",
                            "reader",
                            "brilliant",
                            "excellent",
                            "masterpiece",
                            "must-read",
                            "fascinating",
                        ]
                    ):
                        continue

                    # Skip lines that look like subtitles or descriptions (start with "with", "an extraordinary", etc.)
                    if any(
                        lower_line.startswith(prefix)
                        for prefix in [
                            "with ",
                            "with an",
                            "providing ",
                            "including ",
                            "featuring ",
                            "an extraordinary",
                            "a comprehensive",
                            "a fascinating",
                        ]
                    ):
                        continue

                    # Prefer earlier lines (first 3 lines are most likely titles)
                    if idx < 3:
                        score += 10
                    elif idx < 5:
                        score += 5

                    # Prefer shorter lines (titles are usually concise)
                    word_count = len(clean_line.split())
                    if 2 <= word_count <= 10:
                        score += 8
                    elif word_count <= 15:
                        score += 4

                    # Prefer title case (first letter of words capitalized)
                    words = clean_line.split()
                    capitalized_count = sum(1 for word in words if word and word[0].isupper())
                    if capitalized_count >= len(words) * 0.6:  # At least 60% of words capitalized
                        score += 6

                    # Avoid all caps (likely header/footer or shouting)
                    if clean_line.isupper():
                        score -= 5

                    # Update best candidate if this scores higher (use cleaned line)
                    if score > best_title_score:
                        best_title_score = score
                        best_title_candidate = clean_line  # Use cleaned version without quotes

            # Use best candidate if score is high enough (threshold: 10)
            # Also validate that the title is meaningful using centralized validation
            if best_title_candidate and best_title_score >= 10:
                # Import validation function
                from src.main.utils.documents.utils import is_title_meaningless

                # Only use the title if it's meaningful
                if not is_title_meaningless(best_title_candidate):
                    metadata["title"] = best_title_candidate
                else:
                    # BUG FIX: Downgrade to DEBUG - fallback system handles this gracefully
                    logger.debug("Heuristic title extraction found title but it's meaningless: %s", best_title_candidate)

        # Try to find author information
        if not metadata.get("author"):
            for line in cleaned_lines[:10]:
                line_lower = line.lower()
                if any(keyword in line_lower for keyword in ["by ", "author", "written by"]):
                    # Extract author name
                    author = line.replace("by ", "").replace("By ", "").replace("author:", "").replace("Author:", "")
                    author = author.replace("written by", "").replace("Written by", "").strip()
                    if 2 < len(author) < 100:
                        metadata["author"] = author
                        break

        # Extract keywords from content
        content_lower = content.lower()
        common_keywords = []

        # Look for repeated important terms (simple keyword extraction)
        words = content_lower.split()
        word_freq = {}
        for word in words:
            if len(word) > 4 and word.isalpha():  # Only consider longer alphabetic words
                word_freq[word] = word_freq.get(word, 0) + 1

        # Get most frequent words as keywords
        if word_freq:
            sorted_words = sorted(word_freq.items(), key=lambda x: x[1], reverse=True)
            common_keywords = [word for word, freq in sorted_words[:10] if freq > 2]

        if common_keywords:
            metadata["keywords"] = common_keywords

        return metadata

    async def enrich_with_llm(self, metadata: dict[str, Any], content_sample: str = None, db=None, user_id: str = None) -> dict[str, Any]:
        """
        Enrich metadata using LLM analysis with structured JSON outputs.

        Args:
                metadata: Existing metadata dictionary
                content_sample: Sample of document content for analysis
                db: Database session for model lookup
                user_id: User ID for model access

        Returns:
                Enhanced metadata dictionary
        """
        if not self.config.get("enable_llm_enrichment", False):
            logger.debug("LLM enrichment disabled in config")
            return metadata

        metadata_config = self.config.get("metadata_extraction", {})
        if not metadata_config.get("enable_llm_enrichment", True):
            logger.debug("LLM enrichment disabled for metadata extraction")
            return metadata

        # Skip LLM enrichment if database session or user_id not provided
        if db is None or user_id is None:
            logger.debug("Skipping LLM enrichment: database session or user_id not provided")
            return metadata

        try:
            # Get LLM instance using preferred models from config
            preferred_models = metadata_config.get("preferred_models", ["gpt-4o-mini", "llama3.1:8b"])

            llm = None
            for model_name in preferred_models:
                try:
                    llm = await get_llm(model_name, db=db, user_id=user_id)
                    if llm:
                        logger.info("Using model %s for metadata extraction", model_name)
                        break
                except Exception as e:
                    logger.warning("Could not load model %s: %s", model_name, str(e))
                    continue

            if not llm:
                # Try to get any available LLM as fallback
                try:
                    llm = await get_llm("gpt-4o-mini", db=db, user_id=user_id)  # Default fallback
                except Exception as e:
                    logger.debug("Non-critical operation failed: %s", e)

            if not llm:
                logger.warning("No LLM available for metadata enhancement")
                return metadata

            # Prepare content for analysis
            analysis_content = content_sample or ""
            max_text_length = metadata_config.get("max_text_length", 4000)
            if len(analysis_content) > max_text_length:
                analysis_content = analysis_content[:max_text_length] + "..."

            # Use LangChain structured outputs if available
            if LANGCHAIN_AVAILABLE:
                enhanced_metadata = await self._extract_with_structured_output(llm, metadata, analysis_content)
            else:
                # Fallback to manual parsing
                enhanced_metadata = await self._extract_with_manual_parsing(llm, metadata, analysis_content)

            # Merge with existing metadata
            final_metadata = metadata.copy()
            for key, value in enhanced_metadata.items():
                if value and (key not in final_metadata or not final_metadata[key]):
                    final_metadata[key] = value

            final_metadata["llm_enhanced"] = True
            final_metadata["enhancement_timestamp"] = datetime.now(UTC).isoformat()

            return final_metadata

        except Exception as e:
            logger.error("Error enhancing metadata with LLM: %s", str(e))
            return metadata

    @staticmethod
    async def _extract_with_structured_output(llm, metadata: dict[str, Any], content: str) -> dict[str, Any]:
        """Extract metadata using LangChain structured outputs"""
        try:
            # Create output parser
            parser = PydanticOutputParser(pydantic_object=DocumentMetadata)

            # Get prompt template from prompts.yaml
            from src.main.utils.config.loader import resolved_prompts

            template = resolved_prompts.get("metadata_extraction", {}).get("template_metadata_extraction", "")

            if not template:
                logger.warning("No metadata extraction template found in config")
                return {}

            # Create prompt template
            prompt_template = PromptTemplate(
                template=template + "\n\n{format_instructions}",
                input_variables=["existing_metadata", "content"],
                partial_variables={"format_instructions": parser.get_format_instructions()},
            )

            # Format the prompt
            formatted_prompt = prompt_template.format(existing_metadata=json.dumps(metadata, indent=2), content=content)

            # Get LLM response
            response = await llm.ainvoke(formatted_prompt)
            response_text = response.content if hasattr(response, "content") else str(response)

            # Parse with structured output parser
            parsed_metadata = parser.parse(response_text)

            return parsed_metadata.model_dump(exclude_none=True)

        except Exception as e:
            logger.error("Error with structured output extraction: %s", str(e))
            return {}

    async def _extract_with_manual_parsing(self, llm, metadata: dict[str, Any], content: str) -> dict[str, Any]:
        """Fallback method for manual parsing when LangChain is not available"""
        try:
            # Get prompt template from prompts.yaml
            from src.main.utils.config.loader import resolved_prompts

            template = resolved_prompts.get("metadata_extraction", {}).get("template_metadata_extraction", "")

            if not template:
                logger.warning("No metadata extraction template found in config")
                return {}

            # Create manual JSON format instructions
            format_instructions = """
Return your response as a valid JSON object with the following structure:
{
    "title": "extracted or improved title",
    "author": "extracted or improved author",
    "subject": "main subject / topic",
    "description": "brief description of the document",
    "keywords": ["keyword1", "keyword2", "keyword3"],
    "category": "document category (e.g., academic, technical, fiction, business)",
    "language": "detected language",
    "publisher": "publisher if mentioned",
    "publication_date": "publication date if mentioned",
    "isbn": "ISBN if present",
    "page_count": number_of_pages_if_mentioned
}

Only include fields where you can provide meaningful improvements or new information.
Be concise and accurate. Return only the JSON object.
"""

            # Format the prompt
            formatted_prompt = template.format(existing_metadata=json.dumps(metadata, indent=2), content=content) + "\n\n" + format_instructions

            # Get LLM response
            response = await llm.ainvoke(formatted_prompt)
            response_text = response.content if hasattr(response, "content") else str(response)

            # Parse manually
            return self._parse_llm_metadata_response(response_text)

        except Exception as e:
            logger.error("Error with manual parsing extraction: %s", str(e))
            return {}

    @staticmethod
    def _parse_llm_metadata_response(response: str) -> dict[str, Any]:
        """Parse LLM response and extract metadata"""
        try:
            # Try to find JSON in the response
            import re

            json_match = re.search(r"\{.*\}", response, re.DOTALL)
            if json_match:
                json_str = json_match.group()
                parsed = json.loads(json_str)

                # Validate using Pydantic model
                document_metadata = DocumentMetadata(**parsed)
                return document_metadata.model_dump(exclude_none=True)

        except (json.JSONDecodeError, ValidationError) as e:
            logger.warning("Could not parse LLM metadata response: %s", str(e))

        return {}

    async def extract_and_enrich_metadata(self, file_path: str, content_sample: str = None, db=None, user_id: str = None) -> dict[str, Any]:
        """
        Extract metadata using traditional methods and optionally enrich with LLM.

        Args:
                file_path: Path to the PDF file
                content_sample: Optional content sample for LLM analysis (overrides extracted content)
                db: Database session for LLM model lookup
                user_id: User ID for LLM model access

        Returns:
                Enhanced metadata dictionary
        """
        # Extract basic metadata
        metadata = self.extract_pdf_metadata(file_path)

        # Use extracted content from PDF if no content_sample provided
        if not content_sample and "extracted_content" in metadata:
            content_sample = metadata["extracted_content"]

        # Remove extracted_content from final metadata (internal use only)
        final_metadata = {k: v for k, v in metadata.items() if k != "extracted_content"}

        # Enrich with LLM if enabled and available
        try:
            # BUG FIX: Use await instead of asyncio.run() to avoid event loop conflict
            enhanced_metadata = await self.enrich_with_llm(final_metadata, content_sample, db, user_id)
            return enhanced_metadata
        except Exception as e:
            logger.warning("Could not enhance metadata with LLM: %s", str(e))
            return final_metadata


# Global instance
metadata_extractor = MetadataExtractor()
