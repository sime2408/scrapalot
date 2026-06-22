"""Atomic JSONL output writing."""

from __future__ import annotations

import os

from scripts.dataset_generator.core.models import QAMetadata, QAOutput, QAPair
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class OutputWriter:
    """Writes Q&A pairs to a JSONL file with atomic appends."""

    def __init__(self, output_path: str):
        self.output_path = output_path
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    def write_pairs(
        self,
        pairs: list[QAPair],
        book_title: str,
        source_file: str,
    ) -> int:
        """
        Append Q&A pairs to the JSONL file.

        Each pair is written as a single JSON line. Uses append mode so that
        partial writes from previous runs are preserved. The chapter title is
        taken from each pair's source_chapter field.

        Args:
            pairs: List of QAPair objects to write
            book_title: Title of the source book
            source_file: Original file path on disk

        Returns:
            Number of pairs written
        """
        written = 0
        with open(self.output_path, "a", encoding="utf-8") as f:
            for pair in pairs:
                output = QAOutput(
                    question=pair.question,
                    answer=pair.answer,
                    thinking=pair.thinking,
                    metadata=QAMetadata(
                        book_title=book_title,
                        chapter=pair.source_chapter,
                        topics=pair.topics,
                        quality_score=pair.quality_score,
                        source_file=source_file.replace("\\", "/"),
                    ),
                )
                line = output.model_dump_json()
                f.write(line + "\n")
                written += 1

        if written > 0:
            logger.debug("Wrote %d Q&A pairs for '%s'", written, book_title)
        return written

    def count_existing_lines(self) -> int:
        """Count the number of lines already in the output file."""
        if not os.path.exists(self.output_path):
            return 0
        with open(self.output_path, encoding="utf-8") as f:
            return sum(1 for _ in f)
