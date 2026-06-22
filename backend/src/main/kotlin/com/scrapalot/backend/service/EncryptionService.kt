package com.scrapalot.backend.service

import mu.KotlinLogging
import org.springframework.beans.factory.annotation.Value
import org.springframework.stereotype.Service
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

private val logger = KotlinLogging.logger {}

/**
 * Reversible AES-256-GCM encryption for secrets that must be retrievable
 * (currently MCP integration auth tokens, which Python decrypts to call the
 * remote server).
 *
 * Wire format of an encrypted value: `enc:v1:` + Base64(iv[12] || ciphertext+tag).
 * Java's GCM `doFinal` appends the 16-byte auth tag to the ciphertext, which is
 * exactly what Python's `cryptography` AESGCM expects — so the two sides are
 * binary-compatible as long as they share the same key.
 *
 * The key comes from `mcp.encryption-key` (env `MCP_ENCRYPTION_KEY`), a
 * Base64-encoded 32-byte key. When it is missing or invalid the service
 * degrades to a no-op (stores plaintext, logs a warning once) so local/dev and
 * CI without the secret still function — never silently fail a request.
 */
@Service
class EncryptionService(
    @param:Value("\${mcp.encryption-key:}") private val encryptionKeyBase64: String
) {
    companion object {
        const val PREFIX = "enc:v1:"
        private const val IV_LENGTH = 12
        private const val TAG_BITS = 128
        private const val ALGORITHM = "AES/GCM/NoPadding"
    }

    private val keyBytes: ByteArray? =
        runCatching {
            if (encryptionKeyBase64.isBlank()) return@runCatching null
            val decoded = Base64.getDecoder().decode(encryptionKeyBase64.trim())
            require(decoded.size == 32) { "MCP_ENCRYPTION_KEY must decode to 32 bytes, got ${decoded.size}" }
            decoded
        }.getOrElse {
            logger.error(it) { "Invalid MCP_ENCRYPTION_KEY — encryption disabled, secrets will be stored as plaintext" }
            null
        }

    val enabled: Boolean get() = keyBytes != null

    init {
        if (!enabled) {
            logger.warn { "MCP_ENCRYPTION_KEY not set — MCP auth tokens will be stored UNENCRYPTED (set the env var in production)" }
        }
    }

    /** Encrypt a plaintext secret. Returns null for null input; returns the input unchanged when encryption is disabled. */
    fun encrypt(plaintext: String?): String? {
        if (plaintext == null) return null
        val key = keyBytes ?: return plaintext
        return try {
            val iv = ByteArray(IV_LENGTH).also { SecureRandom().nextBytes(it) }
            val cipher = Cipher.getInstance(ALGORITHM)
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
            val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            PREFIX + Base64.getEncoder().encodeToString(iv + ciphertext)
        } catch (e: Exception) {
            logger.error(e) { "Failed to encrypt secret — storing plaintext as fallback" }
            plaintext
        }
    }

    /** Decrypt a stored secret. Values without the `enc:v1:` prefix are returned unchanged (plaintext or already decrypted). */
    fun decrypt(stored: String?): String? {
        if (stored == null || !stored.startsWith(PREFIX)) return stored
        val key =
            keyBytes ?: run {
                logger.error { "Encrypted secret encountered but no key configured — cannot decrypt" }
                return null
            }
        return try {
            val raw = Base64.getDecoder().decode(stored.removePrefix(PREFIX))
            val iv = raw.copyOfRange(0, IV_LENGTH)
            val ciphertext = raw.copyOfRange(IV_LENGTH, raw.size)
            val cipher = Cipher.getInstance(ALGORITHM)
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (e: Exception) {
            logger.error(e) { "Failed to decrypt secret" }
            null
        }
    }
}
