"""
API Endpoint Methods for Scrapalot Chat MCP Server

This module provides organized endpoint methods for all Scrapalot Chat API resources.
Each section corresponds to a controller in src/main/controllers.

Organized by resource:
- Authentication & Users
- Workspaces
- Collections
- Documents
- Chat & Sessions
- Messages
- Jobs
- Settings & LLM Inference
- Storage & Subscriptions
- Notes
- Workspace Connectors
"""

from typing import Any

import aiohttp

from .mcp_api_client import ScrapalotAPIClient


class ScrapalotEndpoints(ScrapalotAPIClient):
    """
    Extended API client with all endpoint methods organized by resource.

    Inherits from ScrapalotAPIClient for core HTTP functionality.
    """

    # ==================== Authentication & Users ====================

    async def register_user(
        self,
        username: str,
        email: str,
        password: str,
        first_name: str | None = None,
        last_name: str | None = None,
    ) -> dict[str, Any]:
        """Register a new user account."""
        data = {"username": username, "email": email, "password": password}
        if first_name:
            data["first_name"] = first_name
        if last_name:
            data["last_name"] = last_name
        return await self.post("/users/register", json_data=data)

    async def get_current_user(self) -> dict[str, Any]:
        """Get current authenticated user information."""
        return await self.get("/users/me")

    async def create_user(self, username: str, email: str, password: str, role: str = "USER") -> dict[str, Any]:
        """Create a new user (admin only)."""
        data = {"username": username, "email": email, "password": password, "role": role}
        return await self.post("/users/create", json_data=data)

    async def update_user(self, user_id: int, **updates) -> dict[str, Any]:
        """Update user information."""
        return await self.put(f"/users/edit/{user_id}", json_data=updates)

    async def delete_user(self, user_id: int) -> dict[str, Any]:
        """Delete a user account."""
        return await self.delete(f"/users/delete/{user_id}")

    async def list_users(self, page: int = 1, page_size: int = 10) -> dict[str, Any]:
        """List all users (admin only)."""
        return await self.get("/users", params={"page": page, "page_size": page_size})

    # ==================== Workspaces ====================

    async def list_workspaces(self, page: int = 1, page_size: int = 10) -> dict[str, Any]:
        """Get list of workspaces for current user."""
        return await self.get("/workspaces", params={"page": page, "page_size": page_size})

    async def create_workspace(self, name: str, description: str | None = None) -> dict[str, Any]:
        """Create a new workspace."""
        data = {"name": name}
        if description:
            data["description"] = description
        return await self.post("/workspaces", json_data=data)

    async def get_default_workspace(self) -> dict[str, Any]:
        """Get the default workspace for current user."""
        return await self.get("/workspaces/default")

    async def select_workspace(self, workspace_id: str) -> dict[str, Any]:
        """Select a workspace as the active one."""
        return await self.post("/workspaces/select", json_data={"workspace_id": workspace_id})

    async def get_workspace(self, workspace_id: str) -> dict[str, Any]:
        """Get workspace details with users."""
        return await self.get(f"/workspaces/{workspace_id}")

    async def update_workspace(self, workspace_id: str, **updates) -> dict[str, Any]:
        """Update workspace information."""
        return await self.put(f"/workspaces/{workspace_id}", json_data=updates)

    async def delete_workspace(self, workspace_id: str) -> dict[str, Any]:
        """Delete a workspace."""
        return await self.delete(f"/workspaces/{workspace_id}")

    async def share_workspace(self, workspace_id: str, user_identifier: str, role: str = "viewer") -> dict[str, Any]:
        """Share workspace with another user."""
        data = {"workspace_id": workspace_id, "user_identifier": user_identifier, "role": role}
        return await self.post("/workspaces/share", json_data=data)

    async def remove_workspace_access(self, workspace_id: str, user_id: str) -> dict[str, Any]:
        """Remove user access from workspace."""
        return await self.delete(f"/workspaces/share/{workspace_id}/{user_id}")

    async def update_workspace_user_role(self, workspace_id: str, user_id: str, role: str) -> dict[str, Any]:
        """Update user role in workspace."""
        return await self.put(f"/workspaces/share/{workspace_id}/{user_id}", json_data={"role": role})

    async def get_workspace_role(self, workspace_id: str) -> dict[str, Any]:
        """Get current user's role in workspace."""
        return await self.get(f"/workspaces/{workspace_id}/my-role")

    async def get_workspace_storage(self, workspace_id: str) -> dict[str, Any]:
        """Get storage information for workspace."""
        return await self.get(f"/workspaces/{workspace_id}/storage")

    # ==================== Collections ====================

    async def list_collections(
        self, workspace_id: str | None = None, page: int = 1, page_size: int = 50, search: str | None = None
    ) -> dict[str, Any]:
        """Get list of collections."""
        params: dict[str, Any] = {"page": page, "page_size": page_size}
        if workspace_id:
            params["workspace_id"] = workspace_id
        if search:
            params["search"] = search
        return await self.get("/collections", params=params)

    async def create_collection(self, name: str, workspace_id: str, description: str | None = None) -> dict[str, Any]:
        """Create a new collection."""
        data = aiohttp.FormData()
        data.add_field("name", name)
        data.add_field("workspace_id", workspace_id)
        if description:
            data.add_field("description", description)
        return await self.post("/collections", form_data=data)

    async def get_collection(self, collection_id: str) -> dict[str, Any]:
        """Get collection details."""
        return await self.get(f"/collections/{collection_id}")

    async def update_collection(self, collection_id: str, **updates) -> dict[str, Any]:
        """Update collection information."""
        return await self.put(f"/collections/{collection_id}", json_data=updates)

    async def delete_collection(self, collection_id: str) -> dict[str, Any]:
        """Delete a collection."""
        return await self.delete(f"/collections/{collection_id}")

    async def get_collection_stats(self, collection_id: str) -> dict[str, Any]:
        """Get statistics for a collection."""
        return await self.get(f"/collections/{collection_id}/stats")

    # ==================== Documents ====================

    async def upload_document(self, file_path: str, collection_id: str) -> dict[str, Any]:
        """Upload a document to a collection."""
        return await self.upload_file("/documents/upload_async", file_path, {"collection_id": collection_id})

    async def upload_document_content(self, content: str, filename: str, collection_id: str) -> dict[str, Any]:
        """Upload document content as a file."""
        return await self.upload_content("/documents/upload_async", content, filename, {"collection_id": collection_id})

    async def list_documents(self, collection_id: str, page: int = 1, page_size: int = 50) -> dict[str, Any]:
        """Get list of documents in a collection."""
        return await self.get(f"/documents/list/{collection_id}", params={"page": page, "page_size": page_size})

    async def get_document(self, document_id: str) -> dict[str, Any]:
        """Get document details."""
        return await self.get(f"/documents/{document_id}")

    async def update_document(self, document_id: str, **updates) -> dict[str, Any]:
        """Update document metadata."""
        return await self.put(f"/documents/{document_id}", json_data=updates)

    async def delete_document(self, document_id: str) -> dict[str, Any]:
        """Delete a document."""
        return await self.delete(f"/documents/{document_id}")

    async def get_document_chunks(self, document_id: str) -> dict[str, Any]:
        """Get chunks for a document."""
        return await self.get(f"/documents/{document_id}/chunks")

    async def reprocess_document(self, document_id: str) -> dict[str, Any]:
        """Reprocess a document."""
        return await self.post(f"/documents/{document_id}/reprocess")

    # ==================== Chat & Sessions ====================

    async def chat(
        self,
        message: str,
        session_id: str | None = None,
        collection_id: str | None = None,
        model_name: str | None = None,
        rag_strategy: str = "balanced",
        **kwargs,
    ) -> dict[str, Any]:
        """Send a chat message via the OpenAI-compatible /v1/chat/completions
        endpoint (the only chat surface the project exposes).
        """
        extras: dict[str, Any] = {"rag_strategy": rag_strategy, **kwargs}
        if collection_id:
            extras["collection_ids"] = [collection_id]
        body = {
            "model": "scrapalot:default",
            "messages": [{"role": "user", "content": message}],
            "stream": False,
            "scrapalot": extras,
        }
        if session_id:
            return await self.post(
                "/chat/completions",
                json_data=body,
                headers={"Conversation-Id": session_id},
            )
        return await self.post("/chat/completions", json_data=body)

    async def list_sessions(self, page: int = 1, page_size: int = 20) -> dict[str, Any]:
        """Get list of chat sessions."""
        return await self.get("/sessions", params={"page": page, "page_size": page_size})

    async def create_session(self, collection_id: str | None = None, conversation_name: str | None = None) -> dict[str, Any]:
        """Create a new chat session."""
        data = {}
        if collection_id:
            data["collection_id"] = collection_id
        if conversation_name:
            data["conversation_name"] = conversation_name
        return await self.post("/sessions", json_data=data)

    async def get_session(self, session_id: str) -> dict[str, Any]:
        """Get session details."""
        return await self.get(f"/sessions/{session_id}")

    async def update_session(self, session_id: str, **updates) -> dict[str, Any]:
        """Update session information."""
        return await self.put(f"/sessions/{session_id}", json_data=updates)

    async def delete_session(self, session_id: str) -> dict[str, Any]:
        """Delete a session."""
        return await self.delete(f"/sessions/{session_id}")

    # ==================== Messages ====================

    async def list_messages(self, session_id: str, page: int = 1, page_size: int = 50) -> dict[str, Any]:
        """Get messages for a session."""
        return await self.get(f"/messages/{session_id}", params={"page": page, "page_size": page_size})

    async def get_message(self, message_id: str) -> dict[str, Any]:
        """Get message details."""
        return await self.get(f"/messages/message/{message_id}")

    async def update_message(self, message_id: str, **updates) -> dict[str, Any]:
        """Update message content."""
        return await self.put(f"/messages/{message_id}", json_data=updates)

    async def delete_message(self, message_id: str) -> dict[str, Any]:
        """Delete a message."""
        return await self.delete(f"/messages/{message_id}")

    # ==================== Jobs ====================

    async def list_active_jobs(self, include_details: bool = True) -> dict[str, Any]:
        """Get list of active jobs."""
        return await self.get("/jobs/active", params={"include_details": include_details})

    async def get_job_status(self, job_id: str) -> dict[str, Any]:
        """Get status of a specific job."""
        return await self.get(f"/jobs/status/{job_id}")

    async def cancel_job(self, job_id: str) -> dict[str, Any]:
        """Cancel a job."""
        return await self.post(f"/jobs/{job_id}/cancel")

    async def list_job_history(self, page: int = 1, page_size: int = 20) -> dict[str, Any]:
        """Get job history."""
        return await self.get("/jobs/history", params={"page": page, "page_size": page_size})

    # ==================== Settings & LLM Inference ====================

    async def list_providers(self) -> dict[str, Any]:
        """Get list of LLM providers."""
        return await self.get("/settings/providers")

    async def create_provider(self, name: str, provider_type: str, api_key: str, **config) -> dict[str, Any]:
        """Create a new LLM provider."""
        data = {"name": name, "provider_type": provider_type, "api_key": api_key, **config}
        return await self.post("/settings/providers", json_data=data)

    async def update_provider(self, provider_id: str, **updates) -> dict[str, Any]:
        """Update provider configuration."""
        return await self.put(f"/settings/providers/{provider_id}", json_data=updates)

    async def delete_provider(self, provider_id: str) -> dict[str, Any]:
        """Delete a provider."""
        return await self.delete(f"/settings/providers/{provider_id}")

    async def sync_provider_models(self, provider_id: str) -> dict[str, Any]:
        """Manually sync models for a provider."""
        return await self.post(f"/settings/providers/{provider_id}/sync")

    async def list_models(self) -> dict[str, Any]:
        """Get list of available models."""
        return await self.get("/llm-inference/list-models")

    async def get_model_info(self, model_id: str) -> dict[str, Any]:
        """Get information about a specific model."""
        return await self.get(f"/llm-inference/models/{model_id}")

    async def get_user_settings(self) -> dict[str, Any]:
        """Get user settings."""
        return await self.get("/settings/user")

    async def update_user_settings(self, **settings) -> dict[str, Any]:
        """Update user settings."""
        return await self.put("/settings/user", json_data=settings)

    async def get_selected_model(self) -> dict[str, Any]:
        """Get user's selected model."""
        return await self.get("/settings/selected_model")

    async def save_selected_model(self, model_id: str, model_name: str, provider_type: str) -> dict[str, Any]:
        """Save user's selected model."""
        data = {"model_id": model_id, "model_name": model_name, "provider_type": provider_type}
        return await self.post("/settings/selected_model", json_data=data)

    # ==================== Storage & Subscriptions ====================

    async def get_storage_quota(self) -> dict[str, Any]:
        """Get storage quota information."""
        return await self.get("/storage/quota")

    async def get_storage_usage(self) -> dict[str, Any]:
        """Get storage usage statistics."""
        return await self.get("/storage/usage")

    async def list_subscription_plans(self) -> dict[str, Any]:
        """Get available subscription plans."""
        return await self.get("/subscriptions/plans")

    async def get_current_subscription(self) -> dict[str, Any]:
        """Get current user's subscription."""
        return await self.get("/subscriptions/current")

    async def create_subscription(self, plan_id: str) -> dict[str, Any]:
        """Create a new subscription."""
        return await self.post("/subscriptions", json_data={"plan_id": plan_id})

    async def cancel_subscription(self, subscription_id: str) -> dict[str, Any]:
        """Cancel a subscription."""
        return await self.delete(f"/subscriptions/{subscription_id}")

    # ==================== Notes ====================

    async def list_notes(self, workspace_id: str | None = None, session_id: str | None = None) -> dict[str, Any]:
        """Get list of notes."""
        params = {}
        if workspace_id:
            params["workspace_id"] = workspace_id
        if session_id:
            params["session_id"] = session_id
        return await self.get("/notes", params=params)

    async def create_note(self, title: str, content: dict[str, Any], workspace_id: str, session_id: str | None = None) -> dict[str, Any]:
        """Create a new note."""
        data = {"title": title, "content": content, "workspace_id": workspace_id}
        if session_id:
            data["session_id"] = session_id
        return await self.post("/notes", json_data=data)

    async def get_note(self, note_id: str) -> dict[str, Any]:
        """Get note details."""
        return await self.get(f"/notes/{note_id}")

    async def update_note(self, note_id: str, **updates) -> dict[str, Any]:
        """Update note content."""
        return await self.put(f"/notes/{note_id}", json_data=updates)

    async def delete_note(self, note_id: str) -> dict[str, Any]:
        """Delete a note."""
        return await self.delete(f"/notes/{note_id}")

    # ==================== Workspace Connectors ====================

    async def list_available_connectors(self) -> dict[str, Any]:
        """Get list of available connector types."""
        return await self.get("/connectors/available")

    async def create_connector(
        self,
        workspace_id: str,
        source: str,
        name: str,
        credentials: dict[str, Any] | None = None,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create a new workspace connector."""
        data: dict[str, Any] = {"source": source, "name": name}
        if credentials:
            data["credentials"] = credentials
        if config:
            data["config"] = config
        return await self.post(f"/workspaces/{workspace_id}/connectors", json_data=data)

    async def list_workspace_connectors(self, workspace_id: str) -> dict[str, Any]:
        """Get connectors for a workspace."""
        return await self.get(f"/workspaces/{workspace_id}/connectors")

    async def get_connector(self, connector_id: str) -> dict[str, Any]:
        """Get connector details."""
        return await self.get(f"/connectors/{connector_id}")

    async def update_connector(self, connector_id: str, **updates) -> dict[str, Any]:
        """Update connector configuration."""
        return await self.put(f"/connectors/{connector_id}", json_data=updates)

    async def delete_connector(self, connector_id: str) -> dict[str, Any]:
        """Delete a connector."""
        return await self.delete(f"/connectors/{connector_id}")

    async def create_sync_destination(
        self,
        connector_id: str,
        destination_type: str,
        collection_id: str | None = None,
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Create a sync destination for a connector."""
        data: dict[str, Any] = {"destination_type": destination_type}
        if collection_id:
            data["collection_id"] = collection_id
        if config:
            data["config"] = config
        return await self.post(f"/connectors/{connector_id}/destinations", json_data=data)

    async def list_sync_destinations(self, connector_id: str) -> dict[str, Any]:
        """Get sync destinations for a connector."""
        return await self.get(f"/connectors/{connector_id}/destinations")

    async def trigger_manual_sync(self, connector_id: str, destination_id: str) -> dict[str, Any]:
        """Trigger manual sync for a connector destination."""
        return await self.post(f"/connectors/{connector_id}/destinations/{destination_id}/sync")

    async def list_destination_files(self, connector_id: str, destination_id: str) -> dict[str, Any]:
        """Get files for a sync destination."""
        return await self.get(f"/connectors/{connector_id}/destinations/{destination_id}/files")

    async def initiate_oauth_flow(self, connector_type: str, redirect_uri: str) -> dict[str, Any]:
        """Initiate OAuth flow for a connector."""
        data = {"connector_type": connector_type, "redirect_uri": redirect_uri}
        return await self.post("/connectors/oauth/authorize", json_data=data)

    async def handle_oauth_callback(self, state: str, code: str) -> dict[str, Any]:
        """Handle OAuth callback."""
        data = {"state": state, "code": code}
        return await self.post("/connectors/oauth/callback", json_data=data)
