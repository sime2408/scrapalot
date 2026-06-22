"""
Shared-key encryption for MCP integration secrets (auth tokens).

Binary-compatible with the Kotlin `EncryptionService` (AES-256-GCM): the wire
format is `enc:v1:` + base64(iv[12] || ciphertext+tag). Java's GCM appends the
16-byte auth tag to the ciphertext, which is exactly what `cryptography`'s
AESGCM expects, so both sides interoperate given the same key.

The key comes from `MCP_ENCRYPTION_KEY` (a base64-encoded 32-byte key). When it
is missing, decryption of a plaintext value is a no-op; decryption of an
encrypted value returns None (and logs an error) so a misconfigured deployment
fails closed rather than leaking a broken token.
"""

import base64
import os

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

PREFIX = "enc:v1:"
_IV_LENGTH = 12


def _load_key() -> bytes | None:
    raw = os.getenv("MCP_ENCRYPTION_KEY", "").strip()
    if not raw:
        return None
    try:
        key = base64.b64decode(raw)
        if len(key) != 32:
            logger.error("MCP_ENCRYPTION_KEY must decode to 32 bytes, got %d — encryption disabled", len(key))
            return None
        return key
    except Exception as e:
        logger.error("Invalid MCP_ENCRYPTION_KEY (not valid base64): %s", e)
        return None


def is_encrypted(value: str | None) -> bool:
    return bool(value) and value.startswith(PREFIX)


def decrypt_secret(stored: str | None) -> str | None:
    """Decrypt a stored secret. Plaintext (no enc:v1: prefix) is returned unchanged."""
    if not stored or not stored.startswith(PREFIX):
        return stored
    key = _load_key()
    if key is None:
        logger.error("Encrypted MCP secret encountered but MCP_ENCRYPTION_KEY is unset — cannot decrypt")
        return None
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        raw = base64.b64decode(stored[len(PREFIX) :])
        iv, ct = raw[:_IV_LENGTH], raw[_IV_LENGTH:]
        return AESGCM(key).decrypt(iv, ct, None).decode("utf-8")
    except Exception as e:
        logger.error("Failed to decrypt MCP secret: %s", e)
        return None


def encrypt_secret(plaintext: str | None) -> str | None:
    """Encrypt a secret in the Kotlin-compatible format. Returns the input unchanged when no key is set.

    Primarily for tests / Python-side round-trips; production secrets are
    encrypted by the Kotlin backend.
    """
    if plaintext is None:
        return None
    key = _load_key()
    if key is None:
        return plaintext
    try:
        import secrets

        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        iv = secrets.token_bytes(_IV_LENGTH)
        ct = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
        return PREFIX + base64.b64encode(iv + ct).decode("ascii")
    except Exception as e:
        logger.error("Failed to encrypt MCP secret: %s", e)
        return plaintext
