"""
Integration Tests for Authentication

Endpoints: POST /auth/login, GET /auth/api-keys, POST /auth/api-keys, DELETE /auth/api-keys/{id}
Tests the full GW → Kotlin Backend authentication flow.
"""

import pytest
import requests

from tests.conftest import TEST_PASSWORD


@pytest.mark.integration
class TestAuth:
    """Integration tests for /auth endpoints."""

    def test_login_valid_credentials(self, api_base_url):
        """Test POST /auth/login with valid credentials."""
        response = requests.post(
            f"{api_base_url}/auth/login",
            json={"username_or_email": "admin", "password": TEST_PASSWORD},
            timeout=30,
        )

        assert response.status_code == 200, f"Login failed: {response.text}"

        data = response.json()
        assert "access_token" in data
        assert "token_type" in data
        assert data["token_type"] == "bearer"
        assert "expires_in" in data
        assert data["expires_in"] > 0

    def test_login_wrong_password(self, api_base_url):
        """Test POST /auth/login with wrong password returns 401."""
        response = requests.post(
            f"{api_base_url}/auth/login",
            json={"username_or_email": "admin", "password": "wrongpassword"},
            timeout=30,
        )

        assert response.status_code == 401

    def test_login_nonexistent_user(self, api_base_url):
        """Test POST /auth/login with nonexistent user returns 401."""
        response = requests.post(
            f"{api_base_url}/auth/login",
            json={"username_or_email": "nonexistent_user_xyz", "password": "password"},
            timeout=30,
        )

        assert response.status_code == 401

    def test_protected_endpoint_without_token(self, api_base_url):
        """Test accessing protected endpoint without JWT token returns 401."""
        session = requests.Session()
        session.headers.update({"Accept": "application/json"})

        response = session.get(f"{api_base_url}/users/me", timeout=30)

        assert response.status_code == 401

    def test_protected_endpoint_with_invalid_token(self, api_base_url):
        """Test accessing protected endpoint with invalid JWT token returns 401."""
        session = requests.Session()
        session.headers.update(
            {
                "Authorization": "Bearer invalid.token.here",
                "Accept": "application/json",
            }
        )

        response = session.get(f"{api_base_url}/users/me", timeout=30)

        assert response.status_code == 401

    def test_jwt_token_works(self, authenticated_session, api_base_url):
        """Test that the JWT token from login works for authenticated requests."""
        response = authenticated_session.get(f"{api_base_url}/users/me", timeout=30)

        assert response.status_code == 200
        data = response.json()
        assert "id" in data
        assert "username" in data

    def test_list_api_keys(self, authenticated_session, api_base_url):
        """Test GET /auth/api-keys returns list of API keys."""
        response = authenticated_session.get(f"{api_base_url}/auth/api-keys", timeout=30)

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_create_and_delete_api_key(self, authenticated_session, api_base_url):
        """Test POST /auth/api-keys creates a key, DELETE removes it."""
        # Create API key
        create_response = authenticated_session.post(
            f"{api_base_url}/auth/api-keys",
            json={"name": "test-integration-key"},
            timeout=30,
        )

        assert create_response.status_code in [200, 201], f"Create failed: {create_response.text}"

        key_data = create_response.json()
        assert "id" in key_data
        key_id = key_data["id"]

        # Delete API key
        delete_response = authenticated_session.delete(
            f"{api_base_url}/auth/api-keys/{key_id}",
            timeout=30,
        )

        assert delete_response.status_code in [200, 204]
