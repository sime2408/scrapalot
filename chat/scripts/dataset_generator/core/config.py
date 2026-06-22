"""Configuration loading for the dataset generator."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import sys

# Ensure the project root is on sys.path so we can import from src/.
# File now lives at scripts/dataset_generator/core/config.py — go up 3 dirs.
_PROJECT_ROOT = str(Path(__file__).resolve().parents[3])
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from src.main.utils.config.loader import resolved_config, resolved_prompts  # noqa: E402


@dataclass
class DatasetGeneratorConfig:
    """Configuration for the dataset generator pipeline."""

    chunk_size: int = 2000
    chunk_overlap: int = 200
    chunking_strategy: str = "enhanced_markdown"
    target_pairs_per_chapter: int = 4
    min_quality_score: float = 3.0
    max_book_tokens: int = 6_000
    min_chapter_chars: int = 500
    dedup_similarity_threshold: float = 0.85
    skip_patterns: list[str] = field(
        default_factory=lambda: [
            "table of contents",
            "bibliography",
            "references",
            "index",
            "acknowledgments",
            "about the author",
            "copyright",
            "appendix",
        ]
    )
    # Optional topic-specific guidance injected into the QA prompt.
    # Set by the pipeline based on the input directory name.
    topic_focus: str = ""


def load_config() -> DatasetGeneratorConfig:
    """Load dataset generator config from config.yaml, falling back to defaults.

    Any field absent from the YAML keeps its dataclass default — no need to
    enumerate them one-by-one.
    """
    section = resolved_config.get("dataset_generator", {}) or {}
    defaults = DatasetGeneratorConfig()
    overrides = {f: section[f] for f in defaults.__dataclass_fields__ if f in section}
    return DatasetGeneratorConfig(**{**defaults.__dict__, **overrides})


def load_qa_prompt() -> str:
    """Load the Q&A extraction prompt from prompts.yaml."""
    section = resolved_prompts.get("dataset_generator", {})
    prompt = section.get("qa_extraction_prompt", "")
    if not prompt:
        raise ValueError("Missing dataset_generator.qa_extraction_prompt in configs/prompts.yaml")
    return prompt
