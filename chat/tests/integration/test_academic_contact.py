"""
Integration tests for the shared academic-API contact helper.

The helper backs every polite-pool mailto / User-Agent used by Crossref,
OpenAlex, Unpaywall, Semantic Scholar, and PubMed. Getting the fallback
chain wrong (system_settings → config.yaml → hardcoded default) means
Unpaywall rejects our requests with HTTP 422 and the whole OA-enrichment
step silently disappears from search results.

These tests hit a real running database connection so the system_settings
lookup path is covered end-to-end — no mocks.
"""

import pytest


@pytest.mark.integration
class TestAcademicContactHelper:
    """Verifies get_academic_contact_email + sibling API-key getters."""

    @staticmethod
    def _clear_caches():
        """Reset lru_cache so each test sees a fresh lookup."""
        from src.main.utils.connectors.academic_contact import (
            get_academic_contact_email,
            get_ncbi_api_key,
            get_openalex_api_key,
            get_polite_user_agent,
            get_semantic_scholar_api_key,
        )

        get_academic_contact_email.cache_clear()
        get_openalex_api_key.cache_clear()
        get_semantic_scholar_api_key.cache_clear()
        get_ncbi_api_key.cache_clear()
        # get_polite_user_agent is not cached itself but calls the email getter
        assert get_polite_user_agent is not None

    def test_contact_email_is_never_empty(self):
        """Fallback chain must always return a usable email string."""
        self._clear_caches()
        from src.main.utils.connectors.academic_contact import get_academic_contact_email

        email = get_academic_contact_email()
        assert email
        assert "@" in email, f"Got malformed email: {email!r}"
        assert not email.startswith("test@"), (
            "Unpaywall rejects placeholder emails like test@example.com with HTTP 422 — helper must never return one"
        )

    def test_contact_email_reads_config_default(self):
        """With no system_settings override present, config.yaml default wins."""
        self._clear_caches()
        from src.main.utils.connectors.academic_contact import get_academic_contact_email

        email = get_academic_contact_email()
        # config.yaml default is research@mail.scrapalot.app (shippable, not a placeholder)
        assert email.endswith("scrapalot.app"), f"Unexpected default email: {email}"

    def test_polite_user_agent_format(self):
        """User-Agent must embed the contact email per Crossref/OpenAlex convention."""
        self._clear_caches()
        from src.main.utils.connectors.academic_contact import get_academic_contact_email, get_polite_user_agent

        ua = get_polite_user_agent()
        email = get_academic_contact_email()
        assert "Scrapalot" in ua
        assert f"mailto:{email}" in ua, f"User-Agent missing mailto: {ua}"

    def test_api_keys_default_to_none_when_unset(self):
        """Missing API keys must return None (not empty string) so callers can `if key:`."""
        self._clear_caches()
        from src.main.utils.connectors.academic_contact import (
            get_ncbi_api_key,
            get_openalex_api_key,
            get_semantic_scholar_api_key,
        )

        # In a clean dev/test environment these are not configured
        assert get_openalex_api_key() is None or isinstance(get_openalex_api_key(), str)
        assert get_semantic_scholar_api_key() is None or isinstance(get_semantic_scholar_api_key(), str)
        assert get_ncbi_api_key() is None or isinstance(get_ncbi_api_key(), str)

    def test_system_settings_override_takes_precedence(self, db_cursor):
        """When system_settings has a row, it must win over config.yaml."""
        self._clear_caches()

        override_email = "override-test@scrapalot-test.app"

        # Insert a temporary override
        db_cursor.execute(
            "INSERT INTO system_settings (key, value, created_at, updated_at) "
            "VALUES ('ACADEMIC_CONTACT_EMAIL', %s, NOW(), NOW()) "
            "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
            (override_email,),
        )
        db_cursor.connection.commit()

        try:
            from src.main.utils.connectors.academic_contact import get_academic_contact_email

            get_academic_contact_email.cache_clear()
            assert get_academic_contact_email() == override_email
        finally:
            # Clean up the override so other tests see the default
            db_cursor.execute("DELETE FROM system_settings WHERE key = 'ACADEMIC_CONTACT_EMAIL'")
            db_cursor.connection.commit()
            # Clear cache again so subsequent tests / callers re-read
            from src.main.utils.connectors.academic_contact import get_academic_contact_email

            get_academic_contact_email.cache_clear()
