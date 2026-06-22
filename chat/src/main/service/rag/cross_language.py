"""
Cross-language query translation for bilingual RAG retrieval.

When a user asks in Croatian but documents are in English (or vice versa),
retrieval quality drops because embeddings don't align across languages.
This module detects query language and generates a translated version,
allowing the retriever to search with both languages.

Latency: ~1s for LLM translation (only when cross-language needed).
Cost: minimal (short query translation, ~50 tokens).
"""

# noinspection PyUnresolvedReferences
from langdetect import LangDetectException, detect

from src.main.utils.config.loader import resolved_config
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Minimum query length for reliable language detection
_MIN_DETECT_LENGTH = 10


def detect_language(text: str) -> str | None:
    """Detect language of text using langdetect. Returns ISO 639-1 code or None."""
    if not text or len(text.strip()) < _MIN_DETECT_LENGTH:
        return None
    try:
        return detect(text)
    except LangDetectException:
        return None


def is_cross_language_needed(user_language: str = "en") -> bool:
    """Determine if cross-language translation is needed based on user's UI language.

    Automatically enabled when user's UI language is not English —
    no global config flag needed. User language comes from user_settings
    (synced via Redis Streams from Kotlin).

    When called without user_language (from retriever), falls back to
    detecting query language directly — if query is non-English and English
    is in target languages, translation is needed.
    """
    return bool(user_language) and user_language != "en"


def get_target_languages() -> list[str]:
    """Get configured target languages for cross-language retrieval."""
    cl_config = resolved_config.get("defaults", {}).get("cross_language", {})
    return cl_config.get("languages", ["hr", "en"])


async def translate_query_if_needed(query: str, user_language: str = "en") -> tuple[str, str | None]:
    """Detect query language and translate if user's UI is non-English.

    Automatically activates when user_language != "en" (from user_settings).
    No global config flag needed.

    Returns:
        Tuple of (original_query, translated_query or None).
        translated_query is None when no translation is needed.
    """
    # Auto-detect: if user_language not provided, detect from query text
    if user_language == "en":
        # Check if query itself is non-English
        detected = detect_language(query)
        if not detected or detected == "en":
            return query, None
        # Query is non-English, proceed with translation
    elif not is_cross_language_needed(user_language):
        return query, None

    detected_lang = detect_language(query)
    if not detected_lang:
        return query, None

    target_languages = get_target_languages()
    # langdetect routinely confuses Croatian with the other South-Slavic languages
    # (sl/bs/sr/mk) on short queries — e.g. "Kako je tlo povezano s plodoredom?"
    # detects as 'sl'. Treat the whole family as the configured non-English language
    # so a misdetected query still gets translated: the embedding model is
    # English-only, so ANY non-English query needs an English pass for retrieval.
    _south_slavic = {"hr", "sl", "bs", "sr", "mk"}
    if detected_lang not in target_languages:
        if detected_lang in _south_slavic and "en" in target_languages and "hr" in target_languages:
            detected_lang = "hr"
        else:
            return query, None

    # Determine translation target: if query is HR, translate to EN and vice versa
    other_langs = [lang for lang in target_languages if lang != detected_lang]
    if not other_langs:
        return query, None

    target_lang = other_langs[0]
    lang_names = {"hr": "Croatian", "en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian"}
    target_name = lang_names.get(target_lang, target_lang)
    source_name = lang_names.get(detected_lang, detected_lang)

    logger.info("Cross-language: detected %s, translating to %s", source_name, target_name)

    try:
        # Translate with the SYSTEM agent model (built below — the `llm` arg is
        # not required and was never used here). The previous `if llm is None:
        # return` guard silently disabled the entire cross-language pipeline,
        # because every caller invokes this without passing an llm. Retrieval
        # then ran the raw non-English query against English embeddings, which
        # is exactly the cross-lingual miss this module exists to prevent.
        from pydantic_ai import Agent

        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        agent_config = get_system_agent_model(agent_type="agentic_rag")
        model = agent_config.get_pydantic_ai_model()

        translator = Agent(
            model=model,
            system_prompt=(
                f"Translate the following search query from {source_name} to {target_name}. "
                "Keep technical terms, proper nouns, and acronyms unchanged. "
                "Output ONLY the translated query, nothing else."
            ),
        )

        result = await translator.run(query)
        translated = result.output.strip() if result and result.output else None

        if translated and translated != query:
            logger.info("Cross-language translation: '%s' → '%s'", query[:50], (translated or "")[:50])
            return query, translated

        return query, None

    except Exception as e:
        logger.warning("Cross-language translation failed: %s", str(e))
        return query, None
