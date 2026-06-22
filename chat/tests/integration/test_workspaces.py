"""
Integration Tests for Workspaces Controller

Endpoints: GET /workspaces, POST /workspaces, GET /workspaces/default, etc.
Tests the full GW → Kotlin Backend workspace management flow.
"""

import uuid

import pytest


@pytest.mark.integration
class TestWorkspaces:
    """Integration tests for /workspaces endpoints."""

    def test_list_workspaces(self, authenticated_session, api_base_url):
        """Test GET /workspaces returns paginated workspaces."""
        response = authenticated_session.get(f"{api_base_url}/workspaces", timeout=30)

        assert response.status_code == 200
        data = response.json()

        # Kotlin returns {workspaces: [...], pagination: {...}}
        if isinstance(data, dict) and "workspaces" in data:
            assert isinstance(data["workspaces"], list)
            assert "pagination" in data

    def test_get_default_workspace(self, authenticated_session, api_base_url):
        """Test GET /workspaces/default returns the user's default workspace."""
        response = authenticated_session.get(f"{api_base_url}/workspaces/default", timeout=30)

        assert response.status_code == 200
        data = response.json()
        assert "id" in data
        assert "name" in data

    def test_get_workspace_by_id(self, authenticated_session, api_base_url, test_workspace):
        """Test GET /workspaces/{id} returns a specific workspace."""
        response = authenticated_session.get(
            f"{api_base_url}/workspaces/{test_workspace['id']}",
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()
        assert str(data["id"]) == str(test_workspace["id"])

    def test_create_and_delete_workspace(self, authenticated_session, api_base_url):
        """Test POST /workspaces creates a workspace, DELETE removes it."""
        workspace_name = f"Test Workspace {uuid.uuid4().hex[:8]}"

        # Create workspace
        create_response = authenticated_session.post(
            f"{api_base_url}/workspaces",
            json={"name": workspace_name},
            timeout=30,
        )

        assert create_response.status_code in [200, 201], f"Create failed: {create_response.text}"

        data = create_response.json()
        workspace_id = data.get("id") or data.get("workspace_id")
        assert workspace_id is not None

        # Delete workspace
        delete_response = authenticated_session.delete(
            f"{api_base_url}/workspaces/{workspace_id}",
            timeout=30,
        )

        assert delete_response.status_code in [200, 204]

    def test_update_workspace(self, authenticated_session, api_base_url, test_workspace):
        """Test PUT /workspaces/{id} updates a workspace."""
        original_name = test_workspace["name"]
        new_name = f"Updated {uuid.uuid4().hex[:6]}"

        # Update
        response = authenticated_session.put(
            f"{api_base_url}/workspaces/{test_workspace['id']}",
            json={"name": new_name},
            timeout=30,
        )

        assert response.status_code == 200

        # Restore
        authenticated_session.put(
            f"{api_base_url}/workspaces/{test_workspace['id']}",
            json={"name": original_name},
            timeout=30,
        )

    def test_get_my_role(self, authenticated_session, api_base_url, test_workspace):
        """Test GET /workspaces/{id}/my-role returns the user's role."""
        response = authenticated_session.get(
            f"{api_base_url}/workspaces/{test_workspace['id']}/my-role",
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()
        assert "role" in data

    def test_list_workspace_users(self, authenticated_session, api_base_url, test_workspace):
        """Test GET /workspaces/{id}/users returns workspace members."""
        response = authenticated_session.get(
            f"{api_base_url}/workspaces/{test_workspace['id']}/users",
            timeout=30,
        )

        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
        assert len(data) > 0
