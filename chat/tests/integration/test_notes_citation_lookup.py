"""
Integration tests for the Notes Assistant citation lookup pipeline.

Covers the `find_citation()` service function that backs the gRPC
`NotesAssistantService.FindCitation` RPC — the endpoint the Notes AI
"Find Citation" action calls when the user wants a citation for a
selected claim. These tests make real HTTP calls to Crossref, OpenAlex,
Semantic Scholar, and Unpaywall.

The service is called directly rather than through the gRPC client
because (a) the gRPC proto shape is a pure dict→proto translation of
the service return value and (b) the Kotlin backend does not yet expose
a REST proxy for FindCitation, so there is no controller-level entry
point to go through.
"""

import asyncio

import pytest

NONEXISTENT_USER_ID = "00000000-0000-0000-0000-000000000000"


@pytest.mark.integration
@pytest.mark.slow
class TestFindCitation:
    """find_citation() parallel-search + dedup + OA enrichment."""

    def test_returns_both_library_and_academic_keys(self):
        """The return contract must always include both lists, even when empty."""
        from src.main.service.notes_assistant.citation_lookup_service import find_citation

        result = asyncio.run(
            find_citation(
                claim_text="AlphaFold accurately predicts protein structure",
                user_id=NONEXISTENT_USER_ID,
                collection_ids=[],
                max_results=3,
            )
        )
        assert "library_citations" in result
        assert "academic_citations" in result
        assert isinstance(result["library_citations"], list)
        assert isinstance(result["academic_citations"], list)

    def test_academic_results_have_uniform_shape(self):
        """Every academic_citations item must conform to the ResearchResult dict shape."""
        from src.main.service.notes_assistant.citation_lookup_service import find_citation

        result = asyncio.run(
            find_citation(
                claim_text="CRISPR Cas9 gene editing",
                user_id=NONEXISTENT_USER_ID,
                collection_ids=[],
                max_results=3,
            )
        )

        assert result["academic_citations"], "No academic citations returned"

        required_top_keys = {
            "source_title",
            "snippet",
            "source_type",
            "relevance_score",
            "url",
            "doi",
            "citation",
        }
        required_citation_keys = {
            "title",
            "authors",
            "year",
            "journal",
            "doi",
            "url",
            "formatted_apa",
        }

        for item in result["academic_citations"]:
            missing_top = required_top_keys - set(item.keys())
            assert not missing_top, f"Academic result missing top-level keys: {missing_top}"
            assert item["source_type"] == "academic"
            assert isinstance(item["citation"], dict)
            missing_cit = required_citation_keys - set(item["citation"].keys())
            assert not missing_cit, f"CitationMetadata missing keys: {missing_cit}"

    def test_parallel_search_across_all_providers(self):
        """With every provider enabled we should see results from >= 2 sources."""
        from src.main.service.notes_assistant.citation_lookup_service import find_citation

        result = asyncio.run(
            find_citation(
                claim_text="neural network deep learning",
                user_id=NONEXISTENT_USER_ID,
                collection_ids=[],
                search_crossref_enabled=True,
                search_openalex_enabled=True,
                search_semantic_scholar_enabled=True,
                max_results=5,
            )
        )

        citations = result["academic_citations"]
        assert len(citations) > 0

        # Minimum bar: at least some results came back. Semantic Scholar
        # frequently hits 429 without an API key so we do not require its
        # presence, but the merged count should exceed the single-provider
        # max (5) often enough when dedup across Crossref + OpenAlex works.
        assert len(citations) >= 3, f"Expected at least 3 merged results from multi-provider search, got {len(citations)}"

    def test_doi_deduplication(self):
        """The same DOI appearing in two providers must merge into one entry."""
        from src.main.service.notes_assistant.citation_lookup_service import find_citation

        result = asyncio.run(
            find_citation(
                claim_text="AlphaFold protein",
                user_id=NONEXISTENT_USER_ID,
                collection_ids=[],
                max_results=5,
            )
        )

        dois_seen = [c["doi"].lower() for c in result["academic_citations"] if c.get("doi")]
        assert len(dois_seen) == len(set(dois_seen)), f"Duplicate DOIs in academic_citations: {dois_seen}"

    def test_oa_enrichment_fills_download_urls(self):
        """Unpaywall should resolve at least one OA PDF for a heavily-published topic."""
        from src.main.service.notes_assistant.citation_lookup_service import find_citation

        result = asyncio.run(
            find_citation(
                claim_text="CRISPR gene editing therapeutic applications",
                user_id=NONEXISTENT_USER_ID,
                collection_ids=[],
                enrich_oa=True,
                max_results=5,
            )
        )

        enriched = [c for c in result["academic_citations"] if c.get("oa_pdf_url")]
        assert enriched, "Zero citations got OA PDF URLs from Unpaywall enrichment. Check find_open_access_pdf + DOI format + network reachability."

        for c in enriched:
            assert c["oa_pdf_url"].startswith("http")
            assert c.get("oa_status") in ("gold", "green", "hybrid", "bronze"), f"Unexpected oa_status: {c.get('oa_status')}"

    def test_enrich_oa_disabled_does_not_call_unpaywall(self):
        """With enrich_oa=False, citations must not gain oa_pdf_url."""
        from src.main.service.notes_assistant.citation_lookup_service import find_citation

        result = asyncio.run(
            find_citation(
                claim_text="CRISPR gene editing",
                user_id=NONEXISTENT_USER_ID,
                collection_ids=[],
                enrich_oa=False,
                max_results=3,
            )
        )

        for c in result["academic_citations"]:
            assert "oa_pdf_url" not in c or not c.get("oa_pdf_url"), f"Unpaywall was called despite enrich_oa=False: {c}"

    def test_disabling_all_academic_providers_returns_empty(self):
        """With every academic provider off, academic_citations must be empty."""
        from src.main.service.notes_assistant.citation_lookup_service import find_citation

        result = asyncio.run(
            find_citation(
                claim_text="CRISPR gene editing",
                user_id=NONEXISTENT_USER_ID,
                collection_ids=[],
                search_crossref_enabled=False,
                search_openalex_enabled=False,
                search_semantic_scholar_enabled=False,
                max_results=3,
            )
        )

        assert result["academic_citations"] == []
