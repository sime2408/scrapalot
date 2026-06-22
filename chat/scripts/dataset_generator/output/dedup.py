"""TF-IDF cosine similarity deduplication (local, no LLM needed).

Two public surfaces:
  * :func:`deduplicate_pairs` — in-memory dedup over :class:`QAPair` objects
    (used during a single book's pipeline).
  * :func:`deduplicate_jsonl` — final cross-book pass over the on-disk JSONL.

Both share :func:`_tfidf_duplicate_indices` so the actual TF-IDF / cosine /
quality-tie-break logic lives in exactly one place.
"""

from __future__ import annotations

import json
import os

from scripts.dataset_generator.core.models import QAPair
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _tfidf_duplicate_indices(
    texts: list[str],
    quality_scores: list[float],
    similarity_threshold: float,
) -> set[int]:
    """Return the indices that should be dropped as TF-IDF cosine duplicates.

    For every pair with cosine similarity ≥ ``similarity_threshold`` the entry
    with the lower ``quality_scores`` value is marked for removal (ties keep
    the earlier one). Returns an empty set when scikit-learn is unavailable
    or when there is nothing to compare.
    """
    if len(texts) <= 1:
        return set()

    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.metrics.pairwise import cosine_similarity
    except ImportError:
        logger.warning("scikit-learn not installed, skipping deduplication")
        return set()

    vectorizer = TfidfVectorizer(stop_words="english", max_features=10_000)
    matrix = vectorizer.fit_transform(texts)
    sim = cosine_similarity(matrix)

    to_remove: set[int] = set()
    n = len(texts)
    for i in range(n):
        if i in to_remove:
            continue
        for j in range(i + 1, n):
            if j in to_remove:
                continue
            if sim[i, j] >= similarity_threshold:
                if quality_scores[i] >= quality_scores[j]:
                    to_remove.add(j)
                else:
                    to_remove.add(i)
                    break  # i was removed; stop comparing against it
    return to_remove


def deduplicate_pairs(pairs: list[QAPair], similarity_threshold: float = 0.85) -> list[QAPair]:
    """Drop near-duplicate Q&A pairs by TF-IDF cosine similarity.

    The pair with the lower ``quality_score`` is removed from each duplicate
    group. Returns the surviving pairs in their original order.
    """
    if len(pairs) <= 1:
        return pairs

    texts = [f"{p.question} {p.answer}" for p in pairs]
    scores = [p.quality_score for p in pairs]
    to_remove = _tfidf_duplicate_indices(texts, scores, similarity_threshold)
    if not to_remove:
        return pairs

    survivors = [p for i, p in enumerate(pairs) if i not in to_remove]
    removed = len(pairs) - len(survivors)
    logger.info(
        "Deduplication removed %d pairs (%.1f%%), %d remaining",
        removed,
        100 * removed / len(pairs),
        len(survivors),
    )
    return survivors


def deduplicate_jsonl(output_path: str, similarity_threshold: float = 0.85) -> int:
    """Run a final cross-book dedup pass over a JSONL output file.

    Reads every line, finds near-duplicates by question+answer text, and
    rewrites the file keeping only the unique entries. Returns the number
    of lines removed (0 when nothing to do).
    """
    if not os.path.exists(output_path):
        return 0

    with open(output_path, encoding="utf-8") as fh:
        lines = [line.strip() for line in fh if line.strip()]
    if len(lines) <= 1:
        return 0

    objects = [json.loads(line) for line in lines]
    texts = [f"{obj.get('question', '')} {obj.get('answer', '')}" for obj in objects]
    scores = [float(obj.get("metadata", {}).get("quality_score", 0)) for obj in objects]

    to_remove = _tfidf_duplicate_indices(texts, scores, similarity_threshold)
    if not to_remove:
        return 0

    kept = [obj for i, obj in enumerate(objects) if i not in to_remove]
    with open(output_path, "w", encoding="utf-8") as fh:
        for obj in kept:
            fh.write(json.dumps(obj, ensure_ascii=False) + "\n")

    removed = len(to_remove)
    logger.info(
        "Cross-book dedup: removed %d duplicates (%.1f%%), %d pairs remaining",
        removed,
        100 * removed / len(objects),
        len(kept),
    )
    return removed
