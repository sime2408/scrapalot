"""
Integration tests for the per-user MCP integration plumbing (Python side).

Covers the shared-key crypto, the Redis-cache upsert/delete against the real
mcp_servers replica table, and the per-request toolset builder — the pieces the
chat agent relies on. No mocks: real DB session, real pydantic_ai MCP toolset
construction.
"""

import base64
import secrets
from uuid import uuid4

import pytest

from src.main.config.database import SessionLocal


@pytest.mark.integration
def test_mcp_crypto_roundtrip(monkeypatch):
    from src.main.utils.security import mcp_crypto

    key = base64.b64encode(secrets.token_bytes(32)).decode()
    monkeypatch.setenv("MCP_ENCRYPTION_KEY", key)

    plain = "super-secret-bearer-token"
    enc = mcp_crypto.encrypt_secret(plain)
    assert enc is not None and enc.startswith("enc:v1:")
    assert enc != plain
    assert mcp_crypto.decrypt_secret(enc) == plain

    # Plaintext (no prefix) passes through unchanged in both directions.
    assert mcp_crypto.decrypt_secret("not-encrypted") == "not-encrypted"
    assert mcp_crypto.decrypt_secret(None) is None


@pytest.mark.integration
def test_mcp_cache_and_toolset_build(monkeypatch):
    from pydantic_ai.mcp import MCPServerStreamableHTTP

    from src.main.service.agents.mcp_toolsets import build_mcp_toolsets
    from src.main.service.mcp_server_cache import delete_mcp_server, upsert_mcp_server
    from src.main.utils.security.mcp_crypto import encrypt_secret

    key = base64.b64encode(secrets.token_bytes(32)).decode()
    monkeypatch.setenv("MCP_ENCRYPTION_KEY", key)

    user_id = uuid4()
    server_id = uuid4()
    enc_token = encrypt_secret("bearer-xyz")

    db = SessionLocal()
    try:
        # Enabled server → exactly one HTTP toolset with the sanitized prefix.
        upsert_mcp_server(
            db=db,
            server_id=server_id,
            user_id=user_id,
            name="Pytest MCP",
            transport="http",
            url="https://example.com/mcp",
            auth_token=enc_token,
            headers={"X-Test": "1"},
            enabled=True,
            tool_prefix="probe",
        )
        toolsets = build_mcp_toolsets(db, str(user_id))
        assert len(toolsets) == 1
        assert isinstance(toolsets[0], MCPServerStreamableHTTP)
        assert getattr(toolsets[0], "tool_prefix", None) == "probe"

        # Disabled server → not attached.
        upsert_mcp_server(
            db=db,
            server_id=server_id,
            user_id=user_id,
            name="Pytest MCP",
            transport="http",
            url="https://example.com/mcp",
            auth_token=enc_token,
            headers=None,
            enabled=False,
            tool_prefix="probe",
        )
        assert build_mcp_toolsets(db, str(user_id)) == []

        # A different user sees nothing.
        assert build_mcp_toolsets(db, str(uuid4())) == []
    finally:
        delete_mcp_server(db, server_id)
        db.close()
