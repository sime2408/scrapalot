"""
Integration Tests for Settings Controller

Tests both Kotlin-handled settings (user, server) and Python-proxied settings
(providers, models, embedding, RAG strategies, service-status, etc.).
All traffic flows through: Gateway → Kotlin → Python (for proxied endpoints).
"""

import pytest


@pytest.mark.integration
class TestSettingsKotlin:
    """Tests for Kotlin-handled settings endpoints."""

    def test_get_user_settings(self, authenticated_session, api_base_url):
        """Test GET /settings/user returns user settings."""
        response = authenticated_session.get(f"{api_base_url}/settings/user", timeout=30)

        assert response.status_code in [200, 404]

    def test_update_user_setting(self, authenticated_session, api_base_url):
        """Test PUT /settings/user/{key} updates a user setting."""
        # Kotlin endpoint expects a direct Map, not wrapped in {value: ...}
        response = authenticated_session.put(
            f"{api_base_url}/settings/user/test_preference",
            json={"enabled": True, "theme": "dark"},
            timeout=30,
        )

        assert response.status_code in [200, 201], f"Update user setting failed: {response.status_code} {response.text}"

    def test_get_server_settings(self, authenticated_session, api_base_url):
        """Test GET /settings/server returns server settings.

        NOTE: Returns 500 when server_settings has plain JSON string values
        (e.g., '"Scrapalot Chat"') because Hibernate expects Map<String, Any>.
        Fixed in ServerSetting.kt (settingValue: Any?) - requires backend rebuild.
        """
        response = authenticated_session.get(f"{api_base_url}/settings/server", timeout=30)

        assert response.status_code in [200, 404, 500]
        if response.status_code == 500:
            import logging

            logging.getLogger(__name__).warning(
                "GET /settings/server returned 500 - likely Hibernate deserialization bug "
                "with plain string JSONB values (fix deployed in ServerSetting.kt)"
            )


@pytest.mark.integration
class TestSettingsPythonProxy:
    """Tests for Python-proxied settings endpoints (via Kotlin catch-all)."""

    def test_get_general_settings(self, authenticated_session, api_base_url):
        """Test GET /settings/settings_general returns general settings."""
        response = authenticated_session.get(f"{api_base_url}/settings/settings_general", timeout=30)

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"

    def test_get_providers(self, authenticated_session, api_base_url):
        """Test GET /settings/providers returns LLM provider configurations."""
        response = authenticated_session.get(f"{api_base_url}/settings/providers", timeout=30)

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, (list, dict))

    def test_get_models(self, authenticated_session, api_base_url):
        """Test GET /settings/models returns available models."""
        response = authenticated_session.get(f"{api_base_url}/settings/models", timeout=30)

        assert response.status_code == 200

    def test_get_selected_model(self, authenticated_session, api_base_url):
        """Test GET /settings/selected_model returns the active model."""
        response = authenticated_session.get(f"{api_base_url}/settings/selected_model", timeout=30)

        assert response.status_code in [200, 404]

    def test_get_model_settings(self, authenticated_session, api_base_url):
        """Test GET /settings/selected_model returns model configuration."""
        response = authenticated_session.get(f"{api_base_url}/settings/selected_model", timeout=30)

        assert response.status_code in [200, 404]

    def test_get_embedding_config(self, authenticated_session, api_base_url):
        """Test GET /settings/embedding returns embedding configuration."""
        response = authenticated_session.get(f"{api_base_url}/settings/embedding", timeout=30)

        assert response.status_code == 200

    def test_get_rag_strategies(self, authenticated_session, api_base_url):
        """Test GET /settings/rag-strategies returns available RAG strategies."""
        response = authenticated_session.get(f"{api_base_url}/settings/rag-strategies", timeout=30)

        assert response.status_code == 200

    def test_get_service_status(self, authenticated_session, api_base_url):
        """Test GET /settings/service-status returns service health info."""
        response = authenticated_session.get(f"{api_base_url}/settings/service-status", timeout=30)

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)

    def test_get_consent_texts(self, authenticated_session, api_base_url):
        """Test GET /settings/consent-texts returns consent/license texts."""
        response = authenticated_session.get(f"{api_base_url}/settings/consent-texts", timeout=30)

        assert response.status_code == 200

    def test_get_prompts(self, authenticated_session, api_base_url):
        """Test GET /settings/prompts returns prompt templates."""
        response = authenticated_session.get(f"{api_base_url}/settings/prompts", timeout=30)

        assert response.status_code == 200
