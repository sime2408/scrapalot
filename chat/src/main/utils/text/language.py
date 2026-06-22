"""Shared response-language directive helpers.

A single source of truth for the instruction that pins an LLM's output (and,
where the trace is user-visible, its reasoning) to the user's language. Several
call sites used to carry their own near-duplicate ``_language_instruction`` /
``_language_name`` / ``_LANGUAGE_NAMES`` copies; some lacked the Croatian
anti-Serbian-drift guard, some dropped the instruction entirely for languages
missing from a short local map. This module unifies them.

Pure string transforms — no DB, LLM, or app dependency — so any prompt builder
can import it without circular-import risk.
"""

from __future__ import annotations

_HR_DIACRITICS = set("čćžšđČĆŽŠĐ")

# Canonical ISO 639-1 → English language name map (union of the previously
# scattered copies). Unknown codes fall back to the raw code so a new locale
# still produces a usable instruction instead of silently dropping it.
LANGUAGE_NAMES: dict[str, str] = {
    "hr": "Croatian",
    "en": "English",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "nl": "Dutch",
    "pl": "Polish",
    "cs": "Czech",
    "sk": "Slovak",
    "sl": "Slovenian",
    "sr": "Serbian",
    "bs": "Bosnian",
    "mk": "Macedonian",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "ru": "Russian",
    "ar": "Arabic",
    "tr": "Turkish",
    "hi": "Hindi",
}


def looks_croatian(text: str | None) -> bool:
    """Heuristic: prompt contains South Slavic diacritics → assume hr.

    Used as a fallback when the request.language flag is unset/en but the user
    is clearly writing in Croatian. Without this guard the LLM has no signal to
    pick Croatian over Serbian and routinely drifts to ekavica.
    """
    if not text:
        return False
    return any(ch in _HR_DIACRITICS for ch in text)


def language_name(code: str | None) -> str:
    """English name for an ISO 639-1 code; falls back to the raw code."""
    return LANGUAGE_NAMES.get((code or "").lower(), code or "")


def language_directive(language_code: str | None, prompt: str | None = None) -> str:
    """Build a ``write in X`` instruction for a chat/synthesis prompt.

    Why this exists: gpt-4o-mini (and other models) answering a Croatian prompt
    routinely drift into ekavica / Serbian orthography (``sledeći``, ``Takođe``,
    ``biblioteka``) when nothing pins the dialect. For Croatian we append an
    explicit anti-Serbian guard.

    When ``language_code`` is unset / "en" but the prompt itself carries South
    Slavic diacritics, fall back to the hr directive so we still get proper
    Croatian even if the UI never propagated the locale into the request.

    Returns an empty string for English (no instruction needed).
    """
    code = (language_code or "en").lower()
    if code != "hr" and looks_croatian(prompt):
        code = "hr"
    if code == "hr":
        return (
            "Odgovori na hrvatskom standardnom jeziku (ijekavica). "
            "NE koristi srpske oblike — piši 'sljedeći' (ne 'sledeći'), "
            "'Također' (ne 'Takođe'), 'knjižnica' (ne 'biblioteka'), "
            "'elektronički' (ne 'elektronski'), 'tisuća' (ne 'hiljada'), "
            "'tjedan' (ne 'sedmica'), 'dijete' (ne 'dete')."
        )
    if code == "en":
        return ""
    name = LANGUAGE_NAMES.get(code, code)
    return f"You MUST write the entire answer in {name}, regardless of the language of the question or the sources."
