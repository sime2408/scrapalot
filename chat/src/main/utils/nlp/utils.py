"""
NLP utilities for entity processing, similarity calculations, and spaCy operations.

This module consolidates entity utilities, similarity calculations, and spaCy
model management for natural language processing tasks.
"""

import asyncio
from collections import defaultdict
from difflib import SequenceMatcher
from functools import wraps
from typing import TYPE_CHECKING, Any
import unicodedata
import uuid

import numpy as np

# Heavy imports moved to lazy loading to speed up FastAPI startup
# Only import for type checking, not at runtime
if TYPE_CHECKING:
    from spacy.pipeline import EntityRuler

import spacy
from spacy.cli import download

from src.main.models.enums import EntityType
from src.main.models.similarity import ExtractedEntity
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def canonical_key(name: str | None) -> str:
    """Deduplication key for an entity name — the value stored as
    ``Entity.canonical_name`` and the property ``create_entity_node`` MERGEs on.

    Case / whitespace / punctuation / diacritic insensitive, but PRESERVES every
    letter (including non-ASCII) and digit, so orthographic variants of one name
    collapse to a single node at creation time ("MacNeish" == "Mac Neish",
    "washington d.c." == "washington dc", "dávila" == "davila") while genuinely
    distinct names stay apart (the Greek prefix keeps "γ-carotene" / "ζ-carotene"
    / "carotene" separate; digits keep "chapter 1" / "chapter 11" apart). Every
    canonical_name producer AND lookup must route through this one function so a
    name and its key always agree. Falls back to a lowercased/space-collapsed
    form when the aggressive key would be empty (punctuation-only names), so such
    entities are not all merged onto one empty key.
    """
    if not name:
        return ""
    decomposed = unicodedata.normalize("NFKD", name)
    out: list[str] = []
    for ch in decomposed:
        if unicodedata.combining(ch):
            continue  # drop diacritic marks: dávila -> davila
        if unicodedata.category(ch)[0] in ("L", "N"):  # keep letters + numbers only
            out.append(ch.lower())
    key = "".join(out)
    return key if key else " ".join(name.lower().split())


# Similarity Calculation Functions
def cosine_similarity(vec1: list[float], vec2: list[float]) -> float:
    """
    Calculate cosine similarity between two vectors.

    Args:
        vec1: First vector
        vec2: Second vector

    Returns:
        Cosine similarity score (0.0 to 1.0)
    """
    try:
        arr1 = np.array(vec1)
        arr2 = np.array(vec2)

        dot_product = np.dot(arr1, arr2)
        norm1 = np.linalg.norm(arr1)
        norm2 = np.linalg.norm(arr2)

        if norm1 == 0.0 or norm2 == 0.0:
            return 0.0

        # noinspection PyTypeChecker
        return float(dot_product / (norm1 * norm2))

    except Exception as e:
        logger.error("Error calculating cosine similarity: %s", e)
        return 0.0


def jaccard_similarity(set1: set, set2: set) -> float:
    """
    Calculate Jaccard similarity between two sets.

    Args:
        set1: First set
        set2: Second set

    Returns:
        Jaccard similarity score (0.0 to 1.0)
    """
    if not set1 and not set2:
        return 1.0
    if not set1 or not set2:
        return 0.0

    intersection = len(set1.intersection(set2))
    union = len(set1.union(set2))

    return intersection / union if union > 0 else 0.0


def levenshtein_similarity(text1: str, text2: str) -> float:
    """
    Calculate Levenshtein similarity between two strings.

    Args:
        text1: First text string
        text2: Second text string

    Returns:
        Levenshtein similarity score (0.0 to 1.0)
    """
    try:
        import Levenshtein

        distance = Levenshtein.distance(text1, text2)
        max_len = max(len(text1), len(text2))
        return 1.0 - (distance / max_len) if max_len > 0 else 1.0
    except ImportError:
        # Fallback to sequence similarity if Levenshtein is not available
        return sequence_similarity(text1, text2)


def sequence_similarity(text1: str, text2: str) -> float:
    """
    Calculate sequence similarity using difflib.

    Args:
        text1: First text string
        text2: Second text string

    Returns:
        Sequence similarity score (0.0 to 1.0)
    """
    try:
        return SequenceMatcher(None, text1, text2).ratio()
    except ImportError:
        logger.warning("difflib not available for sequence similarity")
        return 0.0


def clean_text_pair(text1: str, text2: str) -> tuple[str, str]:
    """
    Helper function to clean a pair of text strings for similarity comparison.

    Args:
        text1: First text string
        text2: Second text string

    Returns:
        Tuple of cleaned text strings (text1_clean, text2_clean)
    """
    text1_clean = text1.lower().strip()
    text2_clean = text2.lower().strip()
    return text1_clean, text2_clean


def fuzzy_string_similarity(text1: str, text2: str, weights: dict = None) -> float:
    """
    Calculate fuzzy string similarity using multiple methods.

    Args:
        text1: First text string
        text2: Second text string
        weights: Dictionary of method weights (default: equal weights)

    Returns:
        Combined fuzzy similarity score (0.0 to 1.0)
    """
    if weights is None:
        weights = {"sequence": 0.4, "jaccard": 0.3, "levenshtein": 0.3}

    text1_clean, text2_clean = clean_text_pair(text1, text2)

    # Calculate different similarity metrics
    sequence_sim = sequence_similarity(text1_clean, text2_clean)

    # Jaccard similarity (for word-level comparison)
    words1 = set(text1_clean.split())
    words2 = set(text2_clean.split())
    jaccard_sim = jaccard_similarity(words1, words2)

    # Levenshtein-based similarity
    levenshtein_sim = levenshtein_similarity(text1_clean, text2_clean)

    # Weighted combination
    final_score = (
        weights.get("sequence", 0.4) * sequence_sim + weights.get("jaccard", 0.3) * jaccard_sim + weights.get("levenshtein", 0.3) * levenshtein_sim
    )

    return final_score


def exact_string_similarity(text1: str, text2: str, check_containment: bool = True) -> float:
    """
    Calculate exact string similarity with optional containment check.

    Args:
        text1: First text string
        text2: Second text string
        check_containment: Whether to check for substring containment

    Returns:
        Exact similarity score (0.0, 0.8, or 1.0)
    """
    text1_clean, text2_clean = clean_text_pair(text1, text2)

    # Check for exact match
    if text1_clean == text2_clean:
        return 1.0

    # Check for containment (one name is subset of another)
    if check_containment and len(text1_clean) > 3 and len(text2_clean) > 3:
        if text1_clean in text2_clean or text2_clean in text1_clean:
            return 0.8

    return 0.0


def _calculate_average_similarity(similarity_pairs: list[tuple[int, int]], similarity_matrix: "np.ndarray") -> float:
    """
    Helper function to calculate average similarity for a list of index pairs.

    Args:
        similarity_pairs: List of (i, j) index pairs to calculate similarity for
        similarity_matrix: Pairwise similarity matrix

    Returns:
        Average similarity score
    """
    if not similarity_pairs:
        return 0.0

    total_similarity = 0.0
    count = 0

    for i, j in similarity_pairs:
        total_similarity += similarity_matrix[i][j]
        count += 1

    return total_similarity / count if count > 0 else 0.0


def calculate_cluster_similarity(cluster1_indices: list[int], cluster2_indices: list[int], similarity_matrix: "np.ndarray") -> float:
    """
    Calculate similarity between two clusters using average linkage.

    Args:
        cluster1_indices: Indices of entities in first cluster
        cluster2_indices: Indices of entities in second cluster
        similarity_matrix: Pairwise similarity matrix

    Returns:
        Average similarity between clusters
    """
    if not cluster1_indices or not cluster2_indices:
        return 0.0

    # Generate all pairs between the two clusters
    similarity_pairs = [(i, j) for i in cluster1_indices for j in cluster2_indices]
    return _calculate_average_similarity(similarity_pairs, similarity_matrix)


def calculate_cohesion_score(cluster_indices: list[int], similarity_matrix: "np.ndarray") -> float:
    """
    Calculate cohesion score for a cluster.

    Args:
        cluster_indices: Indices of entities in the cluster
        similarity_matrix: Pairwise similarity matrix

    Returns:
        Average internal similarity (cohesion score)
    """
    if len(cluster_indices) <= 1:
        return 1.0

    # Generate all unique pairs within the cluster
    similarity_pairs = [(cluster_indices[i], cluster_indices[j]) for i in range(len(cluster_indices)) for j in range(i + 1, len(cluster_indices))]
    return _calculate_average_similarity(similarity_pairs, similarity_matrix)


def find_centroid_index(cluster_indices: list[int], similarity_matrix: "np.ndarray") -> int:
    """
    Find the index of the entity that best represents the cluster (centroid).

    Args:
        cluster_indices: Indices of entities in the cluster
        similarity_matrix: Pairwise similarity matrix

    Returns:
        Index of the centroid entity
    """
    if len(cluster_indices) == 1:
        return cluster_indices[0]

    best_entity_idx = cluster_indices[0]
    best_avg_similarity = -1

    for entity_idx in cluster_indices:
        # Calculate average similarity to other entities in cluster
        total_sim = sum(similarity_matrix[entity_idx][other_idx] for other_idx in cluster_indices if other_idx != entity_idx)
        avg_sim = total_sim / (len(cluster_indices) - 1) if len(cluster_indices) > 1 else 0

        if avg_sim > best_avg_similarity:
            best_avg_similarity = avg_sim
            best_entity_idx = entity_idx

    return best_entity_idx


def semantic_similarity(text1: str, text2: str, embeddings_func=None) -> float:
    """
    Calculate semantic similarity using embeddings.

    Args:
        text1: First text
        text2: Second text
        embeddings_func: Function to generate embeddings

    Returns:
        Semantic similarity score (0.0 to 1.0)
    """
    try:
        if not embeddings_func:
            # Fallback to string similarity if no embeddings function provided
            return levenshtein_similarity(text1, text2)

        # Generate embeddings
        emb1 = embeddings_func(text1)
        emb2 = embeddings_func(text2)

        # Calculate cosine similarity
        return cosine_similarity(emb1, emb2)

    except Exception as e:
        logger.error("Error calculating semantic similarity: %s", e)
        return levenshtein_similarity(text1, text2)  # Fallback


# Entity Processing Functions
def preprocess_chunks(chunks: list[dict[str, Any]], config: dict[str, Any] = None) -> list[dict[str, str]]:
    """
    Preprocess chunks for entity extraction with chapter-aware grouping.

    Groups chunks by chapter/section metadata before merging, producing
    ~5-15 extraction units per book instead of ~150. Chunks without chapter
    metadata fall back to sequential merging.

    Args:
        chunks: Raw chunks with metadata
        config: Optional config dict with merge_chunks, min_merged_words, max_merged_words, max_tokens_per_group

    Returns:
        Preprocessed (and optionally merged) chunks ready for extraction
    """
    # Get config settings
    if config is None:
        from src.main.utils.config.loader import resolved_config

        config = resolved_config.get("entity_extraction", {})

    merge_chunks_enabled = config.get("merge_chunks", True)
    min_merged_words = int(config.get("min_merged_words", 200))
    max_merged_words = int(config.get("max_merged_words", 1000))
    max_tokens_per_group = int(config.get("max_tokens_per_group", 32000))

    # First, extract and clean all chunks, preserving metadata
    cleaned_chunks = []
    for i, chunk in enumerate(chunks):
        # Extract text content and metadata
        if isinstance(chunk, dict):
            text = chunk.get("page_content", chunk.get("text", ""))
            chunk_id = chunk.get("id", f"chunk_{i}")
            metadata = chunk.get("metadata", chunk.get("cmetadata", {}))
            if metadata is None:
                metadata = {}
        else:
            # Handle string chunks
            text = str(chunk)
            chunk_id = f"chunk_{i}"
            metadata = {}

        # Clean and validate text
        if isinstance(text, str) and len(text.strip()) >= 20:
            cleaned_text = clean_text_for_extraction(text)
            if cleaned_text:
                cleaned_chunks.append({"id": chunk_id, "text": cleaned_text, "original_index": i, "metadata": metadata})

    # If merging is disabled, or we have very few chunks, return as-is
    if not merge_chunks_enabled or len(cleaned_chunks) <= 1:
        return [{"id": c["id"], "text": c["text"], "original_index": c["original_index"]} for c in cleaned_chunks]

    # Separate chunks into chapter-grouped and ungrouped
    chapter_groups = defaultdict(list)
    ungrouped_chunks = []

    for chunk in cleaned_chunks:
        metadata = chunk["metadata"]
        chapter = metadata.get("chapter_number")
        section = metadata.get("section_heading", "")

        if chapter is not None:
            key = (str(chapter), section)
            chapter_groups[key].append(chunk)
        else:
            ungrouped_chunks.append(chunk)

    merged_chunks = []

    # Merge chapter-grouped chunks respecting token limit
    if chapter_groups:
        merged_chunks.extend(_merge_chapter_groups(chapter_groups, max_tokens_per_group))

    # Fall back to sequential merging for ungrouped chunks
    if ungrouped_chunks:
        merged_chunks.extend(_sequential_merge(ungrouped_chunks, min_merged_words, max_merged_words))

    logger.info(
        "Merged %d chunks into %d extraction units (chapter_groups=%d, ungrouped=%d, max_tokens=%d)",
        len(cleaned_chunks),
        len(merged_chunks),
        len(chapter_groups),
        len(ungrouped_chunks),
        max_tokens_per_group,
    )

    return merged_chunks


def _merge_chapter_groups(chapter_groups: dict[tuple, list[dict[str, Any]]], max_tokens: int) -> list[dict[str, str]]:
    """
    Merge chunks within each chapter/section group, splitting if a group exceeds the token limit.

    Args:
        chapter_groups: Mapping of (chapter_number, section_heading) to chunks
        max_tokens: Maximum tokens per merged extraction unit

    Returns:
        List of merged chunks
    """
    from src.main.utils.tokens.counting import count_tokens

    merged = []

    # Sort groups by chapter number for deterministic ordering
    sorted_keys = sorted(chapter_groups.keys(), key=lambda k: (k[0], k[1]))

    for key in sorted_keys:
        group_chunks = chapter_groups[key]
        chapter_num, _ = key

        # Concatenate all text in this group
        current_ids = []
        current_texts = []
        current_first_index = group_chunks[0]["original_index"]

        for chunk in group_chunks:
            candidate_text = " ".join([*current_texts, chunk["text"]])
            token_count = count_tokens(candidate_text)

            if current_texts and token_count > max_tokens:
                # Finalize current subgroup
                merged.append(
                    {
                        "id": f"chapter_{chapter_num}_{current_ids[0]}_{current_ids[-1]}",
                        "text": " ".join(current_texts),
                        "original_index": current_first_index,
                        "source_chunk_ids": list(current_ids),
                    }
                )
                # Start new subgroup
                current_ids = [chunk["id"]]
                current_texts = [chunk["text"]]
                current_first_index = chunk["original_index"]
            else:
                current_ids.append(chunk["id"])
                current_texts.append(chunk["text"])

        # Finalize remaining
        if current_texts:
            merged.append(
                {
                    "id": f"chapter_{chapter_num}_{current_ids[0]}_{current_ids[-1]}",
                    "text": " ".join(current_texts),
                    "original_index": current_first_index,
                    "source_chunk_ids": list(current_ids),
                }
            )

    return merged


def _sequential_merge(chunks: list[dict[str, Any]], min_merged_words: int, max_merged_words: int) -> list[dict[str, str]]:
    """
    Merge chunks sequentially until reaching the minimum word count (original algorithm).

    Args:
        chunks: Cleaned chunks without chapter metadata
        min_merged_words: Minimum words per merged chunk
        max_merged_words: Maximum words per merged chunk

    Returns:
        List of merged chunks
    """
    merged_chunks = []
    current_merged = {"ids": [], "texts": [], "original_indices": []}

    for chunk in chunks:
        current_merged["ids"].append(chunk["id"])
        current_merged["texts"].append(chunk["text"])
        current_merged["original_indices"].append(chunk["original_index"])

        # Calculate current word count
        merged_text = " ".join(current_merged["texts"])
        word_count = len(merged_text.split())

        # If we've reached minimum words or max words, finalize this merged chunk
        if word_count >= min_merged_words or word_count >= max_merged_words:
            merged_chunks.append(
                {
                    "id": f"merged_{current_merged['ids'][0]}_{current_merged['ids'][-1]}",
                    "text": merged_text,
                    "original_index": current_merged["original_indices"][0],
                    "source_chunk_ids": current_merged["ids"],
                }
            )
            current_merged = {"ids": [], "texts": [], "original_indices": []}

    # Handle remaining chunks
    if current_merged["texts"]:
        merged_text = " ".join(current_merged["texts"])
        # If remaining is too small, merge with last chunk if possible
        if len(merged_chunks) > 0 and len(merged_text.split()) < min_merged_words // 2:
            last_chunk = merged_chunks[-1]
            last_chunk["text"] = last_chunk["text"] + " " + merged_text
            last_chunk["id"] = f"merged_{last_chunk['source_chunk_ids'][0]}_{current_merged['ids'][-1]}"
            last_chunk["source_chunk_ids"].extend(current_merged["ids"])
        else:
            merged_chunks.append(
                {
                    "id": f"merged_{current_merged['ids'][0]}_{current_merged['ids'][-1]}",
                    "text": merged_text,
                    "original_index": current_merged["original_indices"][0],
                    "source_chunk_ids": current_merged["ids"],
                }
            )

    return merged_chunks


def clean_text_for_extraction(text: str) -> str:
    """
    Clean text for entity extraction.

    Args:
        text: Raw text to clean

    Returns:
        Cleaned text ready for extraction
    """
    if not text:
        return ""

    # Remove excessive whitespace
    cleaned = " ".join(text.split())

    # Remove very short or very long texts
    if len(cleaned) < 20 or len(cleaned) > 10000:
        return ""

    return cleaned


def group_entities_by_name(entities: list["ExtractedEntity"]) -> dict[str, list["ExtractedEntity"]]:
    """
    Group entities by exact name match (case-insensitive).

    Args:
        entities: List of extracted entities

    Returns:
        Dictionary mapping normalized names to entity lists
    """
    name_groups = {}
    for entity in entities:
        name_key = entity.name.lower().strip()
        if name_key not in name_groups:
            name_groups[name_key] = []
        name_groups[name_key].append(entity)
    return name_groups


def fuzzy_deduplicate_entities(entities: list["ExtractedEntity"], threshold: float = 0.8) -> list["ExtractedEntity"]:
    """
    Apply fuzzy string matching for entity deduplication.

    Args:
        entities: List of entities to deduplicate
        threshold: Similarity threshold for considering entities as duplicates

    Returns:
        Deduplicated list of entities
    """
    if not entities:
        return []

    deduplicated = []
    processed_indices = set()

    for i, entity in enumerate(entities):
        if i in processed_indices:
            continue

        # Find similar entities
        similar_entities = [entity]
        for j, other_entity in enumerate(entities[i + 1 :], start=i + 1):
            if j in processed_indices:
                continue

            similarity = levenshtein_similarity(entity.name, other_entity.name)
            if similarity >= threshold:
                similar_entities.append(other_entity)
                processed_indices.add(j)

        # Merge similar entities (keep the one with the highest confidence)
        best_entity = max(similar_entities, key=lambda e: e.confidence_score)
        deduplicated.append(best_entity)
        processed_indices.add(i)

    return deduplicated


def merge_entity_descriptions(entities: list["ExtractedEntity"]) -> str:
    """
    Merge descriptions from similar entities.

    Args:
        entities: List of similar entities

    Returns:
        Merged description
    """
    if not entities:
        return ""

    if len(entities) == 1:
        return entities[0].description

    # Combine unique descriptions
    descriptions = []
    seen_descriptions = set()

    for entity in entities:
        desc = entity.description.strip()
        if desc and desc.lower() not in seen_descriptions:
            descriptions.append(desc)
            seen_descriptions.add(desc.lower())

    return "; ".join(descriptions)


def calculate_entity_confidence(entities: list["ExtractedEntity"]) -> float:
    """
    Calculate average confidence for a group of entities.

    Args:
        entities: List of entities

    Returns:
        Average confidence score
    """
    if not entities:
        return 0.0

    total_confidence = sum(entity.confidence_score for entity in entities)
    return total_confidence / len(entities)


def filter_entities_by_confidence(entities: list["ExtractedEntity"], min_confidence: float = 0.5) -> list["ExtractedEntity"]:
    """
    Filter entities by minimum confidence threshold.

    Args:
        entities: List of entities to filter
        min_confidence: Minimum confidence threshold

    Returns:
        Filtered list of entities
    """
    return [entity for entity in entities if entity.confidence_score >= min_confidence]


def generate_entity_id(entity_name: str, entity_type: str) -> str:
    """
    Generate a unique ID for an entity.

    Args:
        entity_name: Name of the entity
        entity_type: Type of the entity

    Returns:
        Unique entity ID
    """
    # Create a deterministic ID based on name and type
    base_string = f"{entity_name.lower().strip()}_{entity_type.lower()}"
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, base_string))


# spaCy Model Management Functions
def ensure_spacy_model(model_name: str = "en_core_web_md"):
    """Decorator to ensure spaCy model is available."""

    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            try:
                from src.main.utils.models.spacy_cache import get_spacy_cache

                # Use cache to check/load model
                spacy_cache = get_spacy_cache()
                if not spacy_cache.is_cached(model_name):
                    # Try to load/cache the model
                    try:
                        spacy_cache.get_model(model_name)
                    except OSError:
                        logger.warning("SpaCy model %s not found, attempting to install...", model_name)
                        # Run download in executor to avoid blocking
                        # noinspection PyTypeChecker
                        await asyncio.get_event_loop().run_in_executor(None, lambda: download(model_name, direct=False, sdist=False))
                        # Load and cache after download
                        spacy_cache.get_model(model_name)
                        logger.info("SpaCy model %s installed and cached successfully", model_name)
            except Exception as e:
                logger.error("Failed to ensure SpaCy model: %s", str(e))
                raise
            return await func(*args, **kwargs)

        return wrapper

    return decorator


@ensure_spacy_model()
async def verify_spacy_models():
    """Verify spaCy models are installed correctly and configure the pipeline."""
    try:
        # Load the model to verify it works
        nlp = spacy.load("en_core_web_md")

        # Test basic functionality
        doc = nlp("This is a test sentence.")
        logger.info("SpaCy model verification successful. Found %d tokens.", len(doc))

        # Check if the model has word vectors
        if nlp.vocab.vectors.size > 0:
            logger.info("SpaCy model has word vectors (%d vectors)", nlp.vocab.vectors.size)
        else:
            logger.warning("SpaCy model does not have word vectors")

        return True

    except Exception as e:
        logger.error("SpaCy model verification failed: %s", str(e))
        return False


def create_spacy_entity_ruler(nlp, patterns: list[dict[str, Any]]) -> "EntityRuler | None":
    """
    Create and configure a spaCy EntityRuler with custom patterns.

    Args:
        nlp: spaCy language model
        patterns: List of entity patterns

    Returns:
        Configured EntityRuler
    """
    try:
        # Create entity ruler
        ruler = nlp.add_pipe("entity_ruler", before="ner")

        # Add patterns
        ruler.add_patterns(patterns)

        logger.info("Created spaCy EntityRuler with %d patterns", len(patterns))
        return ruler

    except Exception as e:
        logger.error("Error creating spaCy EntityRuler: %s", str(e))
        return None


def extract_spacy_entities(text: str, model_name: str = "en_core_web_md") -> list[dict[str, Any]]:
    """
    Extract entities using spaCy NER.

    Args:
        text: Text to process
        model_name: spaCy model to use

    Returns:
        List of extracted entities
    """
    try:
        from src.main.utils.models.spacy_cache import get_spacy_cache

        # Use cached spaCy model instead of loading every time
        spacy_cache = get_spacy_cache()
        nlp = spacy_cache.get_model(model_name)
        doc = nlp(text)

        entities = []
        for ent in doc.ents:
            entities.append(
                {
                    "text": ent.text,
                    "label": ent.label_,
                    "start": ent.start_char,
                    "end": ent.end_char,
                    "confidence": 1.0,  # spaCy doesn't provide confidence scores by default
                }
            )

        logger.debug("Extracted %d entities using spaCy", len(entities))
        return entities

    except Exception as e:
        logger.error("Error extracting spaCy entities: %s", str(e))
        return []


def filter_invalid_entities(entities: list["ExtractedEntity"]) -> list["ExtractedEntity"]:
    """
    Filter out low-quality entities that are OCR artifacts, fragments, or noise.

    Removes:
    - Names shorter than 3 characters (initials like "I.", "a.", "Ge")
    - Names that are only digits/roman numerals ("II", "IV", "XXIX")
    - Names with OCR soft-hyphen artifacts ("Ana¬", "pos¬", "Hephais¬")
    - Names that look like page/figure references ("117a", "222n", "Orphic 201-204")
    - Names that are common English words not likely to be entities
    - Page number prefixes ("302 Plato", "162 Sicily")
    - Initial prefixes ("g. Persephone", "j. e. dixon")
    - Names that are just initials ("j. e. g.", "B.C.")
    - Trailing junk words ("Jericho We", "Plato and")
    - Leading articles before uppercase ("a The Neolithic Revolution:")
    """
    import re

    # Roman numeral pattern (standalone, not part of a title like "Chapter IV")
    _ROMAN_ONLY = re.compile(r"^[IVXLCDM]+\.?$")
    # Page/figure references: "117a", "222n", "433a", "II.50"
    _PAGE_REF = re.compile(r"^\d+[a-z]?$|^[IVXLCDM]+\.\d+$")
    # OCR soft-hyphen artifacts: word ending with ¬ or ­
    _OCR_HYPHEN = re.compile(r"[¬­]")
    # Page range patterns: "201-204", "c. 25/23,000"
    _PAGE_RANGE = re.compile(r"^\d[\d,./\s-]+$")
    # Single letter + period: "a.", "f.", "j.", "I."
    _INITIAL = re.compile(r"^[a-zA-Z]\.$")
    # Page number prefix: "302 Plato", "162 Sicily"
    _PAGE_PREFIX = re.compile(r"^\d+\s+")
    # Initial prefix: "g. Persephone", "l. Sicily", "j. e. dixon"
    _INITIAL_PREFIX = re.compile(r"^[a-z]\.\s+", re.IGNORECASE)
    # Just initials: "j. e. g.", "j. e.", "B.C."
    _JUST_INITIALS = re.compile(r"^[a-z]\.\s*([a-z]\.?\s*)*$", re.IGNORECASE)
    # Trailing junk word: "Jericho We", "Plato and"
    _TRAILING_JUNK = re.compile(r"\s+(We|and|the|of|in|on|at|to|a)$", re.IGNORECASE)
    # Leading article before uppercase: "a The Neolithic Revolution:"
    _LEADING_ARTICLE = re.compile(r"^(a|an)\s+(?=[A-Z])")
    # URLs and email addresses
    _URL = re.compile(r"https?://|www\.|\.com/|\.org/|\.edu/|@\w+\.\w+")
    # HTML/XML tags and angle brackets
    _HTML_TAGS = re.compile(r"<[^>]+>|&[a-z]+;|&#\d+;")
    # Markdown table fragments: "|---|", "| text |"
    _MARKDOWN_TABLE = re.compile(r"^\|[\s|*_-]+\|?$|^\|.*\|.*\|")
    # Markdown link fragments: "[text](url)" or "text](http"
    _MARKDOWN_LINK = re.compile(r"\]\s*\(https?:|^\[.*\]\(")
    # OCR garbage: 3+ consecutive special/non-alpha characters (e.g., "????", "J2>????jd")
    _OCR_GARBAGE = re.compile(r"[?>{}<|\\]{3,}")
    # Pipe characters — table cell fragments from OCR ("America|25 kg|*Both")
    _PIPE_CHAR = re.compile(r"\|")
    # Unclosed HTML tags from OCR ("dark green,<br", "fl eshy,<br")
    _UNCLOSED_HTML = re.compile(r"<(?:br|p|div|td|tr|th|li|ul|ol)\b")
    # Trailing ampersand/comma — incomplete fragments ("Jet &", "Greece,")
    _TRAILING_FRAGMENT = re.compile(r"[&,;]\s*$")
    # OCR high-byte garbage chars common in scanned PDFs
    _OCR_HIGHBYTE = re.compile(r"[¿¥ùòÇÈô»«]")
    # Phone numbers: "(702) 289-7618", "+1-555-123-4567", "555.123.4567"
    _PHONE = re.compile(r"^\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}$|^\+?\d[\d\s.-]{8,}$")
    # PO Box / zip codes: "P.O. Box 22201", "VT 05053", "CA 90210"
    _PO_BOX_ZIP = re.compile(r"^P\.?O\.?\s*Box\s+\d+|^[A-Z]{2}\s+\d{5}$", re.IGNORECASE)
    # Standalone dates as entities: "October 2002", "January 1979", "June 8, 2004"
    _STANDALONE_DATE = re.compile(
        r"^(?:January|February|March|April|May|June|July|August|September|October|November|December)"
        r"(?:/(?:January|February|March|April|May|June|July|August|September|October|November|December))?"
        r"(?:\s+\d{1,2},?)?\s*\d{4}$",
        re.IGNORECASE,
    )
    # Bibliographic references: "Friedman 1975", "Princeton, 1996", "Columbia University (1996"
    _BIBLIO_REF = re.compile(r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*[,\s]+\(?\d{4}\)?$")
    # Archive/manuscript references: "f.582", "d.6350", "184ob", "Migulin 216"
    _ARCHIVE_REF = re.compile(r"^[a-z]\.\d+$|^\d+[a-z]{1,2}$|^[A-Z][a-z]+\s+\d{3,}$")
    # Quoted full sentences extracted as entities (long strings with quotes)
    _QUOTED_SENTENCE = re.compile(r'^["\u201c\u201d].{50,}["\u201c\u201d]?$')
    # Location-prefixed dates: "Milan, November 1978", "London, 2005"
    _LOCATION_DATE = re.compile(
        r"^[A-Z][a-z]+,\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)?\s*\d{4}$", re.IGNORECASE
    )
    # Journal/publication names with year: "Crucible 2002"
    _PUB_YEAR = re.compile(r"^[A-Z][a-z]+\s+\d{4}$")
    # Homeopathic/measurement fractions: "1000/1 homeopathic dilution"
    _MEASUREMENT_FRAC = re.compile(r"^\d+/\d+\s+")
    # Structural terms that are not entities
    _STRUCTURAL = re.compile(
        r"^(Chapter|Section|Table|Figure|Page|Index|Appendix|Part|Volume|Bibliography|References|Contents|Abstract|Preface|Glossary|Acknowledgements?)\b",
        re.IGNORECASE,
    )
    # Percentage/numeric-only patterns: "25%", "3.5", "100"
    _NUMERIC_ONLY = re.compile(r"^[\d.,]+%?$")
    # Currency/numeric-only entities ("$1.60", "£500", "220€")
    _CURRENCY_ONLY = re.compile(r"^[$£€¥]\s*[\d.,]+$|^[\d.,]+\s*[$£€¥%]$")
    # Single-letter pairs from OCR: "W L", "J J", "C Z" (2-3 single letters separated by spaces)
    _INITIAL_PAIRS = re.compile(r"^[A-Z]\s+[A-Z]{1,3}$")
    # TOC fragments: text with embedded page numbers ("Culture 61 Professional Personnel")
    _TOC_FRAGMENT = re.compile(r"\b\d{2,3}\s+[A-Z][a-z]")
    # Common English stop-words that should never be entities
    _STOP_ENTITIES = frozenset(
        {
            "the",
            "and",
            "but",
            "for",
            "not",
            "you",
            "all",
            "can",
            "had",
            "her",
            "was",
            "one",
            "our",
            "out",
            "day",
            "get",
            "has",
            "him",
            "his",
            "how",
            "its",
            "may",
            "new",
            "now",
            "old",
            "see",
            "way",
            "who",
            "did",
            "let",
            "say",
            "she",
            "too",
            "use",
            "fig",
            "map",
            "end",
            "bin",
            "don",
            "buff",
            "hole",
            "time",
            "east",
            "west",
            "lake",
            "bull",
            "axes",
            "lamps",
            "countless",
            "glory",
            # Standalone directional/generic locations (too vague to be useful entities)
            "south",
            "north",
            "central",
            "inner",
            "outer",
            "upper",
            "lower",
            "middle",
            "western",
            "eastern",
            "northern",
            "southern",
            "earth",
            # Common plant/nature words misidentified as Person by spaCy NER
            "bush",
            "reed",
            "plant",
            "root",
            "stem",
            "seed",
            "leaf",
            "bark",
            "stone",
            "spring",
            "field",
            "hill",
            "dale",
            "marsh",
            "grove",
            "vale",
            # Generic academic/structural terms
            "author",
            "editor",
            "press",
            "university",
            "volume",
            "journal",
            "review",
            "abstract",
            "introduction",
            "conclusion",
            "discussion",
            "results",
            "methods",
            "references",
            "bibliography",
            "index",
            "appendix",
            "preface",
            "foreword",
            "contents",
            "acknowledgements",
        }
    )
    # Leading articles to strip from entity names (e.g., "the United States" → "United States")
    _LEADING_THE = re.compile(r"^(the|a|an)\s+", re.IGNORECASE)

    filtered = []
    removed_count = 0

    for entity in entities:
        name = entity.name.strip()
        name_lower = name.lower()

        # Too short (< 3 chars)
        if len(name) < 3:
            removed_count += 1
            continue

        # Single initial with period
        if _INITIAL.match(name):
            removed_count += 1
            continue

        # Pure roman numeral
        if _ROMAN_ONLY.match(name):
            removed_count += 1
            continue

        # Page/figure reference (e.g., "117a", "222n", "II.50")
        if _PAGE_REF.match(name):
            removed_count += 1
            continue

        # OCR hyphenation artifact
        if _OCR_HYPHEN.search(name):
            removed_count += 1
            continue

        # Pure number/range
        if _PAGE_RANGE.match(name):
            removed_count += 1
            continue

        # Strip leading articles ("the United States" → "United States")
        stripped_name = _LEADING_THE.sub("", name).strip()
        if stripped_name and stripped_name != name:
            entity.name = stripped_name
            name = stripped_name
            name_lower = name.lower()

        # Technical identifiers (ISBN, DOI, etc.) — with or without colon/space
        if re.match(r"^(isbn|doi|issn|pmid|arxiv)[:\s]*\d", name_lower):
            removed_count += 1
            continue

        # All-lowercase single words that are likely common nouns, not proper nouns
        # (proper nouns should be capitalized: "China" not "china")
        if " " not in name and name == name_lower and len(name) > 2 and name.isalpha():
            # Capitalize it — if it survives other filters, at least the name is proper
            entity.name = name.capitalize()
            name = entity.name
            name_lower = name.lower()

        # Common stop words (only if single word)
        if " " not in name and name_lower in _STOP_ENTITIES:
            removed_count += 1
            continue

        # Page number prefix: "302 Plato", "162 Sicily"
        if _PAGE_PREFIX.match(name):
            removed_count += 1
            continue

        # Initial prefix: "g. Persephone", "j. e. dixon"
        if _INITIAL_PREFIX.match(name) and len(name) > 4:
            removed_count += 1
            continue

        # Just initials: "j. e. g.", "B.C."
        if _JUST_INITIALS.match(name):
            removed_count += 1
            continue

        # Trailing junk word: "Jericho We", "Plato and"
        if _TRAILING_JUNK.search(name):
            removed_count += 1
            continue

        # Leading article before uppercase: "a The Neolithic Revolution:"
        if _LEADING_ARTICLE.match(name):
            removed_count += 1
            continue

        # URLs and email addresses
        if _URL.search(name):
            removed_count += 1
            continue

        # HTML/XML tags
        if _HTML_TAGS.search(name):
            removed_count += 1
            continue

        # Markdown table fragments
        if _MARKDOWN_TABLE.match(name):
            removed_count += 1
            continue

        # Markdown link fragments
        if _MARKDOWN_LINK.search(name):
            removed_count += 1
            continue

        # OCR garbage (consecutive special chars)
        if _OCR_GARBAGE.search(name):
            removed_count += 1
            continue

        # Pipe characters (table cell fragments from OCR)
        if _PIPE_CHAR.search(name) and entity.entity_type.value != "quote":
            removed_count += 1
            continue

        # Unclosed HTML tags from OCR
        if _UNCLOSED_HTML.search(name):
            removed_count += 1
            continue

        # Trailing ampersand/comma/semicolon (incomplete fragments)
        if _TRAILING_FRAGMENT.search(name) and entity.entity_type.value != "quote":
            removed_count += 1
            continue

        # OCR high-byte garbage (short names with special chars from scanned PDFs)
        if _OCR_HIGHBYTE.search(name) and len(name) < 30 and entity.entity_type.value != "quote":
            removed_count += 1
            continue

        # Structural terms (Chapter, Section, Table, Figure, etc.)
        if _STRUCTURAL.match(name) and len(name.split()) <= 3:
            removed_count += 1
            continue

        # Numeric-only values
        if _NUMERIC_ONLY.match(name):
            removed_count += 1
            continue

        # Currency-only values ("$1.60", "£500", "220€")
        if _CURRENCY_ONLY.match(name):
            removed_count += 1
            continue

        # Single-letter pairs from OCR ("W L", "J J", "C Z")
        if _INITIAL_PAIRS.match(name):
            removed_count += 1
            continue

        # TOC fragments with embedded page numbers (>20 chars with "61 Professional")
        if len(name) > 20 and _TOC_FRAGMENT.search(name) and entity.entity_type.value != "quote":
            removed_count += 1
            continue

        # Names that are too long (>100 chars) — likely sentences, not entity names
        # Exception: Quote entities are allowed to be long
        if len(name) > 100 and entity.entity_type.value != "quote":
            removed_count += 1
            continue

        # Phone numbers
        if _PHONE.match(name):
            removed_count += 1
            continue

        # PO Box / zip codes
        if _PO_BOX_ZIP.match(name):
            removed_count += 1
            continue

        # Standalone dates ("October 2002", "June 8, 2004", "October/November")
        if _STANDALONE_DATE.match(name):
            removed_count += 1
            continue

        # Bibliographic references ("Friedman 1975", "Princeton, 1996")
        if _BIBLIO_REF.match(name):
            removed_count += 1
            continue

        # Archive/manuscript references ("f.582", "d.6350", "184ob")
        if _ARCHIVE_REF.match(name):
            removed_count += 1
            continue

        # Quoted full sentences extracted as entity names
        if _QUOTED_SENTENCE.match(name) and entity.entity_type.value != "quote":
            removed_count += 1
            continue

        # Location-prefixed dates ("Milan, November 1978")
        if _LOCATION_DATE.match(name):
            removed_count += 1
            continue

        # Publication name + year ("Crucible 2002") — but not real titles like "Art of War"
        if _PUB_YEAR.match(name) and name.split()[0] not in ("Art", "Book", "Great", "Holy"):
            removed_count += 1
            continue

        # Measurement fractions ("1000/1 homeopathic dilution")
        if _MEASUREMENT_FRAC.match(name):
            removed_count += 1
            continue

        # Single all-lowercase words without English vowels (likely non-English noise)
        # e.g., "nastpuj", "zostanie", "wszystkich" (Polish), "isbn13"
        if " " not in name and name == name_lower and len(name) > 4:
            vowels = sum(1 for c in name_lower if c in "aeiou")
            if vowels == 0 or (len(name) > 6 and vowels / len(name) < 0.15):
                removed_count += 1
                continue

        # Reclassify mistyped entities — abstract concepts wrongly labeled Person/Place
        _ABSTRACT_CONCEPTS = frozenset(
            {
                "nature",
                "spirit",
                "soul",
                "mind",
                "body",
                "self",
                "ego",
                "light",
                "darkness",
                "truth",
                "knowledge",
                "wisdom",
                "power",
                "energy",
                "consciousness",
                "awareness",
                "transformation",
                "enlightenment",
                "meditation",
                "masonic",
                "hermeticism",
                "alchemy",
                "philosophy",
                "science",
                "art",
                "magic",
                "mysticism",
                "occultism",
                "esotericism",
                "symbolism",
                "mythology",
                "cosmology",
                "astrology",
                "kabbalah",
                "gnosticism",
                "theosophy",
                "rosicrucianism",
                "freemasonry",
                "initiation",
                "rebirth",
                "resurrection",
                "immortality",
                "transcendence",
                "divinity",
                "creation",
                "destruction",
                "chaos",
                "order",
                "harmony",
                "balance",
                "fire",
                "water",
                "air",
                "mercury",
                "sulfur",
                "salt",
                "gold",
                "silver",
                "lead",
                "copper",
                "iron",
                "tin",
                "antimony",
                "academy",
                "lodge",
                "temple",
                "church",
                "monastery",
                "sanctuary",
            }
        )
        etype = entity.entity_type.value.lower()
        if etype in ("person", "place") and name_lower in _ABSTRACT_CONCEPTS:
            from src.main.models.enums import EntityType

            entity.entity_type = EntityType.CONCEPT

        # "Alchemist", "Master", "Apprentice" as Person → Concept (generic role, not specific person)
        _GENERIC_ROLES = frozenset(
            {
                "alchemist",
                "master",
                "apprentice",
                "adept",
                "seeker",
                "initiate",
                "philosopher",
                "sage",
                "mystic",
                "magician",
                "sorcerer",
                "wizard",
                "priest",
                "priestess",
                "prophet",
                "oracle",
                "shaman",
                "healer",
            }
        )
        if etype == "person" and name_lower in _GENERIC_ROLES:
            from src.main.models.enums import EntityType

            entity.entity_type = EntityType.CONCEPT

        filtered.append(entity)

    if removed_count > 0:
        logger.info("Entity quality filter removed %d/%d entities", removed_count, len(entities))

    return filtered


def deduplicate_cross_type_entities(entities: list["ExtractedEntity"]) -> list["ExtractedEntity"]:
    """
    Merge entities that have the same name but different types.

    When "Dionysos" appears as Person, Concept, AND Place, keep the one with the
    highest confidence. Preserves chunk_ids from all variants.
    """
    from collections import defaultdict

    # Group by canonical name
    name_groups = defaultdict(list)
    for entity in entities:
        canonical = " ".join(entity.name.strip().lower().split())
        name_groups[canonical].append(entity)

    result = []
    merged_count = 0

    for _canonical, group in name_groups.items():
        if len(group) == 1:
            result.append(group[0])
            continue

        # Check if they have different types
        types = {e.entity_type for e in group}
        if len(types) <= 1:
            # Same type — keep all (handled by per-type dedup)
            result.extend(group)
            continue

        # Different types — keep highest confidence, merge chunk_ids
        best = max(group, key=lambda e: e.confidence_score or 0.0)

        # Merge chunk_ids from all variants
        all_chunk_ids = []
        for e in group:
            if e.additional_properties and "chunk_ids" in e.additional_properties:
                for cid in e.additional_properties["chunk_ids"]:
                    if cid not in all_chunk_ids:
                        all_chunk_ids.append(cid)
        if all_chunk_ids and best.additional_properties:
            best.additional_properties["chunk_ids"] = all_chunk_ids

        result.append(best)
        merged_count += len(group) - 1

    if merged_count > 0:
        logger.info("Cross-type dedup merged %d entities (from %d to %d)", merged_count, len(entities), len(result))

    return result


def group_entities_by_type(entities: list["ExtractedEntity"]) -> dict["EntityType", list["ExtractedEntity"]]:
    """
    Group entities by their type for efficient processing.

    Args:
        entities: List of extracted entities

    Returns:
        Dictionary mapping entity types to lists of entities
    """
    from collections import defaultdict

    type_groups = defaultdict(list)

    for entity in entities:
        type_groups[entity.entity_type].append(entity)

    return dict(type_groups)


def merge_entities(entities: list["ExtractedEntity"]) -> "ExtractedEntity":
    """
    Merge multiple entities with the same name into a single entity.

    Args:
        entities: List of entities to merge

    Returns:
        Merged entity with combined information
    """
    if not entities:
        raise ValueError("Cannot merge empty list of entities")

    if len(entities) == 1:
        return entities[0]

    # Use the first entity as the base
    base_entity = entities[0]

    # Merge descriptions
    merged_description = merge_entity_descriptions(entities)

    # Calculate average confidence
    merged_confidence = calculate_entity_confidence(entities)

    # Create merged entity
    from src.main.models.similarity import ExtractedEntity

    merged_entity = ExtractedEntity(
        name=base_entity.name,
        entity_type=base_entity.entity_type,
        description=merged_description,
        confidence_score=merged_confidence,
        source_text=base_entity.source_text,
        position=base_entity.position,
    )

    # CRITICAL: Preserve chunk_ids from ALL merged entities (entity may appear in multiple chunks)
    merged_chunk_ids = []
    for entity in entities:
        if entity.additional_properties and "chunk_ids" in entity.additional_properties:
            chunk_ids = entity.additional_properties["chunk_ids"]
            # Ensure chunk_ids is a list
            if isinstance(chunk_ids, list):
                merged_chunk_ids.extend(chunk_ids)
            else:
                merged_chunk_ids.append(chunk_ids)

    # Remove duplicates while preserving order
    if merged_chunk_ids:
        seen = set()
        unique_chunk_ids = []
        for chunk_id in merged_chunk_ids:
            if chunk_id not in seen:
                seen.add(chunk_id)
                unique_chunk_ids.append(chunk_id)

        # Store in merged entity
        if merged_entity.additional_properties is None:
            merged_entity.additional_properties = {}
        # noinspection PyUnresolvedReferences
        merged_entity.additional_properties["chunk_ids"] = unique_chunk_ids

    return merged_entity


def enrich_entities_with_ids(entities: list["ExtractedEntity"]) -> list["ExtractedEntity"]:
    """
    Enrich entities with unique IDs and additional metadata.

    Args:
        entities: List of entities to enrich

    Returns:
        List of enriched entities with IDs
    """
    enriched = []

    for entity in entities:
        # Generate unique ID
        entity_id = generate_entity_id(entity.name, entity.entity_type.value)

        # Create enriched entity (assuming ExtractedEntity has an id field)
        enriched_entity = entity
        if hasattr(enriched_entity, "id"):
            enriched_entity.id = entity_id

        enriched.append(enriched_entity)

    return enriched


async def semantic_deduplicate_entities(entities: list["ExtractedEntity"], embeddings_model, threshold: float = 0.85) -> list["ExtractedEntity"]:
    """
    Deduplicate entities using semantic similarity with embeddings.

    Args:
        entities: List of entities to deduplicate
        embeddings_model: Model for generating embeddings
        threshold: Similarity threshold for deduplication

    Returns:
        Deduplicated list of entities
    """
    if len(entities) <= 1:
        return entities

    try:
        # Generate embeddings for entity names
        entity_texts = [entity.name for entity in entities]
        embeddings = await embeddings_model.aembed_documents(entity_texts)

        # Find similar entities using cosine similarity
        deduplicated = []
        used_indices = set()

        for i, entity in enumerate(entities):
            if i in used_indices:
                continue

            similar_entities = [entity]
            used_indices.add(i)

            # Find similar entities
            for j, other_entity in enumerate(entities[i + 1 :], i + 1):
                if j in used_indices:
                    continue

                similarity = cosine_similarity(embeddings[i], embeddings[j])
                if similarity >= threshold:
                    similar_entities.append(other_entity)
                    used_indices.add(j)

            # Merge similar entities
            if len(similar_entities) > 1:
                merged_entity = merge_entities(similar_entities)
                deduplicated.append(merged_entity)
            else:
                deduplicated.append(entity)

        return deduplicated

    except Exception as e:
        logger.warning("Semantic deduplication failed: %s, falling back to original entities", str(e))
        return entities
