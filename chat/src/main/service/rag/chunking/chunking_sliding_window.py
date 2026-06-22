"""
Sliding window chunking strategy for text splitting with configurable overlap.

This implementation creates overlapping chunks by moving a fixed-size window
across the text, ensuring context continuity across chunk boundaries.
Particularly effective for preserving narrative flow and complex relationships.
"""

import re

from src.main.models.chunking import WindowSegment
from src.main.service.rag.chunking.base_chunking import BaseChunkingStrategy
from src.main.utils.core.logger import get_logger

# Lazy import to avoid heavy dependencies during startup
# from src.main.utils.nlp.utils import jaccard_similarity


def jaccard_similarity(set1: set, set2: set) -> float:
    """Calculate Jaccard similarity between two sets."""
    if not set1 and not set2:
        return 1.0
    intersection = len(set1.intersection(set2))
    union = len(set1.union(set2))
    return intersection / union if union > 0 else 0.0


logger = get_logger(__name__)


class SlidingWindowChunkingStrategy(BaseChunkingStrategy):
    """
    Chunks text using a sliding window approach with configurable overlap.

    This strategy:
    1. Defines a window size and step size (overlap)
    2. Moves the window across the text in steps
    3. Creates overlapping chunks to preserve context
    4. Handles sentence and paragraph boundaries intelligently
    5. Optimizes for both semantic continuity and retrieval accuracy
    """

    def __init__(
        self,
        chunk_size: int = 800,
        chunk_overlap: int = 200,
        window_step_size: int | None = None,
        overlap_strategy: str = "percentage",  # "percentage", "fixed", "adaptive"
        overlap_percentage: float = 0.25,
        boundary_respect: str = "sentence",  # "none", "word", "sentence", "paragraph"
        min_chunk_size: int = 100,
        max_chunk_size: int = 1500,
        preserve_formatting: bool = True,
        **kwargs,
    ):
        """
        Initialize the sliding window chunking strategy.

        Args:
            chunk_size: Target size of chunks in characters
            chunk_overlap: Amount of overlap between chunks in characters
            window_step_size: Custom step size (if None, calculated from overlap)
            overlap_strategy: How to calculate overlap ("percentage", "fixed", "adaptive")
            overlap_percentage: Percentage of chunk to overlap (for percentage strategy)
            boundary_respect: Level of boundary respect ("none", "word", "sentence", "paragraph")
            min_chunk_size: Minimum allowable chunk size
            max_chunk_size: Maximum allowable chunk size
            preserve_formatting: Whether to preserve text formatting
            **kwargs: Additional parameters
        """
        super().__init__(chunk_size, chunk_overlap, **kwargs)
        self.window_step_size = window_step_size
        self.overlap_strategy = overlap_strategy
        self.overlap_percentage = overlap_percentage
        self.boundary_respect = boundary_respect
        self.min_chunk_size = min_chunk_size
        self.max_chunk_size = max_chunk_size
        self.preserve_formatting = preserve_formatting

        # Calculate effective step size
        self._calculate_step_size()

        # Compile boundary patterns
        self.boundary_patterns = {
            "sentence": r"(?<=[.!?])\s+",
            "paragraph": r"\n\s*\n",
            "word": r"\s+",
            "none": None,
        }

    def _calculate_step_size(self):
        """Calculate the effective step size based on overlap strategy."""
        if self.window_step_size is not None:
            self.step_size = self.window_step_size
        elif self.overlap_strategy == "percentage":
            self.step_size = int(self.chunk_size * (1 - self.overlap_percentage))
        elif self.overlap_strategy == "fixed":
            self.step_size = self.chunk_size - self.chunk_overlap
        elif self.overlap_strategy == "adaptive":
            # Will be calculated dynamically based on content
            self.step_size = int(self.chunk_size * 0.75)  # Default fallback
        else:
            self.step_size = self.chunk_size - self.chunk_overlap

        # Ensure step size is positive and reasonable
        self.step_size = max(self.step_size, self.min_chunk_size // 2)
        logger.debug("Calculated step size: %d characters", self.step_size)

    def split_text(self, text: str) -> list[str]:
        """
        Split the input text using sliding window approach.

        Args:
            text: Input text to be chunked

        Returns:
            List of overlapping text chunks
        """
        if not text or not text.strip():
            logger.warning("Empty text provided to sliding window chunking")
            return []

        try:
            # Preprocess text if needed
            processed_text = self._preprocess_text(text) if not self.preserve_formatting else text

            # Generate sliding windows
            windows = self._generate_windows(processed_text)

            # Refine windows based on boundary respect
            refined_chunks = self._refine_window_boundaries(windows, processed_text)

            # Apply size constraints and quality checks
            final_chunks = self._apply_size_constraints(refined_chunks)

            # Post-process chunks
            processed_chunks = self._post_process_chunks(final_chunks, text)

            logger.info(
                "Sliding window chunking created %d chunks with %d%% overlap",
                len(processed_chunks),
                int(self.overlap_percentage * 100),
            )
            return processed_chunks

        except Exception as e:
            logger.error("Error in sliding window chunking: %s", str(e))
            return self._fallback_chunking(text)

    @staticmethod
    def _preprocess_text(text: str) -> str:
        """Preprocess text for optimal chunking."""
        # Normalize whitespace
        text = re.sub(r"\s+", " ", text)

        # Handle common formatting issues
        text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)  # Normalize paragraph breaks
        text = re.sub(r"([.!?])\s*\n\s*([A-Z])", r"\1 \2", text)  # Fix broken sentences

        return text.strip()

    def _generate_windows(self, text: str) -> list[WindowSegment]:
        """Generate initial sliding windows."""
        windows = []
        text_length = len(text)
        position = 0

        while position < text_length:
            # Calculate window end
            window_end = min(position + self.chunk_size, text_length)

            # Extract window text
            window_text = text[position:window_end]

            if len(window_text.strip()) >= self.min_chunk_size:
                # Count words for metadata
                word_count = len(window_text.split())

                window = WindowSegment(
                    text=window_text,
                    start_position=position,
                    end_position=window_end,
                    word_count=word_count,
                    char_count=len(window_text),
                )
                windows.append(window)

            # Calculate next position with adaptive step if needed
            if self.overlap_strategy == "adaptive":
                next_step = self._calculate_adaptive_step(window_text)
            else:
                next_step = self.step_size

            position += next_step

            # Break if we've reached the end
            if window_end >= text_length:
                break

        return windows

    def _calculate_adaptive_step(self, window_text: str) -> int:
        """Calculate adaptive step size based on content characteristics."""
        # Look for natural break points in the current window
        sentences = re.split(self.boundary_patterns["sentence"] or r"(?<=[.!?])\s+", window_text)

        if len(sentences) > 1:
            # Try to step to a sentence boundary
            sentence_lengths = [len(s) for s in sentences]
            mid_point = len(window_text) // 2

            # Find sentence boundary closest to the middle
            cumulative_length = 0
            for _i, length in enumerate(sentence_lengths):
                cumulative_length += length
                if cumulative_length >= mid_point:
                    # Step to the end of this sentence
                    return min(cumulative_length, self.step_size * 1.5)

        # Fallback to default step
        return self.step_size

    def _refine_window_boundaries(self, windows: list[WindowSegment], text: str) -> list[str]:
        """Refine window boundaries to respect semantic boundaries."""
        if self.boundary_respect == "none":
            return [w.text for w in windows]

        refined_chunks = []

        for window in windows:
            refined_text = self._adjust_window_boundaries(window, text)
            if refined_text and len(refined_text.strip()) >= self.min_chunk_size:
                refined_chunks.append(refined_text)

        return refined_chunks

    def _adjust_window_boundaries(self, window: WindowSegment, full_text: str) -> str:
        """Adjust individual window boundaries based on boundary respect setting."""
        start_pos = window.start_position
        end_pos = window.end_position

        if self.boundary_respect == "paragraph":
            # Extend to paragraph boundaries
            start_pos = self._find_paragraph_start(full_text, start_pos)
            end_pos = self._find_paragraph_end(full_text, end_pos)

        elif self.boundary_respect == "sentence":
            # Extend to sentence boundaries
            start_pos = self._find_sentence_start(full_text, start_pos)
            end_pos = self._find_sentence_end(full_text, end_pos)

        elif self.boundary_respect == "word":
            # Extend to word boundaries
            start_pos = self._find_word_start(full_text, start_pos)
            end_pos = self._find_word_end(full_text, end_pos)

        # Ensure we don't exceed size limits
        adjusted_text = full_text[start_pos:end_pos]
        if len(adjusted_text) > self.max_chunk_size:
            # Trim from the end to fit
            end_pos = start_pos + self.max_chunk_size
            if self.boundary_respect != "none":
                end_pos = self._find_safe_cut_point(full_text, start_pos, end_pos)
            adjusted_text = full_text[start_pos:end_pos]

        return adjusted_text.strip()

    @staticmethod
    def _find_paragraph_start(text: str, position: int) -> int:
        """Find the start of the paragraph containing the given position."""
        if position == 0:
            return 0

        # Look backwards for paragraph break
        search_start = max(0, position - 200)  # Reasonable search window
        search_text = text[search_start:position]

        matches = list(re.finditer(r"\n\s*\n", search_text))
        if matches:
            last_match = matches[-1]
            return search_start + last_match.end()

        return search_start

    @staticmethod
    def _find_paragraph_end(text: str, position: int) -> int:
        """Find the end of the paragraph containing the given position."""
        search_end = min(len(text), position + 200)
        search_text = text[position:search_end]

        match = re.search(r"\n\s*\n", search_text)
        if match:
            return position + match.start()

        return search_end

    @staticmethod
    def _find_sentence_start(text: str, position: int) -> int:
        """Find the start of the sentence containing the given position."""
        if position == 0:
            return 0

        search_start = max(0, position - 100)
        search_text = text[search_start:position]

        # Look for sentence endings
        matches = list(re.finditer(r"[.!?]\s+", search_text))
        if matches:
            last_match = matches[-1]
            return search_start + last_match.end()

        return search_start

    @staticmethod
    def _find_sentence_end(text: str, position: int) -> int:
        """Find the end of the sentence containing the given position."""
        search_end = min(len(text), position + 100)
        search_text = text[position:search_end]

        match = re.search(r"[.!?]\s+", search_text)
        if match:
            return position + match.end() - 1  # Don't include the space

        return search_end

    @staticmethod
    def _find_word_start(text: str, position: int) -> int:
        """Find the start of the word containing the given position."""
        if position == 0:
            return 0

        while position > 0 and not text[position].isspace():
            position -= 1

        return position + 1 if position > 0 else 0

    @staticmethod
    def _find_word_end(text: str, position: int) -> int:
        """Find the end of the word containing the given position."""
        while position < len(text) and not text[position].isspace():
            position += 1

        return position

    def _find_safe_cut_point(self, text: str, start: int, max_end: int) -> int:
        """Find a safe point to cut text without breaking words/sentences."""
        if self.boundary_respect == "sentence":
            # Look for sentence boundary
            search_text = text[start:max_end]
            matches = list(re.finditer(r"[.!?]\s+", search_text))
            if matches:
                last_match = matches[-1]
                return start + last_match.end() - 1

        elif self.boundary_respect == "word":
            # Look for word boundary
            position = max_end - 1
            while position > start and not text[position].isspace():
                position -= 1
            return position if position > start else max_end

        return max_end

    def _apply_size_constraints(self, chunks: list[str]) -> list[str]:
        """Apply size constraints and filter out invalid chunks."""
        valid_chunks = []

        for chunk in chunks:
            chunk = chunk.strip()
            chunk_size = len(chunk)

            if chunk_size < self.min_chunk_size:
                # Too small, try to merge with previous chunk
                if valid_chunks and len(valid_chunks[-1]) + chunk_size <= self.max_chunk_size:
                    valid_chunks[-1] = valid_chunks[-1] + "\n\n" + chunk
                # Otherwise skip this chunk
                continue

            elif chunk_size > self.max_chunk_size:
                # Too large, split further
                sub_chunks = self._split_oversized_chunk(chunk)
                valid_chunks.extend(sub_chunks)

            else:
                valid_chunks.append(chunk)

        return valid_chunks

    def _split_oversized_chunk(self, chunk: str) -> list[str]:
        """Split an oversized chunk into smaller valid chunks."""
        sub_chunks = []

        if self.boundary_respect == "paragraph":
            paragraphs = re.split(r"\n\s*\n", chunk)
            current_chunk = ""

            for paragraph in paragraphs:
                if len(current_chunk + paragraph) <= self.max_chunk_size:
                    current_chunk += paragraph + "\n\n"
                else:
                    if current_chunk:
                        sub_chunks.append(current_chunk.strip())
                    current_chunk = paragraph + "\n\n"

            if current_chunk:
                sub_chunks.append(current_chunk.strip())

        else:
            # Simple character-based splitting
            position = 0
            while position < len(chunk):
                end_pos = min(position + self.max_chunk_size, len(chunk))
                sub_chunk = chunk[position:end_pos].strip()
                if sub_chunk:
                    sub_chunks.append(sub_chunk)
                position += self.max_chunk_size - self.chunk_overlap

        return sub_chunks

    def _post_process_chunks(self, chunks: list[str], _original_text: str) -> list[str]:
        """Post-process chunks for final cleanup and optimization."""
        processed_chunks = []

        for chunk in chunks:
            # Clean up whitespace
            chunk = re.sub(r"\n\s*\n\s*\n+", "\n\n", chunk)
            chunk = chunk.strip()

            if chunk and len(chunk) >= self.min_chunk_size:
                processed_chunks.append(chunk)

        # Remove near-duplicate chunks caused by excessive overlap
        deduplicated_chunks = self._deduplicate_chunks(processed_chunks)

        return deduplicated_chunks

    @staticmethod
    def _deduplicate_chunks(chunks: list[str]) -> list[str]:
        """Remove near-duplicate chunks caused by excessive overlap."""
        if len(chunks) <= 1:
            return chunks

        unique_chunks = [chunks[0]]

        for current_chunk in chunks[1:]:
            # Check similarity with previous chunk
            previous_chunk = unique_chunks[-1]

            # Convert text chunks to word sets for similarity comparison
            current_words = set(current_chunk.lower().split())
            previous_words = set(previous_chunk.lower().split())
            similarity = jaccard_similarity(current_words, previous_words)

            # If similarity is too high, skip this chunk
            if similarity < 0.8:  # 80% similarity threshold
                unique_chunks.append(current_chunk)

        return unique_chunks

    def _fallback_chunking(self, text: str) -> list[str]:
        """Fallback chunking method when sliding window fails."""
        from src.main.utils.documents.utils import fallback_chunking_with_overlap

        logger.warning("Falling back to simple paragraph-based chunking with overlap")
        return fallback_chunking_with_overlap(text, self.chunk_size, self.chunk_overlap)
