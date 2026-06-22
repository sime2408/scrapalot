"""
Central mapping from Python exceptions / error strings to camelCase
status codes that the frontend translates via i18n
(`knowledge.uploader.<code>`).

Convention (CLAUDE.md rule #3): backend never persists or emits raw
English error sentences. Every `processing_error` / `jobs.error_message`
write goes through `to_status_code()` so the column always holds either
a camelCase code OR the original string when nothing matched (so
diagnostic info from third-party libraries is not lost).

Adding a new code requires:
    1. one branch here
    2. matching key in `scrapalot-ui/src/i18n/locales/{en,hr}/translation.json`
       under `knowledge.uploader.<code>`
"""

from __future__ import annotations

import re

# Parametrized code pattern: `lowExtractionYield:1:2:3`
_CODE_PARAMETRIZED = re.compile(r"^[a-z][a-zA-Z0-9_]*(:[^:]+)+$")


def to_status_code(ex_or_msg: BaseException | str | None) -> str:
    """Map an exception or a free-form error string to a status code.

    Returns the matched code if recognised; otherwise truncates and
    returns the raw string so admins still see novel errors. Always
    returns a non-empty string suitable for the `processing_error`
    column.
    """
    if ex_or_msg is None:
        return "errorUnknown"

    msg = str(ex_or_msg)
    if not msg:
        return "errorUnknown"

    # Already a plain camelCase code — return as-is.
    if msg.isidentifier() and msg[0].islower() and msg.isascii():
        return msg

    # Already a parametrized code (`lowExtractionYield:1:2:3`) — return as-is.
    if _CODE_PARAMETRIZED.match(msg):
        return msg

    # Celery / billiard timeouts.
    lowered = msg.lower()
    if "softtimelimitexceeded" in lowered or "soft time limit" in lowered:
        return "errorSoftTimeLimit"
    if "timelimitexceeded" in lowered or "hard time limit" in lowered:
        return "errorHardTimeLimit"

    # Document pipeline raises.
    if "scanned pdf" in lowered or "ocr deferred" in lowered or "ocr required" in lowered:
        return "errorScannedPdfOcrDeferred"
    if "worker died" in lowered or "job 0 did not report" in lowered or "subprocess died" in lowered:
        # "Job 0 did not report an exception." is SubprocessJobClient's
        # default error string when the spawned subprocess is SIGTERM /
        # SIGKILL'd from the outside (container restart, OOM-kill, hard
        # time-limit, parallel-CI redeploy mid-Cat-F) and never had a
        # chance to write a Python traceback to its mp.Queue. Without
        # this branch the raw English sentence lands in
        # `documents.processing_error` and bypasses the i18n layer in
        # the frontend's `translateProcessingError()`.
        return "errorWorkerDied"
    if "task never picked up" in lowered:
        return "errorTaskNeverPickedUp"
    if "entity extraction interrupted" in lowered:
        return "errorEntityExtractionInterrupted"
    if "file not found" in lowered or "no such file" in lowered or "source file missing" in lowered:
        return "errorFileNotFound"
    if "drm" in lowered or "drm-protected" in lowered:
        return "errorDrmProtected"
    if "access denied" in lowered or "permission denied" in lowered:
        return "errorWorkspacePermission"
    if "not valid" in lowered and "input document" in lowered:
        return "errorInvalidDocument"
    if "pdf_over_1000_pages" in lowered or "pdf over 1000" in lowered:
        return "pdf_over_1000_pages"

    # Memory / quota exhaustion.
    if "memorypooloutofmemoryerror" in lowered or "outofmemoryerror" in lowered or "out of memory" in lowered:
        return "errorOutOfMemory"
    if "quota" in lowered or "rate limit" in lowered or "429" in lowered or "insufficient_quota" in lowered:
        return "errorQuotaExhausted"

    # Empty document / no extractable text.
    if "no text layer" in lowered or "no chunks" in lowered or "empty document" in lowered:
        return "errorEmptyDocument"

    # Unknown — keep the raw text (truncated) so admins can diagnose.
    # Frontend's translateProcessingError() will see this is not a
    # code (has spaces/punct) and pass it through unchanged.
    return msg[:500]
