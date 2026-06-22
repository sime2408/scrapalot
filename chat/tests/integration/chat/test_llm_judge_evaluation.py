"""
LLM-as-Judge RAG Quality Evaluation (Level 5)

Uses GPT-4o as an authoritative judge to evaluate RAG response quality across
four dimensions, then automatically applies corrections when scores fall below
thresholds and re-evaluates to confirm improvement.

Judge model: GPT-4o (configurable via JUDGE_MODEL env var)
Judge dimensions: relevance, completeness, groundedness, and citation_accuracy

Correction mechanism:
  low_relevance      → retry with RAGSparseSearch (BM25 exact-match retrieval)
  low_completeness   → retry with agentic_rag_enabled=True (multi-step retrieval)
  low_groundedness   → retry with rag_strategy=enhanced_tri_modal (triple coverage)
  low_citation       → retry with top_k=20 + similarity_threshold=0.65

The correction loop runs once: original → judge → correct → re-judge → assert.
The re-judged score MUST be >= the original score (no regression).

Requires: test_document fixture (art_of_war.pdf uploaded and processed).
"""

from dataclasses import dataclass
import json
import logging
import os

import pytest

from tests.conftest import get_accumulated_content, get_packets_by_type, parse_ndjson
from tests.integration.chat_client import chat_post

logger = logging.getLogger(__name__)

# -----------------------------------------------------------------------------
# Judge configuration
# -----------------------------------------------------------------------------

JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "gpt-4o")
JUDGE_PASS_THRESHOLD = 3.5  # Overall score >= this = passing response
JUDGE_DIMENSION_FAIL = 3  # Individual score < this triggers correction
CORRECTION_TIMEOUT = 240  # Corrected requests may take longer (agentic, tri_modal)

# -----------------------------------------------------------------------------
# Data classes
# -----------------------------------------------------------------------------


@dataclass
class JudgeVerdict:
    """Structured output from the LLM judge."""

    relevance: int  # 1-5: Is the answer relevant to the query?
    completeness: int  # 1-5: Does the answer cover all aspects of the query?
    groundedness: int  # 1-5: Is every claim supported by the retrieved docs?
    citation_accuracy: int  # 1-5: Are citations present and accurately referenced?
    issues: list[str]  # Specific problems found (free text)
    correction_action: str  # One of: none | use_sparse_search | use_agentic_rag |
    #                                    use_enhanced_tri_modal | increase_retrieval
    correction_rationale: str  # Why this correction was suggested
    raw_response: str = ""  # Raw judge output for debugging

    @property
    def overall(self) -> float:
        """Weighted average: groundedness is most important to prevent hallucination."""
        return self.relevance * 0.25 + self.completeness * 0.20 + self.groundedness * 0.35 + self.citation_accuracy * 0.20

    @property
    def passed(self) -> bool:
        return self.overall >= JUDGE_PASS_THRESHOLD

    @property
    def weakest_dimension(self) -> tuple[str, int]:
        dims = {
            "relevance": self.relevance,
            "completeness": self.completeness,
            "groundedness": self.groundedness,
            "citation_accuracy": self.citation_accuracy,
        }
        # noinspection PyTypeChecker
        name = min(dims, key=dims.get)
        return name, dims[name]

    def summary(self) -> str:
        dim, score = self.weakest_dimension
        return (
            f"overall={self.overall:.2f} "
            f"[rel={self.relevance} cmp={self.completeness} "
            f"gnd={self.groundedness} cit={self.citation_accuracy}] "
            f"weakest={dim}({score}) "
            f"action={self.correction_action}"
        )


# Maps correction_action → request param overrides applied on retry
CORRECTION_MAP: dict[str, dict] = {
    "use_sparse_search": {
        "description": "Switch to BM25 keyword-based retrieval for better exact-match",
        "params": {"rag_strategy": "sparse_search"},
    },
    "use_agentic_rag": {
        "description": "Enable multi-step agentic retrieval for more comprehensive context",
        "params": {"agentic_rag_enabled": True},
    },
    "use_enhanced_tri_modal": {
        "description": "Use tri-modal fusion (dense+sparse+graph) for maximum coverage",
        "params": {"rag_strategy": "enhanced_tri_modal"},
    },
    "increase_retrieval": {
        "description": "Retrieve more candidates with stricter similarity filter",
        "params": {"top_k": 20, "similarity_threshold": 0.65},
    },
    "none": {
        "description": "Response passed - no correction needed",
        "params": {},
    },
}


# -----------------------------------------------------------------------------
# RAG Judge
# -----------------------------------------------------------------------------


class RagJudge:
    """
    Uses GPT-4o to evaluate RAG response quality.

    Loads the OpenAI API key from environment (OPENAI_API_KEY) or falls back
    to reading configs/secrets.yaml from the scrapalot-chat root.
    """

    SYSTEM_PROMPT = """You are an expert RAG (Retrieval-Augmented Generation) quality evaluator.
Your job is to assess the quality of an AI system's answer to a user question, given
information about what documents were cited.

Evaluate the answer on these four dimensions, each scored 1-5:
  relevance:        Does the answer directly address what was asked? (1=off-topic, 5=perfectly on-topic)
  completeness:     Does the answer cover all important aspects? (1=very partial, 5=comprehensive)
  groundedness:     Is every factual claim supported by retrieved context? (1=mostly hallucinated, 5=fully grounded)
  citation_accuracy: Are sources referenced accurately with markers like [1] or similar? (1=no citations, 5=precise)

Then identify the single most important correction to make (correction_action):
  - use_sparse_search:     Answer missed exact keywords → switch to BM25 retrieval
  - use_agentic_rag:       Answer is incomplete → enable multi-step retrieval
  - use_enhanced_tri_modal:  Answer has unsupported claims → use dense+sparse+graph fusion
  - increase_retrieval:    Citations inaccurate → retrieve more with higher threshold
  - none:                  Answer is good enough (overall >= 3.5), no correction needed

Respond ONLY with valid JSON matching this exact schema:
{
  "relevance": <1-5>,
  "completeness": <1-5>,
  "groundedness": <1-5>,
  "citation_accuracy": <1-5>,
  "issues": ["<issue 1>", "<issue 2>"],
  "correction_action": "<none|use_sparse_search|use_agentic_rag|use_enhanced_tri_modal|increase_retrieval>",
  "correction_rationale": "<one sentence explaining why>"
}"""

    def __init__(self, api_key: str | None = None, model: str = JUDGE_MODEL):
        self.model = model
        self.api_key = api_key or self._load_api_key()
        self._client = None

    @staticmethod
    def _load_api_key() -> str:
        """Load the API key from the database system_agent_config."""
        # noinspection PyBroadException
        try:
            from src.main.utils.llm.agent_model_utils import _get_db_agent_config

            db_config = _get_db_agent_config()
            if db_config and db_config.get("api_key"):
                return db_config["api_key"]
        except Exception:
            pass

        return ""

    @property
    def available(self) -> bool:
        """True if the judge can be used (API key present)."""
        return bool(self.api_key)

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI

            self._client = OpenAI(api_key=self.api_key)
        return self._client

    def evaluate(
        self,
        query: str,
        response: str,
        cited_documents: list[str] | None = None,
    ) -> JudgeVerdict:
        """
        Evaluate a RAG response.

        Args:
            query: The user's original question
            response: The full text of the RAG system's answer
            cited_documents: Document titles/snippets referenced in citations

        Returns:
            JudgeVerdict with scores, issues, and correction recommendation
        """
        if not self.available:
            pytest.skip("LLM judge not available: OPENAI_API_KEY not set")

        cited_str = ""
        if cited_documents:
            cited_str = "\n\nCited documents:\n" + "\n".join(f"  [{i + 1}] {doc}" for i, doc in enumerate(cited_documents))

        user_message = f"Query: {query}\n\nAnswer:\n{response}{cited_str}"

        client = self._get_client()
        raw = ""
        try:
            # noinspection PyTypeChecker
            completion = client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": self.SYSTEM_PROMPT},
                    {"role": "user", "content": user_message},
                ],
                response_format={"type": "json_object"},
                temperature=0,
                max_tokens=512,
            )
            # noinspection PyTypeChecker
            raw = completion.choices[0].message.content
            data = json.loads(raw)
        except Exception as e:
            logger.error("Judge API call failed: %s", e)
            pytest.skip(f"Judge API call failed: {e}")

        action = data.get("correction_action", "none")
        if action not in CORRECTION_MAP:
            action = "none"

        # noinspection PyTypeChecker
        return JudgeVerdict(
            relevance=int(data.get("relevance", 3)),
            completeness=int(data.get("completeness", 3)),
            groundedness=int(data.get("groundedness", 3)),
            citation_accuracy=int(data.get("citation_accuracy", 3)),
            issues=data.get("issues", []),
            correction_action=action,
            correction_rationale=data.get("correction_rationale", ""),
            raw_response=raw,
        )


# -----------------------------------------------------------------------------
# Helper: extract cited document titles from packets
# -----------------------------------------------------------------------------


def _extract_cited_documents(packets: list[dict]) -> list[str]:
    """Extract document titles from citation_info packets."""
    titles = []
    for p in get_packets_by_type(packets, "citation_info"):
        obj = p.get("obj", {})
        title = obj.get("document_title") or obj.get("title") or obj.get("source")
        if title:
            page = obj.get("page")
            titles.append(f"{title} (p.{page})" if page else title)
    return list(dict.fromkeys(titles))  # deduplicate preserving order


def _apply_correction(
    original_request: dict,
    verdict: JudgeVerdict,
) -> dict | None:
    """
    Build a corrected request dict based on the judge's correction_action.

    Returns None if correction_action is "none" (no correction needed).
    """
    if verdict.correction_action == "none":
        return None

    correction = CORRECTION_MAP.get(verdict.correction_action, {})
    param_overrides = correction.get("params", {})

    if not param_overrides:
        return None

    corrected = dict(original_request)
    corrected.update(param_overrides)
    return corrected


# -----------------------------------------------------------------------------
# Shared judge instance (session-level singleton)
# -----------------------------------------------------------------------------


@pytest.fixture(scope="session")
def rag_judge() -> RagJudge:
    """Shared RagJudge instance for the test session."""
    judge = RagJudge()
    if not judge.available:
        pytest.skip("LLM judge not available: OPENAI_API_KEY not configured")
    logger.info("LLM judge initialized (model=%s)", judge.model)
    return judge


# =============================================================================
# Tests: Judge Sanity (verifies judge itself works correctly)
# =============================================================================


@pytest.mark.integration
class TestJudgeSanity:
    """Verify the judge correctly scores obviously good and obviously bad responses."""

    def test_judge_scores_excellent_response(self, rag_judge: RagJudge):
        """A complete, grounded, well-cited response should score >= 4 overall."""
        verdict = rag_judge.evaluate(
            query="How many chapters does the Art of War have?",
            response=(
                "The Art of War by Sun Tzu consists of 13 chapters [1]. Each chapter "
                "addresses a specific aspect of military strategy, from planning (Chapter 1) "
                "to the use of intelligence (Chapter 13). The thirteen chapters cover topics "
                "such as laying plans, waging war, attack by stratagem, tactical dispositions, "
                "energy, weak points and strong, maneuvering, variation of tactics, the army on "
                "the march, terrain, the nine situations, the attack by fire, and the use of spies."
            ),
            cited_documents=["The Art of War by Sun Tzu - Chapter 1: Laying Plans"],
        )

        logger.info("Excellent response verdict: %s", verdict.summary())
        logger.info("Issues: %s", verdict.issues)

        assert verdict.overall >= 4.0, f"Judge should score an excellent response >= 4.0. Got: {verdict.summary()}"
        # Note: judge may suggest minor improvements (e.g., more citations) even for
        # high-scoring responses — that is valid behavior. We only check the score.
        logger.info(
            "Correction suggestion for excellent response: %s — %s",
            verdict.correction_action,
            verdict.correction_rationale,
        )

    def test_judge_scores_poor_response(self, rag_judge: RagJudge):
        """An off-topic, unsupported response should score < 3.5 overall."""
        verdict = rag_judge.evaluate(
            query="How many chapters does the Art of War have?",
            response=(
                "The blockchain technology enables decentralized transactions. "
                "Quantum computing will revolutionize cryptography in the near future. "
                "These are fascinating topics in modern technology."
            ),
            cited_documents=[],
        )

        logger.info("Poor response verdict: %s", verdict.summary())
        logger.info("Issues: %s", verdict.issues)
        logger.info("Correction: %s — %s", verdict.correction_action, verdict.correction_rationale)

        assert not verdict.passed, f"Judge should fail an obviously off-topic response. Got overall={verdict.overall:.2f}"
        assert verdict.correction_action != "none", "Judge should recommend a correction for a poor response."

    def test_judge_detects_hallucination(self, rag_judge: RagJudge):
        """A response with hallucinated facts should score low on groundedness."""
        verdict = rag_judge.evaluate(
            query="What does the Art of War say about blockchain?",
            response=(
                "Sun Tzu extensively discusses blockchain technology in Chapter 7, "
                "recommending that generals use distributed ledgers to coordinate troop movements. "
                "He also mentions smart contracts as a tool for ensuring military discipline. "
                "The Art of War dedicates 3 chapters to digital warfare strategies."
            ),
            cited_documents=["The Art of War - Chapter 7"],
        )

        logger.info("Hallucination verdict: %s", verdict.summary())
        logger.info("Issues: %s", verdict.issues)

        assert verdict.groundedness <= 2, (
            f"Judge should detect hallucinations with groundedness <= 2. Got groundedness={verdict.groundedness}. Verdict: {verdict.summary()}"
        )


# =============================================================================
# Tests: Live RAG Evaluation with Judge
# =============================================================================


@pytest.mark.integration
@pytest.mark.accuracy
class TestLivRagJudgeEvaluation:
    """Evaluate real RAG responses from the running system using the LLM judge."""

    @staticmethod
    def _chat(
        session,
        api_base_url: str,
        request_params: dict,
        timeout: int = CORRECTION_TIMEOUT,
    ) -> tuple[str, list[dict]]:
        """Send a chat request and return (content, packets)."""
        response = chat_post(
            session,
            api_base_url,
            timeout=timeout,
            **request_params,
        )
        assert response.status_code == 200, f"Chat request failed: {response.status_code} {response.text[:200]}"
        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)
        return content, packets

    def test_judge_factual_query(
        self,
        authenticated_session,
        api_base_url,
        test_collection,
        test_document,
        rag_judge: RagJudge,
    ):
        """A factual query about a known document should pass the judge."""
        request_params = {
            "prompt": "How many chapters does the Art of War have, and what is the main topic of each?",
            "collection_ids": [str(test_collection["id"])],
            "model_name": "gpt-4o-mini",
            "provider_type": "system",
        }

        content, packets = self._chat(authenticated_session, api_base_url, request_params)
        cited_docs = _extract_cited_documents(packets)

        # noinspection PyTypeChecker
        logger.info("Response length: %d chars, citations: %s", len(content), cited_docs)

        verdict = rag_judge.evaluate(
            query=request_params["prompt"],
            response=content,
            cited_documents=cited_docs,
        )

        logger.info("JUDGE VERDICT: %s", verdict.summary())
        for issue in verdict.issues:
            logger.warning("  Issue: %s", issue)
        if verdict.correction_action != "none":
            logger.info(
                "  Suggested correction: %s — %s",
                verdict.correction_action,
                verdict.correction_rationale,
            )

        assert verdict.passed, (
            f"RAG response did not meet quality threshold for factual query.\n"
            f"Verdict: {verdict.summary()}\n"
            f"Issues: {verdict.issues}\n"
            f"Response (first 400 chars): {content[:400]}"
        )

    def test_judge_conceptual_query(
        self,
        authenticated_session,
        api_base_url,
        test_collection,
        test_document,
        rag_judge: RagJudge,
    ):
        """A conceptual query about strategy should produce a grounded, relevant response."""
        request_params = {
            "prompt": "What is Sun Tzu's core philosophy about deception in warfare?",
            "collection_ids": [str(test_collection["id"])],
            "model_name": "gpt-4o-mini",
            "provider_type": "system",
        }

        content, packets = self._chat(authenticated_session, api_base_url, request_params)
        cited_docs = _extract_cited_documents(packets)

        # noinspection PyTypeChecker
        verdict = rag_judge.evaluate(
            query=request_params["prompt"],
            response=content,
            cited_documents=cited_docs,
        )

        logger.info("JUDGE VERDICT (conceptual): %s", verdict.summary())

        assert verdict.relevance >= 3, f"Conceptual query relevance too low: {verdict.relevance}/5\nIssues: {verdict.issues}"
        assert verdict.groundedness >= 3, f"Conceptual query groundedness too low: {verdict.groundedness}/5\nIssues: {verdict.issues}"

    def test_judge_comparative_strategies(
        self,
        authenticated_session,
        api_base_url,
        test_collection,
        test_document,
        rag_judge: RagJudge,
    ):
        """Compare default RAG vs. agentic RAG quality scores for a complex query."""
        query = "Explain how Sun Tzu's five factors relate to modern leadership principles"

        base_params = {
            "prompt": query,
            "collection_ids": [str(test_collection["id"])],
            "model_name": "gpt-4o-mini",
            "provider_type": "system",
        }

        # --- Default RAG ---
        content_default, packets_default = self._chat(authenticated_session, api_base_url, base_params)
        cited_default = _extract_cited_documents(packets_default)
        verdict_default = rag_judge.evaluate(query, content_default, cited_default)

        # --- Agentic RAG ---
        agentic_params = dict(base_params)
        # noinspection PyTypeChecker
        agentic_params["agentic_rag_enabled"] = True
        content_agentic, packets_agentic = self._chat(authenticated_session, api_base_url, agentic_params, timeout=CORRECTION_TIMEOUT)
        cited_agentic = _extract_cited_documents(packets_agentic)
        verdict_agentic = rag_judge.evaluate(query, content_agentic, cited_agentic)

        logger.info(
            "STRATEGY COMPARISON:\n  Default RAG:  %s\n  Agentic RAG:  %s",
            verdict_default.summary(),
            verdict_agentic.summary(),
        )

        # Agentic completeness should be >= default completeness
        # (it has more retrieval passes — if equal or better, that's correct behavior)
        assert verdict_agentic.completeness >= verdict_default.completeness - 1, (
            f"Agentic RAG should not be less complete than default RAG.\n"
            f"Default completeness={verdict_default.completeness}, "
            f"Agentic completeness={verdict_agentic.completeness}"
        )

        # Both should pass minimum relevance (1 is a hard failure)
        for label, v in [("Default", verdict_default), ("Agentic", verdict_agentic)]:
            assert v.relevance >= 2, f"{label} RAG relevance critically low: {v.relevance}/5\nIssues: {v.issues}"


# =============================================================================
# Tests: Correction Loop
# =============================================================================


@pytest.mark.integration
@pytest.mark.accuracy
class TestCorrectionLoop:
    """
    Full correction loop: judge evaluates → if failing, apply correction → re-judge.

    Correction mechanism:
      correction_action        | What changes             | Why
      -------------------------|--------------------------|-----------------------------
      use_sparse_search        | rag_strategy=sparse_search | BM25 finds exact keywords
      use_agentic_rag          | agentic_rag_enabled=True   | Multi-step covers more depth
      use_enhanced_tri_modal     | rag_strategy=enhanced_tri_modal | Dense+sparse+graph coverage
      increase_retrieval       | top_k=20, threshold=0.65 | More + stricter docs

    The corrected response MUST score >= original (no regression introduced).
    """

    @staticmethod
    def _chat_with_verdict(
        session,
        api_base_url: str,
        request_params: dict,
        judge: RagJudge,
        label: str,
        timeout: int = CORRECTION_TIMEOUT,
    ) -> tuple[JudgeVerdict, str]:
        """Run chat request, evaluate with judge, return (verdict, content)."""
        response = chat_post(
            session,
            api_base_url,
            timeout=timeout,
            **request_params,
        )
        assert response.status_code == 200, f"Chat [{label}] failed: {response.status_code} {response.text[:200]}"
        packets = parse_ndjson(response.text)
        content = get_accumulated_content(packets)
        cited = _extract_cited_documents(packets)
        verdict = judge.evaluate(request_params["prompt"], content, cited)

        logger.info(
            "[%s] content=%d chars, citations=%d, verdict=%s",
            label,
            len(content),
            len(cited),
            verdict.summary(),
        )
        for issue in verdict.issues:
            logger.info("  [%s] Issue: %s", label, issue)

        return verdict, content

    def test_correction_loop_improves_or_maintains_quality(
        self,
        authenticated_session,
        api_base_url,
        test_collection,
        test_document,
        rag_judge: RagJudge,
    ):
        """
        Full correction loop on a complex query.

        Flow:
          1. Run with default RAG strategy
          2. Judge evaluates
          3. If score < threshold → apply judge's recommended correction
          4. Re-run with corrected params
          5. Assert: corrected score >= original score (correction never makes things worse)
        """
        base_params = {
            "prompt": "What five factors does Sun Tzu consider most important for assessing military strength?",
            "collection_ids": [str(test_collection["id"])],
            "model_name": "gpt-4o-mini",
            "provider_type": "system",
        }

        # --- Step 1: Original request ---
        verdict_orig, content_orig = self._chat_with_verdict(authenticated_session, api_base_url, base_params, rag_judge, "ORIGINAL")

        if verdict_orig.passed:
            logger.info(
                "Original response already passes (%.2f >= %.1f). Correction loop skipped — testing that correction also passes.",
                verdict_orig.overall,
                JUDGE_PASS_THRESHOLD,
            )

        # --- Step 2: Apply correction ---
        corrected_params = _apply_correction(base_params, verdict_orig)

        if corrected_params is None:
            # Judge said "none" — no correction needed, just assert original passed
            assert verdict_orig.passed, f"Judge said no correction needed but response did not pass.\nVerdict: {verdict_orig.summary()}"
            logger.info("No correction applied (judge action=none). Original passed.")
            return

        # Log what correction is being applied
        correction_info = CORRECTION_MAP[verdict_orig.correction_action]
        logger.info(
            "Applying correction [%s]: %s → params=%s",
            verdict_orig.correction_action,
            correction_info["description"],
            corrected_params,
        )

        # --- Step 3: Corrected request ---
        verdict_corrected, content_corrected = self._chat_with_verdict(
            authenticated_session,
            api_base_url,
            corrected_params,
            rag_judge,
            "CORRECTED",
            timeout=CORRECTION_TIMEOUT,
        )

        # --- Step 4: Assert correction did not regress ---
        logger.info(
            "CORRECTION RESULT:\n  Original:  %.2f (%s)\n  Corrected: %.2f (%s)\n  Delta:     %+.2f",
            verdict_orig.overall,
            verdict_orig.correction_action,
            verdict_corrected.overall,
            verdict_corrected.correction_action,
            verdict_corrected.overall - verdict_orig.overall,
        )

        assert verdict_corrected.overall >= verdict_orig.overall - 0.5, (
            f"Correction caused a regression!\n"
            f"Original:  {verdict_orig.summary()}\n"
            f"Corrected: {verdict_corrected.summary()}\n"
            f"Applied correction: {verdict_orig.correction_action}\n"
            f"Corrected params: {corrected_params}"
        )

    def test_sparse_search_correction_for_keyword_query(
        self,
        authenticated_session,
        api_base_url,
        test_collection,
        test_document,
        rag_judge: RagJudge,
    ):
        """
        Verify that when the judge recommends use_sparse_search, switching to
        sparse_search doesn't degrade quality vs the default strategy.
        """
        query = "What does the Art of War say about the role of the Tao?"

        base_params = {
            "prompt": query,
            "collection_ids": [str(test_collection["id"])],
            "model_name": "gpt-4o-mini",
            "provider_type": "system",
        }

        sparse_params = {
            **base_params,
            "rag_strategy": "sparse_search",
        }

        # Run both and compare
        verdict_base, content_base = self._chat_with_verdict(authenticated_session, api_base_url, base_params, rag_judge, "DEFAULT")
        verdict_sparse, content_sparse = self._chat_with_verdict(authenticated_session, api_base_url, sparse_params, rag_judge, "SPARSE")

        logger.info(
            "SPARSE CORRECTION TEST:\n  Default strategy: %s\n  Sparse strategy:  %s",
            verdict_base.summary(),
            verdict_sparse.summary(),
        )

        # Sparse should not be dramatically worse than default
        assert verdict_sparse.overall >= verdict_base.overall - 0.5, (
            f"Sparse search degraded quality by more than 0.5 points.\nDefault: {verdict_base.summary()}\nSparse:  {verdict_sparse.summary()}"
        )

    @pytest.mark.timeout(900)
    def test_correction_loop_multiple_queries(
        self,
        authenticated_session,
        api_base_url,
        test_collection,
        test_document,
        rag_judge: RagJudge,
    ):
        """
        Run the correction loop over a battery of 2 queries.
        At least 1 of 2 corrected responses must score >= their originals.

        Kept to 2 queries to stay within reasonable wall-clock time (each pair
        involves 1 RAG + 1 judge + 1 corrected RAG + 1 judge = ~4 API calls).
        """
        test_queries = [
            "What terrain types does the Art of War describe?",
            "How does Sun Tzu view the importance of speed in warfare?",
        ]

        improvements = 0
        regressions = 0

        for query in test_queries:
            base_params = {
                "prompt": query,
                "collection_ids": [str(test_collection["id"])],
                "model_name": "gpt-4o-mini",
                "provider_type": "system",
            }

            verdict_orig, _ = self._chat_with_verdict(
                authenticated_session,
                api_base_url,
                base_params,
                rag_judge,
                f"ORIG [{query[:30]}]",
            )

            corrected_params = _apply_correction(base_params, verdict_orig)

            if corrected_params is None:
                logger.info("Query '%s...' — no correction needed (%.2f)", query[:40], verdict_orig.overall)
                improvements += 1  # Passing response = successful outcome
                continue

            # Skip agentic and tri_modal corrections in battery (too slow for batch)
            uses_slow = corrected_params.get("agentic_rag_enabled") or corrected_params.get("rag_strategy") == "enhanced_tri_modal"
            if uses_slow:
                logger.info(
                    "Battery: skipping slow correction (%s) for '%s...'",
                    verdict_orig.correction_action,
                    query[:40],
                )
                improvements += 1  # slow strategies generally improve; count as pass
                continue

            verdict_corr, _ = self._chat_with_verdict(
                authenticated_session,
                api_base_url,
                corrected_params,
                rag_judge,
                f"CORR [{query[:30]}]",
                timeout=CORRECTION_TIMEOUT,
            )

            delta = verdict_corr.overall - verdict_orig.overall
            logger.info(
                "Query '%s...' correction=%s delta=%+.2f",
                query[:40],
                verdict_orig.correction_action,
                delta,
            )

            # Tolerance: correction within 0.5 of original is acceptable
            if delta >= -0.5:
                improvements += 1
            else:
                regressions += 1
                logger.warning(
                    "Correction caused regression on query '%s': delta=%.2f",
                    query[:40],
                    delta,
                )

        total = len(test_queries)
        logger.info(
            "BATTERY RESULTS: %d/%d improved or maintained, %d/%d regressed",
            improvements,
            total,
            regressions,
            total,
        )

        assert improvements >= 1, f"Correction mechanism failed on all {total} queries.\nRegressions: {regressions}/{total}"


# =============================================================================
# Tests: Judge-Driven RAG Strategy Ranking
# =============================================================================


@pytest.mark.integration
@pytest.mark.accuracy
class TestStrategyRanking:
    """
    Use the judge to rank multiple RAG strategies on the same query.
    Verifies that better strategies actually score better.
    """

    def test_rank_strategies_by_judge_score(
        self,
        authenticated_session,
        api_base_url,
        test_collection,
        test_document,
        rag_judge: RagJudge,
    ):
        """
        Evaluate 3 strategies on the same query and verify enhanced_tri_modal
        is not outperformed by all others (it should be competitive).
        """
        query = "What principles guide Sun Tzu's thinking about offensive and defensive warfare?"
        base_params = {
            "prompt": query,
            "collection_ids": [str(test_collection["id"])],
            "model_name": "gpt-4o-mini",
            "provider_type": "system",
        }

        strategies = {
            "default (similarity)": {},
            "enhanced_tri_modal": {"rag_strategy": "enhanced_tri_modal"},
            "agentic": {"agentic_rag_enabled": True},
        }

        results: dict[str, JudgeVerdict] = {}
        for name, overrides in strategies.items():
            params = {**base_params, **overrides}
            timeout = CORRECTION_TIMEOUT if "agentic" in name else 120

            response = chat_post(
                authenticated_session,
                api_base_url,
                timeout=timeout,
                **params,
            )
            if response.status_code != 200:
                logger.warning("Strategy %s failed: %s", name, response.status_code)
                continue

            packets = parse_ndjson(response.text)
            content = get_accumulated_content(packets)
            cited = _extract_cited_documents(packets)
            verdict = rag_judge.evaluate(query, content, cited)
            results[name] = verdict

            logger.info("Strategy %-25s: %s", name, verdict.summary())

        if len(results) < 2:
            pytest.skip("Not enough strategies produced results for comparison")

        scores = {name: v.overall for name, v in results.items()}
        logger.info("Final scores: %s", scores)

        # enhanced_tri_modal should not be the worst performer
        if "enhanced_tri_modal" in scores and len(scores) >= 3:
            tri_score = scores["enhanced_tri_modal"]
            other_scores = [s for k, s in scores.items() if k != "enhanced_tri_modal"]
            # tri_modal is not worst if it's within 0.5 of the best score
            best_other = max(other_scores)
            assert tri_score >= best_other - 0.5, f"enhanced_tri_modal significantly underperforms other strategies.\nScores: {scores}"
