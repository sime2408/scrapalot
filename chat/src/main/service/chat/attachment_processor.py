"""Process chat attachments (documents, images, YouTube) into prompt context."""

import re

from src.main.dto.chat import ChatAttachmentDTO
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

MAX_DOCUMENT_CHARS = 100_000
MAX_TRANSCRIPT_CHARS = 50_000


def _fetch_youtube_metadata(video_id: str) -> dict:
    """Fetch video metadata via YouTube oEmbed (free, no API key)."""
    import json
    import urllib.request

    try:
        oembed_url = "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=%s&format=json" % video_id
        data = json.loads(urllib.request.urlopen(oembed_url, timeout=5).read())
        return {
            "title": data.get("title", ""),
            "author": data.get("author_name", ""),
            "author_url": data.get("author_url", ""),
            "thumbnail_url": data.get("thumbnail_url", ""),
        }
    except Exception as e:
        logger.warning("YouTube oEmbed failed for %s: %s", video_id, str(e))
        return {}


def _fetch_youtube_transcript(
    url: str,
    language: str = "en",
    include_timestamps: bool = True,
    include_metadata: bool = False,
) -> str:
    """Fetch transcript for a YouTube video.

    Tries youtube-transcript-api first, falls back to yt-dlp subtitle extraction.
    """
    video_id = _extract_video_id(url)
    if not video_id:
        raise ValueError("Could not extract video ID from URL: %s" % url)

    # Try youtube-transcript-api (v1.x API)
    text = _try_youtube_transcript_api(video_id, language=language, include_timestamps=include_timestamps)
    if text:
        parts = []
        if include_metadata:
            meta = _fetch_youtube_metadata(video_id)
            if meta:
                if meta.get("title"):
                    parts.append("Title: %s" % meta["title"])
                if meta.get("author"):
                    parts.append("Author: %s" % meta["author"])
                parts.append("")
        parts.append(text)
        return "\n".join(parts)

    # Fallback: yt-dlp subtitle extraction
    text = _try_yt_dlp_subtitles(video_id, language=language)
    if text:
        return text

    raise ValueError(
        "Could not fetch transcript for video %s. "
        "YouTube may be blocking requests from this server's IP (cloud provider). "
        "Try pasting the transcript text directly in the Documents tab instead." % video_id
    )


def _get_proxy_config():
    """Load optional YouTube proxy from config.yaml."""
    try:
        from src.main.utils.config.loader import resolved_config

        proxy_url = resolved_config.get("youtube", {}).get("proxy_url")
        if proxy_url:
            # noinspection PyUnresolvedReferences
            from youtube_transcript_api.proxies import GenericProxyConfig

            return GenericProxyConfig(https_url=proxy_url)
    except Exception as e:
        logger.debug("Suppressed exception: %s", e)
    return None


def _try_youtube_transcript_api(
    video_id: str,
    language: str = "en",
    include_timestamps: bool = True,
) -> str | None:
    """Attempt transcript fetch via youtube-transcript-api v1.x."""
    try:
        # noinspection PyUnresolvedReferences
        from youtube_transcript_api import YouTubeTranscriptApi

        proxy_config = _get_proxy_config()
        api = YouTubeTranscriptApi(proxy_config=proxy_config) if proxy_config else YouTubeTranscriptApi()
        transcript_list = api.list(video_id)

        # Try requested language first, then variants, then any available
        transcript = None
        lang_variants = [language, "%s-US" % language, "%s-GB" % language]
        for t in transcript_list:
            if t.language_code in lang_variants:
                transcript = t
                break
        if transcript is None:
            # Try auto-generated version of requested language
            for t in transcript_list:
                if t.language_code.startswith(language) and t.is_generated:
                    transcript = t
                    break
        if transcript is None:
            # Fall back to any available
            transcripts = list(transcript_list)
            if transcripts:
                transcript = transcripts[0]

        if transcript is None:
            return None

        # noinspection PyUnresolvedReferences
        entries = transcript.fetch()

        if include_timestamps:
            lines = []
            for snippet in entries:
                if hasattr(snippet, "text") and hasattr(snippet, "start"):
                    minutes = int(snippet.start // 60)
                    seconds = int(snippet.start % 60)
                    lines.append("[%d:%02d] %s" % (minutes, seconds, snippet.text))
                elif isinstance(snippet, dict) and snippet.get("text"):
                    start = snippet.get("start", 0)
                    minutes = int(start // 60)
                    seconds = int(start % 60)
                    lines.append("[%d:%02d] %s" % (minutes, seconds, snippet["text"]))
            text = "\n".join(lines)
        else:
            text = " ".join(snippet.text for snippet in entries if hasattr(snippet, "text"))
            if not text:
                text = " ".join(e.get("text", "") for e in entries if isinstance(e, dict))

        if text and len(text) > MAX_TRANSCRIPT_CHARS:
            text = text[:MAX_TRANSCRIPT_CHARS] + "\n\n[... transcript truncated]"

        return text if text else None
    except Exception as e:
        logger.warning("youtube-transcript-api failed for %s: %s", video_id, str(e))
        return None


def _try_yt_dlp_subtitles(video_id: str, language: str = "en") -> str | None:
    """Attempt subtitle extraction via yt-dlp (fallback)."""
    try:
        import json
        import os
        import subprocess
        import tempfile

        sub_langs = "%s,en,hr,de,fr,es" % language if language != "en" else "en,hr,de,fr,es"
        with tempfile.TemporaryDirectory() as tmpdir:
            subprocess.run(
                [
                    "yt-dlp",
                    "--skip-download",
                    "--write-auto-sub",
                    "--write-sub",
                    "--sub-lang",
                    sub_langs,
                    "--sub-format",
                    "json3",
                    "--output",
                    os.path.join(tmpdir, "%(id)s"),
                    "https://www.youtube.com/watch?v=%s" % video_id,
                ],
                capture_output=True,
                check=False,  # tolerate yt-dlp failures — we probe tmpdir for subtitle files below
                text=True,
                timeout=30,
            )

            # Find any downloaded subtitle file
            for fname in os.listdir(tmpdir):
                if fname.endswith(".json3"):
                    with open(os.path.join(tmpdir, fname)) as f:
                        data = json.load(f)
                    events = data.get("events", [])
                    parts = []
                    for event in events:
                        segs = event.get("segs", [])
                        for seg in segs:
                            t = seg.get("utf8", "").strip()
                            if t and t != "\n":
                                parts.append(t)
                    text = " ".join(parts)
                    if text and len(text) > MAX_TRANSCRIPT_CHARS:
                        text = text[:MAX_TRANSCRIPT_CHARS] + "\n\n[... transcript truncated]"
                    return text if text else None

        return None
    except Exception as e:
        logger.warning("yt-dlp subtitle extraction failed for %s: %s", video_id, str(e))
        return None


def _extract_video_id(url: str) -> str | None:
    match = re.search(r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/shorts/)([\w-]+)", url)
    return match.group(1) if match else None


def process_attachments(attachments: list[ChatAttachmentDTO]) -> tuple[str, list]:
    """Process attachments and return (context_text, image_attachments).

    Returns:
        context_text: Text to prepend to the prompt (from documents and YouTube)
        image_attachments: List of image attachment dicts for vision models
    """
    if not attachments:
        return "", []

    context_parts = []
    image_attachments = []

    for att in attachments:
        if att.type == "document":
            content = att.content
            if len(content) > MAX_DOCUMENT_CHARS:
                content = content[:MAX_DOCUMENT_CHARS] + "\n\n[... document truncated]"
            context_parts.append(f"[Attached Document: {att.filename}]\n{content}\n[End of Document]")
            logger.info("Processed document attachment: %s (%d chars)", att.filename, len(content))

        elif att.type == "youtube":
            try:
                transcript = _fetch_youtube_transcript(att.content)
                context_parts.append(f"[YouTube Transcript: {att.filename}]\n{transcript}\n[End of Transcript]")
                logger.info("Fetched YouTube transcript: %s (%d chars)", att.filename, len(transcript))
            except Exception as e:
                context_parts.append(f"[YouTube Transcript Error: {att.filename} - {e!s}]")
                logger.warning("Failed to fetch YouTube transcript for %s: %s", att.filename, str(e))

        elif att.type == "image":
            image_attachments.append(
                {
                    "filename": att.filename,
                    "content": att.content,
                    "mime_type": att.mime_type,
                }
            )
            logger.info("Processed image attachment: %s", att.filename)

    context_text = "\n\n".join(context_parts)
    return context_text, image_attachments


def augment_prompt_with_attachments(prompt: str, attachments: list[ChatAttachmentDTO]) -> str:
    """Augment the prompt with document/YouTube context. Images are handled separately."""
    context_text, _ = process_attachments(attachments)
    if not context_text:
        return prompt
    return f"{context_text}\n\n---\nUser question: {prompt}"
