"""Shared helpers for the anna/ scripts.

Both ``annas_archive_book_processor.py`` and ``multi_source_metadata_extractor.py``
need to:
  * read the first N pages of a PDF safely
  * invoke the ``claude`` CLI to extract title/author/year from that text
  * print unicode-safe to consoles that can't display non-ASCII

This module is the single source of truth for those concerns. Both call sites
adapt the returned dict locally (e.g. tagging a ``source`` field).
"""

from __future__ import annotations

from pathlib import Path
import re
import subprocess

# ---------------------------------------------------------------------------
# Unicode-safe printing
# ---------------------------------------------------------------------------


def safe_print(text: str) -> None:
    """Print ``text`` falling back to ASCII when the console can't encode it."""
    try:
        print(text)
    except UnicodeEncodeError:
        print(text.encode("ascii", errors="replace").decode("ascii"))


# ---------------------------------------------------------------------------
# PDF helpers
# ---------------------------------------------------------------------------


def read_pdf_first_pages_text(pdf_path: Path, max_pages: int = 3) -> str:
    """Return concatenated text from the first ``max_pages`` pages of ``pdf_path``.

    Errors are swallowed silently: returns ``""`` if the PDF cannot be opened
    or yields no text. Per-page extraction failures are skipped individually.
    """
    try:
        from pypdf import PdfReader

        reader = PdfReader(pdf_path)
    except Exception:
        return ""

    chunks: list[str] = []
    for i in range(min(max_pages, len(reader.pages))):
        try:
            chunks.append(reader.pages[i].extract_text() or "")
        except Exception:
            continue
    return "\n".join(chunks)


# ---------------------------------------------------------------------------
# Year / ISBN regex helpers
# ---------------------------------------------------------------------------


_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")


def parse_year_from_string(
    text: str,
    *,
    min_year: int = 1900,
    max_year: int = 2030,
) -> str | None:
    """Return the first 4-digit year inside ``[min_year, max_year]`` or ``None``."""
    for match in _YEAR_RE.finditer(text or ""):
        year = int(match.group())
        if min_year <= year <= max_year:
            return str(year)
    return None


# ---------------------------------------------------------------------------
# Claude CLI metadata extraction
# ---------------------------------------------------------------------------


_DEFAULT_CLAUDE_PROMPT = (
    "Extract book metadata from this text. Respond with EXACTLY this format:\n"
    "TITLE: [the book title]\n"
    "AUTHOR: [the author name]\n"
    "YEAR: [publication year as 4-digit number]\n\n"
    "If you cannot find a field, write 'Unknown'.\n\n"
    "Book text:\n{pdf_text}"
)

_CLAUDE_UNKNOWN_TOKENS = {"unknown", "n/a", "none", ""}


def _parse_claude_response(stdout: str) -> dict | None:
    """Parse the ``TITLE:/AUTHOR:/YEAR:`` block from Claude's CLI stdout.

    Returns a ``{"title", "author", "year"}`` dict with ``None`` for missing
    fields, or ``None`` if no usable title is present.
    """
    result: dict[str, str | None] = {"title": None, "author": None, "year": None}

    title_match = re.search(r"^TITLE:\s*(.+)$", stdout, re.MULTILINE | re.IGNORECASE)
    if title_match:
        title = title_match.group(1).strip()
        if title.lower() not in _CLAUDE_UNKNOWN_TOKENS:
            result["title"] = title

    author_match = re.search(r"^AUTHOR:\s*(.+)$", stdout, re.MULTILINE | re.IGNORECASE)
    if author_match:
        author = author_match.group(1).strip()
        if author.lower() not in _CLAUDE_UNKNOWN_TOKENS:
            result["author"] = author

    year_match = re.search(r"^YEAR:\s*(\d{4})", stdout, re.MULTILINE | re.IGNORECASE)
    if year_match:
        year = int(year_match.group(1))
        if 1900 <= year <= 2030:
            result["year"] = str(year)

    return result if result["title"] else None


def claude_extract_metadata(
    pdf_path: Path,
    *,
    max_pages: int = 3,
    max_chars: int = 10000,
    prompt_template: str = _DEFAULT_CLAUDE_PROMPT,
    timeout: int = 45,
    on_message: callable | None = None,
) -> dict | None:
    """Invoke ``claude -p ...`` to extract metadata from the first pages of a PDF.

    Returns a ``{"title", "author", "year"}`` dict (with ``None`` for missing
    fields) on success, or ``None`` if Claude is unavailable, times out, or
    cannot find a title. ``on_message`` (if provided) is called with status
    strings so callers can route them through their preferred print helper.
    """
    log = on_message or safe_print

    text = read_pdf_first_pages_text(pdf_path, max_pages=max_pages)
    if not text:
        log("  Error extracting PDF text")
        return None
    if len(text) > max_chars:
        text = text[:max_chars] + "\n... [text truncated]"

    try:
        result = subprocess.run(
            ["claude", "-p", prompt_template.format(pdf_text=text)],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        log(f"  Claude timeout ({timeout}s)")
        return None
    except FileNotFoundError:
        log("  Claude Code CLI not available")
        return None
    except Exception as exc:
        log(f"  Claude error: {str(exc)[:40]}")
        return None

    if result.returncode != 0 or not result.stdout:
        return None
    return _parse_claude_response(result.stdout)
