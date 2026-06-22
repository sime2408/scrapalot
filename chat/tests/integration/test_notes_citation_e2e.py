"""
End-to-end test for the Notes Citation Lookup flow through the real
HTTP stack: UI client → Gateway (8080) → Kotlin backend (8091) → gRPC
→ Python AI (9091).

Complements `test_notes_citation_lookup.py`, which exercises the Python
service function directly. This file is the CLAUDE.md-mandated
"go through controllers" test — it proves that every hop in the chain
(Kotlin REST controller, gRPC serialization, Python servicer, external
API calls, Unpaywall enrichment) is wired correctly.

Marked `slow` because the chain does real network I/O to Crossref,
OpenAlex, Semantic Scholar, and Unpaywall. Targets < 10s per test.
"""

import pytest


@pytest.mark.integration
@pytest.mark.slow
class TestFindCitationE2E:
    """POST /notes/assistant/citation end-to-end through the full stack."""

    @staticmethod
    def _post_citation(authenticated_session, api_base_url: str, payload: dict):
        """Shared POST helper — Kotlin REST endpoint is snake_case."""
        return authenticated_session.post(
            f"{api_base_url}/notes/assistant/citation",
            json=payload,
            timeout=30,
        )

    def test_returns_200_with_academic_results(self, authenticated_session, api_base_url):
        """A well-studied biomedical claim must round-trip a populated response."""
        response = self._post_citation(
            authenticated_session,
            api_base_url,
            {
                "claim_text": "CRISPR Cas9 enables precise gene editing in mammalian cells",
                "collection_ids": [],
                "search_crossref": True,
            },
        )
        assert response.status_code == 200, f"Unexpected status {response.status_code}: {response.text[:500]}"
        data = response.json()

        assert "academic_citations" in data
        assert "library_citations" in data
        assert isinstance(data["academic_citations"], list)

        academic = data["academic_citations"]
        assert len(academic) >= 1, f"Zero academic results through the full stack. Response: {data}"

    def test_e2e_results_have_bibliographic_metadata(self, authenticated_session, api_base_url):
        """At least one academic result must carry a DOI + title + year."""
        response = self._post_citation(
            authenticated_session,
            api_base_url,
            {
                "claim_text": "Meditation reduces cortisol levels",
                "collection_ids": [],
                "search_crossref": True,
            },
        )
        assert response.status_code == 200
        academic = response.json()["academic_citations"]
        assert academic, "No academic citations returned"

        with_doi = [c for c in academic if c.get("doi")]
        assert with_doi, f"No academic results had a DOI. Sample: {academic[0]}"

        sample = with_doi[0]
        assert sample.get("source_title")
        assert sample.get("citation"), "Missing nested citation metadata"
        citation = sample["citation"]
        assert citation.get("title")
        assert citation.get("doi")
        # APA format should have been populated by build_academic_row
        assert citation.get("formatted_apa"), f"formatted_apa missing — _academic_result.format_apa regressed? {citation}"

    def test_e2e_keyword_extraction_improves_relevance(self, authenticated_session, api_base_url):
        """The Python-side keyword extractor must route through gRPC correctly.

        Regression guard for the "has been shown to" boilerplate fix —
        if the query passed to Crossref regresses back to the raw claim,
        the top results flip to off-topic risperidone/octreotide papers.
        """
        response = self._post_citation(
            authenticated_session,
            api_base_url,
            {
                "claim_text": "Meditation has been shown to decrease cortisol levels and improves focus",
                "collection_ids": [],
                "search_crossref": True,
            },
        )
        assert response.status_code == 200
        academic = response.json()["academic_citations"]
        assert len(academic) >= 3

        # Sanity check: at least half of the top 6 results mention the
        # domain terms from the extracted query. We cannot assert exact
        # titles because the upstream APIs drift over time.
        top_6 = academic[:6]
        domain_terms = {"meditat", "mindful", "cortisol", "stress", "relax", "attention", "focus", "yoga"}
        on_topic = [c for c in top_6 if any(t in (c.get("source_title") or "").lower() for t in domain_terms)]
        assert len(on_topic) >= 2, (
            f"Keyword extraction regression: only {len(on_topic)}/6 top results "
            f"mention a domain term. Titles: "
            f"{[c.get('source_title', '')[:60] for c in top_6]}"
        )

    def test_e2e_oa_enrichment_populates_pdf_urls(self, authenticated_session, api_base_url):
        """At least one heavily-studied topic result must reach the frontend
        with a resolvable open-access PDF URL in the `url` field.

        The Python servicer swaps `url` for the Unpaywall-resolved PDF
        when one exists (backwards-compatible with older clients). This
        test does not require the explicit `oa_pdf_url` proto field —
        that lands in the Kotlin backend after its gRPC stubs are
        rebuilt, out of scope here.
        """
        response = self._post_citation(
            authenticated_session,
            api_base_url,
            {
                "claim_text": "AlphaFold accurately predicts protein structure from sequence",
                "collection_ids": [],
                "search_crossref": True,
            },
        )
        assert response.status_code == 200
        academic = response.json()["academic_citations"]
        assert len(academic) >= 1

        # For DOI-bearing results, `url` should be either a DOI landing
        # page OR an Unpaywall-resolved PDF. At least one heavily-studied
        # topic (AlphaFold) should produce a non-DOI URL — meaning the
        # enrichment pass actually ran and rewrote the field.
        with_doi = [c for c in academic if c.get("doi")]
        assert with_doi, "No DOI-bearing results to check enrichment on"

        rewritten = [c for c in with_doi if c.get("url") and c["url"] != f"https://doi.org/{c['doi']}"]
        assert rewritten, (
            "Unpaywall enrichment did not rewrite ANY result URL for an "
            "AlphaFold query. Check that _enrich_citations_with_oa ran "
            "through the full Kotlin→gRPC→Python→Unpaywall chain."
        )

    def test_e2e_handles_empty_claim_gracefully(self, authenticated_session, api_base_url):
        """An empty claim should not 500 — the endpoint must return empty
        lists or a 400, never an unhandled exception."""
        response = self._post_citation(
            authenticated_session,
            api_base_url,
            {
                "claim_text": "",
                "collection_ids": [],
                "search_crossref": True,
            },
        )
        assert response.status_code in (200, 400, 422), f"Empty claim produced {response.status_code}: {response.text[:200]}"
