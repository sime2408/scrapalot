"""
Base API Client for Scrapalot Chat MCP Server

This module provides the core HTTP client functionality for interacting with
the Scrapalot Chat API. It handles authentication, session management, and
common HTTP operations.

Designed for:
- Reusability across different MCP tools
- Easy Postman collection generation
- Modern async/await patterns
- Comprehensive error handling
"""

import os
import tempfile
from typing import Any

import aiofiles
import aiohttp

# Configuration
DEFAULT_BASE_URL = "http://localhost:8090"
DEFAULT_TIMEOUT = 300  # 5 minutes for long operations

# Environment variables for authentication
# API Key is the preferred method (format: scp-xxxxxxxxxxxxxxxxxxxx)
DEFAULT_API_KEY = os.getenv("SCRAPALOT_API_KEY", None)

# Fallback to username/password if no API key is provided
DEFAULT_USERNAME = os.getenv("MCP_USERNAME", "admin")
DEFAULT_PASSWORD = os.getenv("MCP_PASSWORD", "")

# Logging setup
try:
    from src.main.utils.core.logger import get_logger

    logger = get_logger(__name__)
except ImportError:
    get_logger = None
    import logging

    logger = logging.getLogger(__name__)


class ScrapalotAPIClient:
    """
    Core HTTP client for Scrapalot Chat API.

    Provides:
    - Session management with context manager support
    - API key or JWT token authentication
    - Common HTTP methods (GET, POST, PUT, DELETE, PATCH)
    - File upload support
    - Error handling and logging
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL, timeout: int = DEFAULT_TIMEOUT, api_key: str | None = None):
        """
        Initialize the API client.

        Args:
            base_url: Base URL of the API (default: http://localhost:8090)
            timeout: Request timeout in seconds (default: 300)
            api_key: Optional API key for authentication (format: scp-xxxxxxxxxxxxxxxxxxxx)
        """
        self.base_url = base_url.rstrip("/")
        self.timeout = aiohttp.ClientTimeout(total=timeout)
        self.session: aiohttp.ClientSession | None = None
        self.auth_token: str | None = None
        self.api_key = api_key or DEFAULT_API_KEY  # Use provided API key or environment variable

    async def __aenter__(self):
        """Context manager entry - creates HTTP session"""
        self.session = aiohttp.ClientSession(timeout=self.timeout)
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit - closes HTTP session"""
        if self.session:
            await self.session.close()

    # ==================== Authentication ====================

    async def authenticate(self, username: str, password: str) -> dict[str, Any]:
        """
        Authenticate with the API and store the access token.

        Args:
            username: Username for authentication
            password: Password for authentication

        Returns:
            Authentication response with token information

        Raises:
            RuntimeError: If session not initialized
            Exception: If authentication fails
        """
        if not self.session:
            raise RuntimeError("Client session not initialized. Use 'async with' context manager.")

        # Use form data for OAuth2PasswordRequestForm
        login_data = {"username": username, "password": password}

        async with self.session.post(f"{self.base_url}/users/token", data=login_data) as response:
            if response.status == 200:
                result = await response.json()
                self.auth_token = result.get("access_token")
                logger.info("Successfully authenticated as %s", username)
                return result
            else:
                error_text = await response.text()
                # During startup, auth failures are expected until admin user is created
                # Log as debug level to reduce noise
                logger.debug("Authentication failed (may be expected during startup): %s - %s", response.status, error_text)
                raise Exception(f"Authentication failed: {response.status} - {error_text}")

    def _get_headers(self, include_content_type: bool = True) -> dict[str, str]:
        """
        Get HTTP headers with authentication.

        Supports both API key and JWT token authentication.
        API key takes precedence if both are available.

        Args:
            include_content_type: Whether to include Content-Type header

        Returns:
            Dictionary of HTTP headers
        """
        headers = {}
        if include_content_type:
            headers["Content-Type"] = "application/json"

        # API key takes precedence over JWT token
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        elif self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"

        return headers

    # ==================== Core HTTP Methods ====================

    async def get(self, endpoint: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """
        Perform GET request.

        Args:
            endpoint: API endpoint (e.g., "/workspaces")
            params: Optional query parameters

        Returns:
            JSON response as dictionary

        Raises:
            RuntimeError: If session not initialized
            Exception: If request fails
        """
        if not self.session:
            raise RuntimeError("Client session not initialized")

        url = f"{self.base_url}{endpoint}"
        async with self.session.get(url, headers=self._get_headers(), params=params) as response:
            if response.status == 200:
                return await response.json()
            else:
                error_text = await response.text()
                raise Exception(f"GET {endpoint} failed: {response.status} - {error_text}")

    async def post(
        self,
        endpoint: str,
        json_data: dict[str, Any] | None = None,
        form_data: aiohttp.FormData | None = None,
        headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        """
        Perform POST request.

        Args:
            endpoint: API endpoint
            json_data: Optional JSON payload
            form_data: Optional form data (for file uploads)
            headers: Optional extra request headers (merged with auth/content-type)

        Returns:
            JSON response as dictionary

        Raises:
            RuntimeError: If session not initialized
            Exception: If request fails
        """
        if not self.session:
            raise RuntimeError("Client session not initialized")

        url = f"{self.base_url}{endpoint}"

        # Determine headers and data based on payload type
        if form_data:
            # For form data, don't set Content-Type (let aiohttp handle it)
            request_headers = self._get_headers(include_content_type=False)
            if headers:
                request_headers.update(headers)
            async with self.session.post(url, data=form_data, headers=request_headers) as response:
                if response.status in [200, 201]:
                    return await response.json()
                else:
                    error_text = await response.text()
                    raise Exception(f"POST {endpoint} failed: {response.status} - {error_text}")
        else:
            # For JSON data
            request_headers = self._get_headers()
            if headers:
                request_headers.update(headers)
            async with self.session.post(url, json=json_data, headers=request_headers) as response:
                if response.status in [200, 201]:
                    return await response.json()
                else:
                    error_text = await response.text()
                    raise Exception(f"POST {endpoint} failed: {response.status} - {error_text}")

    async def put(self, endpoint: str, json_data: dict[str, Any]) -> dict[str, Any]:
        """
        Perform PUT request.

        Args:
            endpoint: API endpoint
            json_data: JSON payload

        Returns:
            JSON response as dictionary

        Raises:
            RuntimeError: If session not initialized
            Exception: If request fails
        """
        if not self.session:
            raise RuntimeError("Client session not initialized")

        url = f"{self.base_url}{endpoint}"
        async with self.session.put(url, json=json_data, headers=self._get_headers()) as response:
            if response.status == 200:
                return await response.json()
            else:
                error_text = await response.text()
                raise Exception(f"PUT {endpoint} failed: {response.status} - {error_text}")

    async def delete(self, endpoint: str) -> dict[str, Any]:
        """
        Perform DELETE request.

        Args:
            endpoint: API endpoint

        Returns:
            JSON response as dictionary (or empty dict for 204)

        Raises:
            RuntimeError: If session not initialized
            Exception: If request fails
        """
        if not self.session:
            raise RuntimeError("Client session not initialized")

        url = f"{self.base_url}{endpoint}"
        async with self.session.delete(url, headers=self._get_headers()) as response:
            if response.status in [200, 204]:
                if response.status == 204:
                    return {"status": "success", "message": "Resource deleted"}
                return await response.json()
            else:
                error_text = await response.text()
                raise Exception(f"DELETE {endpoint} failed: {response.status} - {error_text}")

    async def patch(self, endpoint: str, json_data: dict[str, Any]) -> dict[str, Any]:
        """
        Perform PATCH request.

        Args:
            endpoint: API endpoint
            json_data: JSON payload

        Returns:
            JSON response as dictionary

        Raises:
            RuntimeError: If session not initialized
            Exception: If request fails
        """
        if not self.session:
            raise RuntimeError("Client session not initialized")

        url = f"{self.base_url}{endpoint}"
        async with self.session.patch(url, json=json_data, headers=self._get_headers()) as response:
            if response.status == 200:
                return await response.json()
            else:
                error_text = await response.text()
                raise Exception(f"PATCH {endpoint} failed: {response.status} - {error_text}")

    # ==================== File Upload Utilities ====================

    async def upload_file(self, endpoint: str, file_path: str, additional_fields: dict[str, str] | None = None) -> dict[str, Any]:
        """
        Upload a file to the specified endpoint.

        Args:
            endpoint: API endpoint for file upload
            file_path: Path to the file to upload
            additional_fields: Optional additional form fields

        Returns:
            Upload response as dictionary

        Raises:
            FileNotFoundError: If file doesn't exist
            RuntimeError: If session not initialized
            Exception: If upload fails
        """
        if not self.session:
            raise RuntimeError("Client session not initialized")

        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        # Prepare multipart form data
        data = aiohttp.FormData()

        # Add additional fields if provided
        if additional_fields:
            for key, value in additional_fields.items():
                data.add_field(key, value)

        # Add file
        async with aiofiles.open(file_path, "rb") as f:
            file_content = await f.read()
            data.add_field("file", file_content, filename=os.path.basename(file_path))

        return await self.post(endpoint, form_data=data)

    async def upload_content(self, endpoint: str, content: str, filename: str, additional_fields: dict[str, str] | None = None) -> dict[str, Any]:
        """
        Upload text content as a file.

        Args:
            endpoint: API endpoint for file upload
            content: Text content to upload
            filename: Filename to use for the upload
            additional_fields: Optional additional form fields

        Returns:
            Upload response as dictionary

        Raises:
            RuntimeError: If session not initialized
            Exception: If upload fails
        """
        temp_path = None
        try:
            # Create temporary file with the content
            with tempfile.NamedTemporaryFile(mode="w", suffix=f"_{filename}", delete=False) as temp_file:
                temp_file.write(content)
                temp_path = temp_file.name

            # Upload the temporary file
            return await self.upload_file(endpoint, temp_path, additional_fields)

        finally:
            # Clean up temporary file
            if temp_path and os.path.exists(temp_path):
                try:
                    os.unlink(temp_path)
                except OSError as e:
                    logger.warning("Failed to delete temporary file %s: %s", temp_path, str(e))
