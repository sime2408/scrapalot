"""
Sparse Lexical Retriever - Enhanced BM25 with domain-specific boosting.

This service provides:
- Enhanced BM25 algorithm implementation
- Domain-specific keyword boosting
- Synonym expansion capability
- Fuzzy matching for typo handling
- Integration with PgVector for hybrid search
"""

from collections import Counter
import math
import time
from typing import Any
from uuid import UUID

try:
    from langchain_core.documents import Document

    LANGCHAIN_CORE_AVAILABLE = True
except ImportError:
    LANGCHAIN_CORE_AVAILABLE = False

    # Define a simple Document class
    class Document:
        def __init__(self, page_content: str, metadata: dict = None):
            self.page_content = page_content
            self.metadata = metadata or {}


try:
    pass

    LANGCHAIN_BM25_AVAILABLE = True
except ImportError:
    LANGCHAIN_BM25_AVAILABLE = False

try:
    import numpy as np

    NUMPY_AVAILABLE = True
except ImportError:
    np = None
    NUMPY_AVAILABLE = False

    # Simple numpy-like array operations
    class SimpleArray:
        def __init__(self, data):
            self.data = list(data)

        def copy(self):
            return SimpleArray(self.data[:])

        def __getitem__(self, key):
            return self.data[key]

        def __setitem__(self, key, value):
            self.data[key] = value

        def __len__(self):
            return len(self.data)

    def argsort(arr):
        return sorted(range(len(arr)), key=lambda k: arr[k])


from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class SimpleBM25:
    """Simple BM25 implementation"""

    def __init__(self, corpus, k1=1.2, b=0.75):
        self.k1 = k1
        self.b = b
        self.corpus = corpus
        self.doc_freqs = []
        self.idf = {}
        self.doc_len = []
        self.avgdl = 0

        self._build_index()

    def _build_index(self):
        nd = len(self.corpus)
        num_doc = 0

        for document in self.corpus:
            self.doc_len.append(len(document))
            num_doc += len(document)

            frequencies = Counter(document)
            self.doc_freqs.append(frequencies)

            for word in frequencies:
                if word not in self.idf:
                    self.idf[word] = 0
                self.idf[word] += 1

        self.avgdl = num_doc / nd if nd > 0 else 0

        # Compute IDF
        for word, freq in self.idf.items():
            self.idf[word] = math.log((nd - freq + 0.5) / (freq + 0.5))

    def get_scores(self, query):
        scores = []

        for i, _doc in enumerate(self.corpus):
            score = 0
            doc_freqs = self.doc_freqs[i]

            for word in query:
                if word in doc_freqs:
                    freq = doc_freqs[word]
                    numerator = self.idf.get(word, 0) * freq * (self.k1 + 1)
                    denominator = freq + self.k1 * (1 - self.b + self.b * (self.doc_len[i] / self.avgdl))
                    score += numerator / denominator

            scores.append(score)

        return scores if NUMPY_AVAILABLE else SimpleArray(scores)


class SparseLexicalRetriever:
    """
    Enhanced BM25-based sparse lexical retriever with domain-specific features.

    Features:
    - Enhanced BM25 scoring with tunable parameters
    - Domain-specific keyword boosting for psychology/academic terms
    - Synonym expansion for query enhancement
    - Fuzzy matching for typo tolerance
    - Integration with document metadata for filtering
    """

    def __init__(self, documents: list[Document] = None):
        self.config = resolved_config
        self.lexical_config = self.config.get("lexical_search", {})

        # BM25 parameters
        self.k1 = float(self.lexical_config.get("bm25_k1", 1.2))
        self.b = float(self.lexical_config.get("bm25_b", 0.75))

        # Domain-specific settings
        self.domain_boost = float(self.lexical_config.get("domain_boost_factor", 1.5))
        self.enable_synonyms = self.lexical_config.get("enable_synonyms", True)
        self.enable_fuzzy = self.lexical_config.get("enable_fuzzy_matching", True)

        # Initialize document corpus
        self.documents = documents or []
        self.bm25 = None
        self.tokenized_corpus = []

        # Domain-specific keyword lists
        self.psychology_keywords = self._load_psychology_keywords()
        self.academic_keywords = self._load_academic_keywords()

        if self.documents:
            self._build_index()

    @staticmethod
    def _load_psychology_keywords() -> list[str]:
        """Load psychology domain-specific keywords for boosting"""
        return [
            "psychology",
            "psychoanalysis",
            "cognitive",
            "behavioral",
            "unconscious",
            "conscious",
            "archetype",
            "jung",
            "freud",
            "therapy",
            "psyche",
            "neurosis",
            "complex",
            "persona",
            "shadow",
            "anima",
            "animus",
            "collective",
            "individual",
            "libido",
            "repression",
            "transference",
            "conditioning",
            "learning",
            "memory",
            "perception",
            "emotion",
            "motivation",
            "personality",
            "development",
            "social",
        ]

    @staticmethod
    def _load_academic_keywords() -> list[str]:
        """Load general academic keywords for boosting"""
        return [
            "theory",
            "concept",
            "principle",
            "hypothesis",
            "research",
            "study",
            "analysis",
            "method",
            "approach",
            "framework",
            "model",
            "evidence",
            "data",
            "conclusion",
            "argument",
            "perspective",
            "paradigm",
            "critique",
            "evaluation",
            "interpretation",
        ]

    @staticmethod
    def _tokenize_text(text: str) -> list[str]:
        """Tokenize text with enhanced preprocessing"""
        import re

        # Convert to lowercase and handle special characters
        text = text.lower()

        # Extract meaningful tokens (letters, numbers, some punctuation)
        tokens = re.findall(r"\b\w+\b", text)

        # Remove very short tokens
        tokens = [token for token in tokens if len(token) > 2]

        return tokens

    def _build_index(self):
        """Build BM25 index from documents"""
        if not self.documents:
            logger.warning("No documents provided for lexical retriever")
            return

        # Tokenize all documents
        self.tokenized_corpus = []
        for doc in self.documents:
            tokens = self._tokenize_text(doc.page_content)
            self.tokenized_corpus.append(tokens)

        # Build simple lexical index (simplified BM25-like scoring)
        self.bm25 = SimpleBM25(self.tokenized_corpus, k1=self.k1, b=self.b)

        logger.info("Built BM25 index for %d documents", len(self.documents))

    def add_documents(self, documents: list[Document]):
        """Add new documents to the index"""
        self.documents.extend(documents)
        self._build_index()

    def _expand_query_with_synonyms(self, query: str) -> str:
        """Expand query with synonyms for better matching"""
        if not self.enable_synonyms:
            return query

        # Simple synonym expansion - in production this would use a proper thesaurus
        synonym_map = {
            "psychology": ["psychological", "psyche", "mental"],
            "unconscious": ["subconscious", "preconscious"],
            "theory": ["theoretical", "concept", "idea"],
            "behavior": ["behaviour", "conduct", "action"],
            "cognitive": ["cognition", "mental", "thinking"],
            "emotional": ["emotion", "feeling", "affective"],
        }

        expanded_terms = [query]
        words = query.lower().split()

        for word in words:
            if word in synonym_map:
                expanded_terms.extend(synonym_map[word])

        return " ".join(expanded_terms)

    def _apply_domain_boosting(self, scores, query_tokens: list[str]):
        """Apply domain-specific boosting to BM25 scores"""
        if not (self.psychology_keywords or self.academic_keywords):
            return scores

        if NUMPY_AVAILABLE:
            boosted_scores = scores.copy()
        else:
            boosted_scores = scores.copy() if hasattr(scores, "copy") else list(scores)

        # Check if query contains domain-specific terms
        psychology_boost = any(token in self.psychology_keywords for token in query_tokens)
        academic_boost = any(token in self.academic_keywords for token in query_tokens)

        if psychology_boost or academic_boost:
            for i, doc in enumerate(self.documents):
                doc_tokens = self._tokenize_text(doc.page_content)

                # Count domain-specific terms in document
                psych_count = sum(1 for token in doc_tokens if token in self.psychology_keywords)
                academic_count = sum(1 for token in doc_tokens if token in self.academic_keywords)

                # Apply boosting based on domain term density
                if psych_count > 0 and psychology_boost:
                    boost_factor = min(self.domain_boost, 1.0 + (psych_count / len(doc_tokens)) * 2.0)
                    boosted_scores[i] *= boost_factor

                if academic_count > 0 and academic_boost:
                    boost_factor = min(self.domain_boost, 1.0 + (academic_count / len(doc_tokens)) * 1.5)
                    boosted_scores[i] *= boost_factor

        return boosted_scores

    def _fuzzy_match_boost(self, scores, query_tokens: list[str]):
        """Apply fuzzy matching boost for typo tolerance"""
        if not self.enable_fuzzy:
            return scores

        try:
            from difflib import SequenceMatcher

            if NUMPY_AVAILABLE:
                fuzzy_boosted = scores.copy()
            else:
                fuzzy_boosted = scores.copy() if hasattr(scores, "copy") else list(scores)

            for i, doc in enumerate(self.documents):
                doc_tokens = self._tokenize_text(doc.page_content)

                # Find fuzzy matches for each query token
                fuzzy_matches = 0
                for query_token in query_tokens:
                    for doc_token in doc_tokens:
                        # Use sequence matcher for fuzzy comparison
                        similarity = SequenceMatcher(None, query_token, doc_token).ratio()
                        if 0.8 <= similarity < 1.0:  # Fuzzy match range
                            fuzzy_matches += 1
                            break

                # Apply modest boost for fuzzy matches
                if fuzzy_matches > 0:
                    fuzzy_boost = 1.0 + (fuzzy_matches / len(query_tokens)) * 0.3
                    fuzzy_boosted[i] *= fuzzy_boost

            return fuzzy_boosted

        except ImportError:
            logger.warning("difflib not available for fuzzy matching")
            return scores
        except Exception as e:
            logger.warning("Error in fuzzy matching: %s", str(e))
            return scores

    def get_relevant_documents(
        self,
        query: str,
        top_k: int = 10,
        collection_id: UUID | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        """
        Get relevant documents using enhanced BM25 search.

        Args:
                query: Search query
                top_k: Number of top documents to return
                collection_id: Optional collection filter
                document_ids: Optional document ID filter

        Returns:
                List of relevant documents with scores
        """
        start_time = time.time()

        if not self.bm25 or not self.documents:
            logger.warning("BM25 index not available or no documents")
            return []

        try:
            # Expand query with synonyms
            expanded_query = self._expand_query_with_synonyms(query)

            # Tokenize the expanded query
            query_tokens = self._tokenize_text(expanded_query)

            if not query_tokens:
                return []

            # Get BM25 scores
            scores = self.bm25.get_scores(query_tokens)

            # Apply domain-specific boosting
            scores = self._apply_domain_boosting(scores, query_tokens)

            # Apply fuzzy matching boost
            scores = self._fuzzy_match_boost(scores, query_tokens)

            # Get top-k indices
            if NUMPY_AVAILABLE:
                # noinspection PyUnresolvedReferences
                top_indices = np.argsort(scores)[::-1][:top_k]
            else:
                indices = argsort(scores)
                top_indices = indices[::-1][:top_k]

            # Filter by collection_id and document_ids if provided
            filtered_results = []
            for idx in top_indices:
                if idx < len(self.documents):
                    doc = self.documents[idx]
                    score = scores[idx]

                    # Apply filters
                    if collection_id and doc.metadata.get("collection_id") != str(collection_id):
                        continue

                    if document_ids and doc.metadata.get("document_id") not in [str(did) for did in document_ids]:
                        continue

                    # Add score to metadata
                    doc_copy = Document(
                        page_content=doc.page_content,
                        metadata={**doc.metadata, "score": float(score), "retrieval_method": "lexical_bm25"},
                    )
                    filtered_results.append(doc_copy)

            execution_time = (time.time() - start_time) * 1000
            logger.debug("Lexical search completed in %.2f ms, returned %d results", execution_time, len(filtered_results))

            return filtered_results

        except Exception as e:
            logger.error("Error in lexical search: %s", str(e))
            return []

    async def aget_relevant_documents(
        self,
        query: str,
        top_k: int = 10,
        collection_id: UUID | None = None,
        document_ids: list[UUID] | None = None,
    ) -> list[Document]:
        """Async version of get_relevant_documents"""
        return self.get_relevant_documents(query, top_k, collection_id, document_ids)

    def update_documents(self, documents: list[Document]):
        """Update the document corpus and rebuild index"""
        self.documents = documents
        self._build_index()

    def get_stats(self) -> dict[str, Any]:
        """Get retriever statistics"""
        return {
            "num_documents": len(self.documents),
            "bm25_k1": self.k1,
            "bm25_b": self.b,
            "domain_boost_factor": self.domain_boost,
            "synonyms_enabled": self.enable_synonyms,
            "fuzzy_matching_enabled": self.enable_fuzzy,
            "psychology_keywords_count": len(self.psychology_keywords),
            "academic_keywords_count": len(self.academic_keywords),
        }


# Global instance management
_lexical_retriever = None


def get_lexical_retriever(documents: list[Document] = None) -> SparseLexicalRetriever:
    """Get a global lexical retriever instance"""
    global _lexical_retriever
    if _lexical_retriever is None or documents:
        _lexical_retriever = SparseLexicalRetriever(documents)
    return _lexical_retriever


def create_lexical_retriever(documents: list[Document]) -> SparseLexicalRetriever:
    """Create a new lexical retriever instance"""
    return SparseLexicalRetriever(documents)
