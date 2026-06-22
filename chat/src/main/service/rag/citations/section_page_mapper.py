"""
Section-to-Page Mapping Service for Context Expansion.

This module provides functionality to map document sections to page ranges,
enabling hierarchical citations and structured navigation.
"""

from dataclasses import dataclass
import re
from typing import Any

from src.main.models.chunking import StructuralElement
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


@dataclass
class SectionPageMapping:
    """Represents a mapping between document sections and pages."""

    section_title: str
    section_level: int
    page_range: tuple[int, int]  # (start_page, end_page)
    section_path: str  # Full hierarchical path (e.g., "1.1.2 Installation > Network Setup")
    content_snippets: list[str]  # Brief content excerpts from this section


class SectionPageMapper:
    """Maps document sections to page ranges based on hierarchical structure and page content."""

    def __init__(self):
        self.logger = get_logger(__name__)

    def create_section_mappings(
        self, documents: list[dict[str, Any]], hierarchical_elements: list[StructuralElement] | None = None
    ) -> dict[str, SectionPageMapping]:
        """
        Create section-to-page mappings from processed document chunks.

        Args:
            documents: List of document chunks with page metadata
            hierarchical_elements: Optional hierarchical structure elements

        Returns:
            Dictionary mapping section IDs to SectionPageMapping objects
        """
        try:
            # Extract page-based sections
            page_sections = self._extract_page_sections(documents)

            # If hierarchical elements are provided, use them for structure
            if hierarchical_elements:
                return self._map_hierarchical_sections(hierarchical_elements, page_sections)
            else:
                # Fallback: create simple page-based mappings
                return self._create_simple_page_mappings(page_sections)

        except Exception as e:
            logger.error("Error creating section mappings: %s", str(e))
            return {}

    def _extract_page_sections(self, documents: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
        """Extract section information grouped by page number."""
        page_sections = {}

        for doc in documents:
            metadata = doc.get("metadata", {})
            page = metadata.get("page", 1)
            content = doc.get("page_content", "")

            if page not in page_sections:
                page_sections[page] = []

            # Extract headings from content
            headings = self._extract_headings(content)

            page_sections[page].append({"content": content, "headings": headings, "metadata": metadata})

        return page_sections

    @staticmethod
    def _extract_headings(content: str) -> list[dict[str, Any]]:
        """Extract heading information from content."""
        headings = []

        # Markdown heading patterns
        markdown_pattern = r"^(#{1,6})\s+(.+)$"

        # Numbered heading patterns
        numbered_pattern = r"^(\d+(?:\.\d+)*\.?)\s+(.+)$"

        lines = content.split("\n")

        for i, line in enumerate(lines):
            line = line.strip()

            # Check for Markdown headings
            match = re.match(markdown_pattern, line)
            if match:
                level = len(match.group(1))
                title = match.group(2).strip()
                headings.append({"level": level, "title": title, "line_number": i, "format": "markdown"})
                continue

            # Check for numbered headings
            match = re.match(numbered_pattern, line)
            if match:
                number = match.group(1)
                title = match.group(2).strip()
                level = len(number.split("."))
                headings.append({"level": level, "title": title, "number": number, "line_number": i, "format": "numbered"})

        return headings

    def _map_hierarchical_sections(
        self, hierarchical_elements: list[StructuralElement], page_sections: dict[int, list[dict[str, Any]]]
    ) -> dict[str, SectionPageMapping]:
        """Map hierarchical elements to page ranges."""
        mappings = {}

        for element in hierarchical_elements:
            # Find pages where this section appears
            section_pages = self._find_section_pages(element, page_sections)

            if section_pages:
                section_id = self._generate_section_id(element)
                page_range = (min(section_pages), max(section_pages))
                section_path = self._build_section_path(element)

                # Extract content snippets
                snippets = self._extract_content_snippets(element, page_sections, section_pages)

                mappings[section_id] = SectionPageMapping(
                    section_title=element.title,
                    section_level=element.level,
                    page_range=page_range,
                    section_path=section_path,
                    content_snippets=snippets,
                )

        return mappings

    def _find_section_pages(self, element: StructuralElement, page_sections: dict[int, list[dict[str, Any]]]) -> list[int]:
        """Find which pages contain content for this section."""
        matching_pages = []

        for page, sections in page_sections.items():
            for section in sections:
                # Check if any headings match this element
                for heading in section["headings"]:
                    if self._headings_match(element.title, heading["title"]):
                        matching_pages.append(page)
                        break

        return list(set(matching_pages))  # Remove duplicates

    @staticmethod
    def _headings_match(element_title: str, heading_title: str) -> bool:
        """Check if two heading titles match."""
        # Normalize titles for comparison
        elem_normalized = re.sub(r"[^\w\s]", "", element_title.lower()).strip()
        head_normalized = re.sub(r"[^\w\s]", "", heading_title.lower()).strip()

        return elem_normalized == head_normalized

    @staticmethod
    def _generate_section_id(element: StructuralElement) -> str:
        """Generate a unique ID for a section."""
        # Use title normalized as ID
        return re.sub(r"[^\w\s]", "_", element.title.lower()).replace(" ", "_")

    @staticmethod
    def _build_section_path(element: StructuralElement) -> str:
        """Build hierarchical path for section."""
        path_parts = []
        current = element

        while current:
            path_parts.append(f"{'#' * current.level} {current.title}")
            current = current.parent

        return " > ".join(reversed(path_parts))

    @staticmethod
    def _extract_content_snippets(_element: StructuralElement, page_sections: dict[int, list[dict[str, Any]]], section_pages: list[int]) -> list[str]:
        """Extract content snippets from section pages."""
        snippets = []

        for page in section_pages[:3]:  # Limit to first 3 pages
            if page in page_sections:
                for section in page_sections[page]:
                    content = section["content"]
                    # Extract first meaningful sentence/paragraph
                    lines = [line.strip() for line in content.split("\n") if line.strip()]
                    if lines:
                        # Find first non-heading line with substantial content
                        for line in lines:
                            if len(line) > 50 and not line.startswith("#"):
                                snippets.append(line[:200] + "..." if len(line) > 200 else line)
                                break

        return snippets[:2]  # Limit to 2 snippets

    @staticmethod
    def _create_simple_page_mappings(page_sections: dict[int, list[dict[str, Any]]]) -> dict[str, SectionPageMapping]:
        """Create simple page-based mappings when hierarchical structure is not available."""
        mappings = {}

        for page, sections in page_sections.items():
            for _i, section in enumerate(sections):
                headings = section["headings"]

                for heading in headings:
                    section_id = f"page_{page}_{heading['title'].lower().replace(' ', '_')}"

                    mappings[section_id] = SectionPageMapping(
                        section_title=heading["title"],
                        section_level=heading["level"],
                        page_range=(page, page),  # Single page
                        section_path=f"Page {page} > {heading['title']}",
                        content_snippets=[section["content"][:200] + "..."],
                    )

        return mappings

    @staticmethod
    def get_enhanced_citation_metadata(section_mappings: dict[str, SectionPageMapping], page_number: int, _content: str) -> dict[str, Any]:
        """
        Get enhanced citation metadata including section information.

        Args:
            section_mappings: Section mappings from create_section_mappings()
            page_number: Current page number
            _content: Page content

        Returns:
            Enhanced metadata dictionary
        """
        enhanced_metadata: dict[str, Any] = {
            "page": page_number,
            "sections_on_page": [],
            "primary_section": None,
            "section_path": None,
            "section_page_range": None,
        }

        # Find sections that include this page
        matching_sections = []
        for _section_id, mapping in section_mappings.items():
            start_page, end_page = mapping.page_range
            if start_page <= page_number <= end_page:
                matching_sections.append(mapping)

        # Sort by level (higher level = more specific)
        matching_sections.sort(key=lambda x: x.section_level, reverse=True)

        if matching_sections:
            primary = matching_sections[0]
            enhanced_metadata.update(
                {
                    "sections_on_page": [s.section_title for s in matching_sections],
                    "primary_section": primary.section_title,
                    "section_path": primary.section_path,
                    "section_page_range": (
                        f"pp. {primary.page_range[0]}-{primary.page_range[1]}"
                        if primary.page_range[0] != primary.page_range[1]
                        else f"p. {primary.page_range[0]}"
                    ),
                }
            )

        return enhanced_metadata
