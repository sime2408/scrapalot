"""Generate follow-up question suggestions based on document summaries."""

import json

from sqlalchemy import text

from src.main.config.database import SessionLocal
from src.main.dto.streaming import SuggestionPacket
from src.main.service.streaming.packet_emitter import PacketEmitter
from src.main.utils.config.loader import resolved_prompts
from src.main.utils.core.logger import get_logger
from src.main.utils.llm.agent_model_utils import get_system_agent_model

logger = get_logger(__name__)

MAX_SUMMARY_CHARS = 8000


async def generate_follow_up_suggestions(
    document_id: str,
    user_query: str,
    ai_answer_preview: str,
    emitter: PacketEmitter,
    counter: list[int],
) -> str | None:
    """Generate 3 follow-up questions from document summaries.

    Returns the emitted packet JSON string, or None if generation fails.
    Only called when exactly 1 document was @-mentioned.
    """
    try:
        db = SessionLocal()
        try:
            # Fetch book + chapter summaries for this document
            result = db.execute(
                text("""
                    SELECT summary_type, chapter_title, summary_text
                    FROM document_summaries
                    WHERE document_id = :doc_id
                    ORDER BY summary_type DESC, chapter_index ASC
                """),
                {"doc_id": document_id},
            )
            rows = result.fetchall()

            # Build summary context (book first, then chapters)
            summary_parts = []
            doc_title = ""
            total_chars = 0
            for row in rows:
                stype, chapter_title, summary_text = row[0], row[1], row[2]
                if stype == "book":
                    doc_title = chapter_title or ""
                    entry = "Book Summary:\n%s" % summary_text
                else:
                    entry = "Chapter: {}\n{}".format(chapter_title or "Untitled", summary_text)

                if total_chars + len(entry) > MAX_SUMMARY_CHARS:
                    break
                summary_parts.append(entry)
                total_chars += len(entry)

            # Fallback: if no summaries, grab top embedding chunks for context
            if not summary_parts:
                logger.info(
                    "No summaries for document %s (rows=%d), using top embedding chunks as fallback",
                    document_id,
                    len(rows),
                )
                chunk_result = db.execute(
                    text("""
                        SELECT LEFT(e.document, 500)
                        FROM langchain_pg_embedding e
                        WHERE e.cmetadata->>'document_id' = :doc_id
                        ORDER BY e.cmetadata->>'chunk_index' ASC
                        LIMIT 5
                    """),
                    {"doc_id": document_id},
                )
                chunk_rows = chunk_result.fetchall()
                logger.info("Fallback chunks found: %d for document %s", len(chunk_rows), document_id)
                for crow in chunk_rows:
                    if crow[0]:
                        summary_parts.append(crow[0])
                        total_chars += len(crow[0])

            if not summary_parts:
                logger.info("No summaries or chunks found for document %s, skipping suggestions", document_id)
                return None

            # Get document filename as title
            if not doc_title:
                doc_result = db.execute(
                    text("SELECT filename FROM documents WHERE id = :doc_id"),
                    {"doc_id": document_id},
                )
                doc_row = doc_result.fetchone()
                if doc_row:
                    doc_title = doc_row[0] or ""
        finally:
            db.close()

        summary_context = "\n\n".join(summary_parts)

        # Get prompt from prompts.yaml
        prompt_template = resolved_prompts.get("follow_up_suggestions", {}).get("prompt", "")
        if not prompt_template:
            logger.warning("follow_up_suggestions prompt not found in prompts.yaml")
            return None

        # Build the LLM request
        from pydantic_ai import Agent

        agent_config = get_system_agent_model()
        model = agent_config.get_pydantic_ai_model()
        agent = Agent(model, system_prompt=prompt_template)

        # noinspection PyRedundantParentheses
        user_prompt = ("Book summaries:\n%s\n\nUser question: %s\n\nAI answer (preview): %s") % (
            summary_context,
            user_query,
            ai_answer_preview[:500],
        )

        result = await agent.run(user_prompt)
        raw_output = result.output.strip()

        # Parse JSON array from response
        # Handle possible Markdown code fence wrapping
        if raw_output.startswith("```"):
            raw_output = raw_output.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

        questions = json.loads(raw_output)
        if not isinstance(questions, list) or len(questions) < 1:
            logger.warning("Suggestion LLM returned invalid format: %s", raw_output[:200])
            return None

        # Limit to 3 questions
        questions = [str(q) for q in questions[:3]]

        packet = SuggestionPacket(
            questions=questions,
            document_id=document_id,
            document_title=doc_title,
        )
        emitter.packet_index = counter[0]
        return emitter.emit(packet)

    except Exception as e:
        logger.warning("Failed to generate follow-up suggestions: %s", str(e), exc_info=True)
        return None
