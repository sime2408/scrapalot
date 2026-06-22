"""
Boundary Detector for Two-Phase Chunking
Detects semantic boundaries in text that should be preserved during chunking.
"""

from dataclasses import dataclass
from enum import Enum
import re
from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class BoundaryType(Enum):
    """Types of boundaries that can be detected."""

    TABLE = "table"
    CODE_BLOCK = "code_block"
    LIST = "list"
    HEADER = "header"
    PARAGRAPH = "paragraph"
    QUOTE = "quote"
    MATH = "math"


@dataclass
class BoundaryPoint:
    """Represents a detected boundary in the text."""

    boundary_type: BoundaryType
    start_position: int
    end_position: int
    content: str
    metadata: dict[str, Any] = None

    def __post_init__(self):
        if self.metadata is None:
            self.metadata = {}


class BoundaryDetector:
    """Detect semantic boundaries in text for preservation during chunking."""

    def __init__(self):
        self.logger = get_logger(self.__class__.__name__)

        # Compile regex patterns for performance
        self._compile_patterns()

    def _compile_patterns(self):
        """Compile regex patterns for boundary detection."""

        # Table patterns
        self.table_row_pattern = re.compile(r"^\s*\|.*\|\s*$", re.MULTILINE)
        self.table_separator_pattern = re.compile(r"^\s*\|[\s\-:]*\|\s*$", re.MULTILINE)

        # Code block patterns
        self.fenced_code_pattern = re.compile(r"```[\s\S]*?```", re.MULTILINE)
        self.indented_code_pattern = re.compile(r"(?:^    .*$\n?)+", re.MULTILINE)

        # List patterns
        self.bullet_list_pattern = re.compile(r"^\s*[-*+]\s+.*$", re.MULTILINE)
        self.numbered_list_pattern = re.compile(r"^\s*\d+\.\s+.*$", re.MULTILINE)

        # Header patterns
        self.atx_header_pattern = re.compile(r"^#{1,6}\s+.*$", re.MULTILINE)
        self.setext_header_pattern = re.compile(r"^.*\n[=-]+\s*$", re.MULTILINE)

        # Quote patterns
        self.blockquote_pattern = re.compile(r"^\s*>.*$", re.MULTILINE)

        # Math patterns
        self.math_block_pattern = re.compile(r"\$\$[\s\S]*?\$\$", re.MULTILINE)
        self.math_inline_pattern = re.compile(r"\$[^$]*?\$")

    def detect_boundaries(self, content: str) -> list[BoundaryPoint]:
        """Identify all boundaries that should be preserved."""

        self.logger.debug("Detecting boundaries in content (%d chars)", len(content))

        boundaries = []

        # Detect different boundary types
        boundaries.extend(self._detect_table_boundaries(content))
        boundaries.extend(self._detect_code_boundaries(content))
        boundaries.extend(self._detect_list_boundaries(content))
        boundaries.extend(self._detect_header_boundaries(content))
        boundaries.extend(self._detect_quote_boundaries(content))
        boundaries.extend(self._detect_math_boundaries(content))

        # Sort boundaries by the start position
        boundaries.sort(key=lambda x: x.start_position)

        # Merge overlapping boundaries
        merged_boundaries = self._merge_overlapping_boundaries(boundaries, content)

        self.logger.debug("Detected %d boundaries (%d after merging)", len(boundaries), len(merged_boundaries))

        return merged_boundaries

    def _detect_table_boundaries(self, content: str) -> list[BoundaryPoint]:
        """Detect Markdown tables."""

        boundaries = []

        # Find all table rows
        table_rows = []
        for match in self.table_row_pattern.finditer(content):
            table_rows.append((match.start(), match.end(), match.group()))

        if not table_rows:
            return boundaries

        # Group consecutive table rows into table boundaries
        current_table_start = None
        current_table_end = None
        current_table_content = ""

        for _i, (start, end, row_content) in enumerate(table_rows):
            # Check if this row is consecutive with the previous one
            if current_table_start is None:
                # Start new table
                current_table_start = start
                current_table_end = end
                current_table_content = row_content
            else:
                # Check if there's only whitespace between this row and the previous
                between_content = content[current_table_end:start].strip()
                if not between_content or between_content == "\n":
                    # Extend current table
                    current_table_end = end
                    current_table_content += "\n" + row_content
                else:
                    # Save previous table and start new one
                    if self._is_valid_table(current_table_content):
                        boundaries.append(
                            BoundaryPoint(
                                boundary_type=BoundaryType.TABLE,
                                start_position=current_table_start or 0,
                                end_position=current_table_end or 0,
                                content=current_table_content,
                                metadata={"row_count": current_table_content.count("\n") + 1},
                            )
                        )

                    current_table_start = start
                    current_table_end = end
                    current_table_content = row_content

        # Save the last table
        if current_table_start is not None and self._is_valid_table(current_table_content):
            # noinspection PyTypeChecker
            boundaries.append(
                BoundaryPoint(
                    boundary_type=BoundaryType.TABLE,
                    start_position=current_table_start,
                    end_position=int(current_table_end) if current_table_end is not None else 0,
                    content=current_table_content,
                    metadata={"row_count": current_table_content.count("\n") + 1},
                )
            )

        self.logger.debug("Detected %d table boundaries", len(boundaries))
        return boundaries

    def _is_valid_table(self, table_content: str) -> bool:
        """Check if content represents a valid table."""
        lines = table_content.strip().split("\n")

        # Must have at least 2 lines
        if len(lines) < 2:
            return False

        # Check if any line looks like a separator
        has_separator = any(self.table_separator_pattern.match(line) for line in lines)

        # Valid if it has a separator OR at least 3 rows with similar structure
        return has_separator or len(lines) >= 3

    def _detect_code_boundaries(self, content: str) -> list[BoundaryPoint]:
        """Detect code blocks and inline code."""

        boundaries = []

        # Fenced code blocks (```)
        for match in self.fenced_code_pattern.finditer(content):
            # Extract language if present
            first_line = match.group().split("\n")[0]
            language = first_line[3:].strip() if len(first_line) > 3 else "unknown"

            boundaries.append(
                BoundaryPoint(
                    boundary_type=BoundaryType.CODE_BLOCK,
                    start_position=match.start(),
                    end_position=match.end(),
                    content=match.group(),
                    metadata={"code_type": "fenced", "language": language, "line_count": match.group().count("\n")},
                )
            )

        # Indented code blocks (4+ spaces)
        for match in self.indented_code_pattern.finditer(content):
            boundaries.append(
                BoundaryPoint(
                    boundary_type=BoundaryType.CODE_BLOCK,
                    start_position=match.start(),
                    end_position=match.end(),
                    content=match.group(),
                    metadata={"code_type": "indented", "line_count": match.group().count("\n")},
                )
            )

        self.logger.debug("Detected %d code boundaries", len(boundaries))
        return boundaries

    def _detect_list_boundaries(self, content: str) -> list[BoundaryPoint]:
        """Detect numbered and bulleted lists."""

        boundaries = []

        # Group consecutive list items
        all_list_items = []

        # Bullet list items
        for match in self.bullet_list_pattern.finditer(content):
            all_list_items.append((match.start(), match.end(), match.group(), "bullet"))

        # Numbered list items
        for match in self.numbered_list_pattern.finditer(content):
            all_list_items.append((match.start(), match.end(), match.group(), "numbered"))

        # Sort by position
        all_list_items.sort(key=lambda x: x[0])

        # Group consecutive items into list boundaries
        current_list_start = None
        current_list_end = None
        current_list_content = ""
        current_list_type = None
        item_count = 0

        for start, end, item_content, list_type in all_list_items:
            if current_list_start is None:
                # Start new list
                current_list_start = start
                current_list_end = end
                current_list_content = item_content
                current_list_type = list_type
                item_count = 1
            else:
                # Check if this item is consecutive and same type
                between_content = content[current_list_end:start].strip()
                is_consecutive = not between_content or between_content == "\n"
                same_type = list_type == current_list_type

                if is_consecutive and same_type:
                    # Extend current list
                    current_list_end = end
                    current_list_content += "\n" + item_content
                    item_count += 1
                else:
                    # Save previous list and start new one
                    if item_count >= 2:  # Only save lists with multiple items
                        boundaries.append(
                            BoundaryPoint(
                                boundary_type=BoundaryType.LIST,
                                start_position=current_list_start or 0,
                                end_position=current_list_end or 0,
                                content=current_list_content,
                                metadata={"list_type": current_list_type, "item_count": item_count},
                            )
                        )

                    current_list_start = start
                    current_list_end = end
                    current_list_content = item_content
                    current_list_type = list_type
                    item_count = 1

        # Save the last list
        if current_list_start is not None and item_count >= 2:
            # noinspection PyTypeChecker
            boundaries.append(
                BoundaryPoint(
                    boundary_type=BoundaryType.LIST,
                    start_position=current_list_start,
                    end_position=int(current_list_end) if current_list_end is not None else 0,
                    content=current_list_content,
                    metadata={"list_type": current_list_type, "item_count": item_count},
                )
            )

        self.logger.debug("Detected %d list boundaries", len(boundaries))
        return boundaries

    def _detect_header_boundaries(self, content: str) -> list[BoundaryPoint]:
        """Detect section headers."""

        boundaries = []

        # ATX headers (# ## ###)
        for match in self.atx_header_pattern.finditer(content):
            header_level = len(match.group()) - len(match.group().lstrip("#"))
            header_text = match.group().lstrip("#").strip()

            boundaries.append(
                BoundaryPoint(
                    boundary_type=BoundaryType.HEADER,
                    start_position=match.start(),
                    end_position=match.end(),
                    content=match.group(),
                    metadata={"header_type": "atx", "level": header_level, "text": header_text},
                )
            )

        # Setext headers (underlined)
        for match in self.setext_header_pattern.finditer(content):
            lines = match.group().split("\n")
            header_text = lines[0].strip()
            underline = lines[1].strip()
            level = 1 if underline.startswith("=") else 2

            boundaries.append(
                BoundaryPoint(
                    boundary_type=BoundaryType.HEADER,
                    start_position=match.start(),
                    end_position=match.end(),
                    content=match.group(),
                    metadata={"header_type": "setext", "level": level, "text": header_text},
                )
            )

        self.logger.debug("Detected %d header boundaries", len(boundaries))
        return boundaries

    def _detect_quote_boundaries(self, content: str) -> list[BoundaryPoint]:
        """Detect block quotes."""

        boundaries = []

        # Group consecutive quote lines
        quote_lines = []
        for match in self.blockquote_pattern.finditer(content):
            quote_lines.append((match.start(), match.end(), match.group()))

        if not quote_lines:
            return boundaries

        # Group consecutive quotes
        current_quote_start = None
        current_quote_end = None
        current_quote_content = ""

        for start, end, quote_content in quote_lines:
            if current_quote_start is None:
                current_quote_start = start
                current_quote_end = end
                current_quote_content = quote_content
            else:
                # Check if consecutive
                between_content = content[current_quote_end:start].strip()
                if not between_content or between_content == "\n":
                    current_quote_end = end
                    current_quote_content += "\n" + quote_content
                else:
                    # Save previous quote and start new one
                    boundaries.append(
                        BoundaryPoint(
                            boundary_type=BoundaryType.QUOTE,
                            start_position=current_quote_start or 0,
                            end_position=current_quote_end or 0,
                            content=current_quote_content,
                            metadata={"line_count": current_quote_content.count("\n") + 1},
                        )
                    )

                    current_quote_start = start
                    current_quote_end = end
                    current_quote_content = quote_content

        # Save the last quote
        if current_quote_start is not None:
            # noinspection PyTypeChecker
            boundaries.append(
                BoundaryPoint(
                    boundary_type=BoundaryType.QUOTE,
                    start_position=current_quote_start,
                    end_position=int(current_quote_end) if current_quote_end is not None else 0,
                    content=current_quote_content,
                    metadata={"line_count": current_quote_content.count("\n") + 1},
                )
            )

        self.logger.debug("Detected %d quote boundaries", len(boundaries))
        return boundaries

    def _detect_math_boundaries(self, content: str) -> list[BoundaryPoint]:
        """Detect mathematical expressions."""

        boundaries = []

        # Math blocks ($$...$$)
        for match in self.math_block_pattern.finditer(content):
            boundaries.append(
                BoundaryPoint(
                    boundary_type=BoundaryType.MATH,
                    start_position=match.start(),
                    end_position=match.end(),
                    content=match.group(),
                    metadata={"math_type": "block", "line_count": match.group().count("\n")},
                )
            )

        # Inline math ($...$) - only if not inside block math
        block_ranges = [(b.start_position, b.end_position) for b in boundaries]

        for match in self.math_inline_pattern.finditer(content):
            # Check if this inline math is not inside a block math
            is_inside_block = any(start <= match.start() <= end for start, end in block_ranges)

            if not is_inside_block:
                boundaries.append(
                    BoundaryPoint(
                        boundary_type=BoundaryType.MATH,
                        start_position=match.start(),
                        end_position=match.end(),
                        content=match.group(),
                        metadata={"math_type": "inline"},
                    )
                )

        self.logger.debug("Detected %d math boundaries", len(boundaries))
        return boundaries

    @staticmethod
    def _merge_overlapping_boundaries(boundaries: list[BoundaryPoint], content: str) -> list[BoundaryPoint]:
        """Merge overlapping or adjacent boundaries."""

        if not boundaries:
            return boundaries

        merged = []
        current = boundaries[0]

        for next_boundary in boundaries[1:]:
            # Check if boundaries overlap or are adjacent
            if current.end_position >= next_boundary.start_position - 1:
                # Merge boundaries
                merged_content = content[current.start_position : max(current.end_position, next_boundary.end_position)]

                current = BoundaryPoint(
                    boundary_type=current.boundary_type,  # Keep first type
                    start_position=current.start_position,
                    end_position=max(current.end_position, next_boundary.end_position),
                    content=merged_content,
                    metadata={"merged": True, "original_types": [current.boundary_type, next_boundary.boundary_type]},
                )
            else:
                # No overlap, save current and move to next
                merged.append(current)
                current = next_boundary

        # Add the last boundary
        merged.append(current)

        return merged

    @staticmethod
    def get_boundary_safe_split_points(content: str, boundaries: list[BoundaryPoint], min_chunk_size: int = 200) -> list[int]:
        """Get positions where text can be safely split without breaking boundaries."""

        safe_points = []

        # Sort boundaries by position
        sorted_boundaries = sorted(boundaries, key=lambda x: x.start_position)

        last_end = 0

        for boundary in sorted_boundaries:
            # Add safe split points before this boundary
            before_boundary = content[last_end : boundary.start_position]

            # Find safe split points (paragraph breaks, double newlines)
            paragraph_breaks = []
            for match in re.finditer(r"\n\s*\n", before_boundary):
                pos = last_end + match.end()
                if pos - last_end >= min_chunk_size:
                    paragraph_breaks.append(pos)

            safe_points.extend(paragraph_breaks)

            last_end = boundary.end_position

        # Add safe points after the last boundary
        after_last = content[last_end:]
        for match in re.finditer(r"\n\s*\n", after_last):
            pos = last_end + match.end()
            safe_points.append(pos)

        return sorted(safe_points)

    def validate_chunk_boundaries(self, chunk_content: str) -> dict[str, Any]:
        """Validate that a chunk doesn't violate any boundaries."""

        violations = []
        preserved = []

        # Check for incomplete tables
        if "|" in chunk_content:
            lines_with_pipes = [line for line in chunk_content.split("\n") if "|" in line]
            has_header_separator = any(self.table_separator_pattern.match(line) for line in lines_with_pipes)

            if len(lines_with_pipes) > 1 and not has_header_separator:
                violations.append({"type": "incomplete_table", "description": "Table rows without header separator"})
            elif has_header_separator:
                preserved.append("table")

        # Check for incomplete code blocks
        fenced_blocks = chunk_content.count("```")
        if fenced_blocks % 2 != 0:
            violations.append({"type": "incomplete_code_block", "description": "Unmatched code block fences"})
        elif fenced_blocks > 0:
            preserved.append("code_block")

        # Check for orphaned list items
        if re.search(r"^\s*[-*+]\s", chunk_content, re.MULTILINE):
            preserved.append("list")

        # Check for headers
        if re.search(r"^#{1,6}\s", chunk_content, re.MULTILINE):
            preserved.append("header")

        return {"violations": violations, "preserved_boundaries": preserved, "is_valid": len(violations) == 0}
