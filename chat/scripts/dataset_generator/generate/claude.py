"""Claude Code headless mode subprocess client.

Single responsibility: ship a prompt to ``claude -p`` and return the parsed
structured JSON output. Higher-level orchestration (chapter loops, retries,
checkpoints) lives in ``generate.qa``.
"""

from __future__ import annotations

import json
import os
import subprocess
from typing import Any

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# Default timeout for a single Claude headless invocation (seconds).
DEFAULT_TIMEOUT = 600

# Rough estimate: 1 token ≈ 4 characters for English text.
CHARS_PER_TOKEN = 4

# Maximum tokens per single Claude call — chapters larger than this are split into sub-chunks.
# ~3 000 tokens ≈ 6 pages: focused enough that Claude extracts specific concepts rather than
# sampling broadly, while large enough to capture multi-paragraph arguments coherently.
MAX_CHAPTER_TOKENS = 3_000


class ClaudeTimeoutError(RuntimeError):
    """Raised when a Claude Code headless call exceeds the timeout limit."""


# JSON schema for Claude Code structured output.
_QA_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "qa_pairs": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "answer": {"type": "string"},
                    "thinking": {"type": "string"},
                    "topics": {"type": "array", "items": {"type": "string"}},
                    "quality_score": {"type": "number", "minimum": 1, "maximum": 5},
                },
                "required": ["question", "answer", "thinking", "topics", "quality_score"],
            },
        },
        "book_summary": {"type": "string"},
        "skipped_chapters": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["qa_pairs"],
}


def estimate_tokens(text: str) -> int:
    """Estimate token count of ``text`` using a 4-chars-per-token heuristic."""
    return len(text) // CHARS_PER_TOKEN


def split_text_for_claude(text: str, max_tokens: int = MAX_CHAPTER_TOKENS) -> list[str]:
    """Split ``text`` into chunks that each fit within ``max_tokens``.

    Splits on double-newline paragraph boundaries where possible so chunks
    remain coherent. Falls back to hard character splits if a single paragraph
    exceeds the limit.
    """
    max_chars = max_tokens * CHARS_PER_TOKEN
    if len(text) <= max_chars:
        return [text]

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for para in text.split("\n\n"):
        para_len = len(para) + 2  # +2 for the \n\n separator
        if current_len + para_len > max_chars and current:
            chunks.append("\n\n".join(current))
            current = []
            current_len = 0
        if para_len > max_chars:
            # Single oversized paragraph — hard-split into pieces.
            chunks.extend(para[i : i + max_chars] for i in range(0, len(para), max_chars))
        else:
            current.append(para)
            current_len += para_len

    if current:
        chunks.append("\n\n".join(current))
    return chunks


def call_claude_headless(prompt: str, *, timeout: int = DEFAULT_TIMEOUT) -> dict | None:
    """Call Claude Code in headless mode with structured JSON output.

    Invokes ``claude -p --output-format json --json-schema <schema> --max-turns 3``.
    The prompt is passed via stdin.

    Returns the parsed ``structured_output`` dict on success, the raw response
    when no structured output is present, or ``None`` on hard failure. Raises
    :class:`ClaudeTimeoutError` if Claude does not respond within ``timeout`` seconds.
    """
    env = dict(os.environ)
    env.pop("CLAUDECODE", None)  # allow nested invocation

    process: subprocess.Popen | None = None
    try:
        process = subprocess.Popen(
            [
                "claude",
                "-p",
                "--output-format",
                "json",
                "--json-schema",
                json.dumps(_QA_SCHEMA),
                "--max-turns",
                "3",
            ],  # fmt: skip
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env,
        )
        stdout, stderr = process.communicate(input=prompt, timeout=timeout)
    except subprocess.TimeoutExpired:
        if process is not None:
            process.kill()
        raise ClaudeTimeoutError(f"Claude headless call timed out after {timeout}s") from None
    except FileNotFoundError:
        logger.error("'claude' CLI not found. Ensure Claude Code is installed and on PATH.")
        return None
    except Exception as exc:
        logger.error("Unexpected error calling Claude headless: %s", exc)
        return None

    if process.returncode != 0:
        logger.error("Claude headless exited with code %d: %s", process.returncode, stderr[:500])
        return None
    if not stdout.strip():
        logger.error("Claude headless returned empty output")
        return None

    return _parse_response(stdout)


def _parse_response(stdout: str) -> dict | None:
    """Parse the JSON envelope Claude returns and extract the structured payload."""
    try:
        result = json.loads(stdout)
    except json.JSONDecodeError as exc:
        logger.error("Failed to parse Claude headless JSON output: %s", exc)
        return None

    if not isinstance(result, dict):
        logger.debug("Claude returned non-dict: %s", type(result).__name__)
        return result

    subtype = result.get("subtype", "unknown")
    num_turns = result.get("num_turns", 0)
    logger.debug("Claude response: subtype=%s, num_turns=%d", subtype, num_turns)

    if result.get("is_error"):
        logger.error("Claude returned an error: %s", str(result.get("result", ""))[:500])
        return None

    # With --json-schema, validated data is under "structured_output".
    structured = result.get("structured_output")
    if structured:
        logger.debug("Got structured_output with %d qa_pairs", len(structured.get("qa_pairs", [])))
        return structured

    # Fallback: try parsing the text result as JSON.
    text_result = result.get("result", "")
    if isinstance(text_result, str) and text_result:
        logger.debug("No structured_output, trying to parse result text (%d chars)", len(text_result))
        try:
            return json.loads(text_result)
        except (json.JSONDecodeError, ValueError):
            logger.warning("Could not parse Claude text result as JSON")

    logger.warning("No structured_output or parseable result from Claude")
    return result
