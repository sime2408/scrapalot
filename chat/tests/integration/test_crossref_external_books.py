"""
Integration tests for the Crossref provider in the External Book Providers
pipeline (Knowledge Stacks → Upload → Find books online).

These tests make real HTTP calls to api.crossref.org — they need network
access and are sensitive to rate limits. They verify the search result
shape and the Unpaywall enrichment post-processor that fills in
downloadable PDF links for DOI-bearing results.
"""

import asyncio

import pytest


@pytest.mark.integration
@pytest.mark.slow
class TestCrossrefProvider:
    """Live Crossref calls through ExternalBooksService."""

    def test_crossref_standalone_returns_journal_articles(self):
        """CrossrefProvider.search should return real DOIs for a biomedical query."""
        from src.main.service.external_books.providers.crossref import CrossrefProvider

        results = asyncio.run(CrossrefProvider.search("CRISPR Cas9 gene editing", limit=5))

        assert len(results) > 0, "Crossref should return at least one CRISPR result"

        for r in results:
            assert r.id, f"Result missing DOI: {r}"
            assert r.id.startswith("10."), f"Result id is not a valid DOI: {r.id}"
            assert r.title, f"Result missing title: {r}"
            assert r.source.value == "crossref"
            assert r.preview_url == f"https://doi.org/{r.id}"
            # Crossref never hosts PDFs — Unpaywall enrichment fills this later
            assert r.download_url is None
            assert r.can_download is False

    def test_crossref_parses_authors_year_journal(self):
        """Bibliographic fields must be populated for typical journal articles."""
        from src.main.service.external_books.providers.crossref import CrossrefProvider

        results = asyncio.run(CrossrefProvider.search("AlphaFold protein structure prediction", limit=10))

        # At least some results should have full bibliographic metadata
        with_authors = [r for r in results if r.author]
        with_year = [r for r in results if r.year]
        with_subjects = [r for r in results if r.subjects]

        assert with_authors, "No Crossref results had author metadata"
        assert with_year, "No Crossref results had a publication year"
        assert with_subjects, "No Crossref results had journal/subject metadata"

    def test_external_books_service_includes_crossref_by_default(self):
        """BookSearchRequest default sources must include Crossref."""
        from src.main.service.external_books.models import BookSearchRequest, BookSource

        request = BookSearchRequest(query="test")
        assert BookSource.CROSSREF in request.sources

    def test_service_search_with_unpaywall_enrichment(self):
        """End-to-end: Crossref + OpenAlex search → Unpaywall OA enrichment."""
        from src.main.service.external_books.external_books_service import ExternalBooksService
        from src.main.service.external_books.models import BookSearchRequest, BookSource, SortBy

        request = BookSearchRequest(
            query="CRISPR gene editing therapeutic",
            sources=[BookSource.CROSSREF, BookSource.OPENALEX],
            limit=5,
            sort_by=SortBy.YEAR_DESC,
            enrich_oa=True,
        )
        response = asyncio.run(ExternalBooksService.search(request))

        assert response.total > 0, "Search returned zero results"
        assert len(response.results) > 0
        assert len(response.results) <= 5

        # Unpaywall resolves a majority of DOIs to free PDFs for well-studied
        # topics like CRISPR — require at least ONE enriched result so the
        # test fails loudly if the enrichment step ever silently breaks.
        enriched = [r for r in response.results if r.can_download and r.download_url]
        assert enriched, (
            "Unpaywall enrichment produced zero downloadable PDFs for a CRISPR query. "
            "Either the Unpaywall API is down, the DOI regex failed, or the "
            "_enrich_with_open_access path regressed."
        )

        for r in enriched:
            assert r.download_url.startswith("http"), f"Malformed download_url: {r.download_url}"
            assert r.extension == "pdf"

    def test_service_search_without_enrichment_has_no_oa_urls(self):
        """When enrich_oa=False, Crossref results must not be upgraded."""
        from src.main.service.external_books.external_books_service import ExternalBooksService
        from src.main.service.external_books.models import BookSearchRequest, BookSource

        request = BookSearchRequest(
            query="CRISPR Cas9",
            sources=[BookSource.CROSSREF],
            limit=3,
            enrich_oa=False,
        )
        response = asyncio.run(ExternalBooksService.search(request))

        assert len(response.results) > 0
        # Crossref never populates download_url by itself
        for r in response.results:
            assert r.download_url is None
            assert r.can_download is False
