"""
Integration Tests for Users Controller

Endpoints: GET /users/me, PUT /users/{id}, GET /users/search, etc.
Tests the full GW → Kotlin Backend user management flow.
"""

import pytest


@pytest.mark.integration
class TestUsers:
    """Integration tests for /users endpoints."""

    def test_get_current_user_profile(self, authenticated_session, api_base_url):
        """Test GET /users/me returns the current user profile."""
        response = authenticated_session.get(f"{api_base_url}/users/me", timeout=30)

        assert response.status_code == 200, f"Expected 200, got {response.status_code}: {response.text}"

        data = response.json()
        assert "id" in data
        assert "username" in data
        assert "email" in data
        assert "role" in data
        assert data["role"].lower() in ["user", "admin"]

    def test_get_user_by_id(self, authenticated_session, api_base_url, test_user_id):
        """Test GET /users/{id} returns a specific user."""
        response = authenticated_session.get(f"{api_base_url}/users/{test_user_id}", timeout=30)

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == test_user_id

    def test_search_users(self, authenticated_session, api_base_url):
        """Test GET /users/search returns matching users."""
        response = authenticated_session.get(
            f"{api_base_url}/users/search",
            params={"query": "admin"},
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()
        # API may return a list or a wrapper dict with "users" key
        if isinstance(data, dict):
            users = data.get("users", [])
            assert isinstance(users, list), f"Expected 'users' list in response, got: {type(users)}"
        else:
            assert isinstance(data, list), f"Expected list or dict with 'users', got: {type(data)}"

    def test_update_user_profile(self, authenticated_session, api_base_url, test_user_id):
        """Test PUT /users/{id} updates the user profile."""
        # Get current profile
        get_response = authenticated_session.get(f"{api_base_url}/users/me", timeout=30)
        assert get_response.status_code == 200
        original = get_response.json()

        # Update first name
        new_first_name = f"Test_{original.get('first_name', 'User')}"
        update_response = authenticated_session.put(
            f"{api_base_url}/users/{test_user_id}",
            json={"first_name": new_first_name, "last_name": original.get("last_name", "")},
            timeout=30,
        )

        assert update_response.status_code == 200

        # Restore original
        authenticated_session.put(
            f"{api_base_url}/users/{test_user_id}",
            json={"first_name": original.get("first_name", ""), "last_name": original.get("last_name", "")},
            timeout=30,
        )

    def test_mark_tour_completed(self, authenticated_session, api_base_url):
        """Test PUT /users/me/tour-completed marks the tour as completed."""
        response = authenticated_session.put(f"{api_base_url}/users/me/tour-completed", timeout=30)

        assert response.status_code == 200

    def test_desktop_auto_login(self, api_base_url):
        """Test POST /users/desktop-auto-login returns a token."""
        import requests

        response = requests.post(f"{api_base_url}/users/desktop-auto-login", timeout=30)

        # May return 200 with token or 401/403 depending on config
        assert response.status_code in [200, 401, 403]

        if response.status_code == 200:
            data = response.json()
            assert "access_token" in data
