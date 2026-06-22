"""
CollectionAIService gRPC Implementation

Implements the CollectionAIService defined in collection_ai.proto.
AI-powered collection description generation using LLM.
"""

import grpc

from src.main.grpc import collection_ai_pb2, collection_ai_pb2_grpc
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# noinspection PyUnresolvedReferences
class CollectionAIServiceServicer(collection_ai_pb2_grpc.CollectionAIServiceServicer):
    """CollectionAIService gRPC implementation."""

    async def GenerateDescription(
        self,
        request: collection_ai_pb2.GenerateDescriptionRequest,
        context: grpc.aio.ServicerContext,
    ) -> collection_ai_pb2.GenerateDescriptionResponse:
        """Generate description for a collection from its documents."""
        logger.info(
            "CollectionAIService.GenerateDescription called - collection_id=%s",
            request.collection_id,
        )

        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                # Get collection name and sample document names
                result = db.execute(
                    text("SELECT collection_name FROM collection_workspace_map WHERE collection_id = :id"),
                    {"id": request.collection_id},
                ).fetchone()

                if not result:
                    return collection_ai_pb2.GenerateDescriptionResponse(
                        success=False,
                        error="Collection not found in workspace map",
                    )

                collection_name = result[0]
                existing_description = (request.existing_description or "").strip()

                # Preferred path: synthesize from per-book summaries. When the user
                # clicked ✨ while editing an existing (possibly hand-written)
                # description, this MERGES their text with the summaries instead of
                # overwriting it; with an empty editor it builds a fresh digest.
                description = ""
                try:
                    from uuid import UUID as _UUID

                    from src.main.service.collection_summary_service import build_collection_digest

                    description = (
                        await build_collection_digest(
                            _UUID(request.collection_id),
                            db,
                            existing_description=existing_description or None,
                        )
                        or ""
                    )
                except Exception as digest_err:
                    logger.warning("Summary-based description failed for %s: %s — falling back to titles", request.collection_id, digest_err)

                # Fallback: no book summaries yet → generate from document titles
                # (preserving any user text the LLM can fold in is not possible here,
                # so titles-only is the floor behaviour for un-summarized collections).
                if not description:
                    docs = db.execute(
                        text("SELECT title FROM documents WHERE collection_id = :id ORDER BY created_at DESC LIMIT 100"),
                        {"id": request.collection_id},
                    ).fetchall()
                    doc_titles = [d[0] for d in docs if d[0]] if docs else []
                    description = await self._generate_with_llm(
                        collection_name=collection_name,
                        document_names=doc_titles,
                        user_id=request.user_id or None,
                    )

                return collection_ai_pb2.GenerateDescriptionResponse(
                    success=True,
                    description=description,
                )

            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in CollectionAIService.GenerateDescription: %s", str(e))
            return collection_ai_pb2.GenerateDescriptionResponse(
                success=False,
                error=str(e),
            )

    async def GenerateDescriptionFromName(
        self,
        request: collection_ai_pb2.GenerateDescriptionFromNameRequest,
        context: grpc.aio.ServicerContext,
    ) -> collection_ai_pb2.GenerateDescriptionResponse:
        """Generate description from collection name only."""
        logger.info(
            "CollectionAIService.GenerateDescriptionFromName called - name=%s",
            request.collection_name,
        )

        try:
            description = await self._generate_with_llm(
                collection_name=request.collection_name,
                document_names=[],
                user_id=request.user_id or None,
            )

            return collection_ai_pb2.GenerateDescriptionResponse(
                success=True,
                description=description,
            )

        except Exception as e:
            logger.exception("Error in CollectionAIService.GenerateDescriptionFromName: %s", str(e))
            return collection_ai_pb2.GenerateDescriptionResponse(
                success=False,
                error=str(e),
            )

    async def GenerateCustomInstructions(
        self,
        request: collection_ai_pb2.GenerateCustomInstructionsRequest,
        context: grpc.aio.ServicerContext,
    ) -> collection_ai_pb2.GenerateCustomInstructionsResponse:
        """Generate the system-prompt addendum for a collection.

        Reads name + description from collection_workspace_map. If description
        is missing, generates one inline (reusing the same LLM helper as
        GenerateDescription) so the caller doesn't need to do a two-step
        dance. Returns the description used so the caller can persist it
        back to the source-of-truth collections table without re-asking.
        """
        logger.info(
            "CollectionAIService.GenerateCustomInstructions called - collection_id=%s",
            request.collection_id,
        )

        try:
            from sqlalchemy import text

            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                row = db.execute(
                    text("SELECT collection_name, description FROM collection_workspace_map WHERE collection_id = :id"),
                    {"id": request.collection_id},
                ).fetchone()

                if not row:
                    return collection_ai_pb2.GenerateCustomInstructionsResponse(
                        success=False,
                        error="Collection not found in workspace map",
                    )

                collection_name = row[0] or ""
                description = (row[1] or "").strip()
                description_generated = False

                # Auto-generate description when missing so the prompt
                # has something concrete to anchor on.
                if not description:
                    docs = db.execute(
                        text("SELECT title FROM documents WHERE collection_id = :id ORDER BY created_at DESC LIMIT 100"),
                        {"id": request.collection_id},
                    ).fetchall()
                    doc_titles = [d[0] for d in docs if d[0]] if docs else []
                    description = await self._generate_with_llm(
                        collection_name=collection_name,
                        document_names=doc_titles,
                        user_id=request.user_id or None,
                    )
                    description_generated = True

                custom_instructions = await self._generate_custom_instructions_with_llm(
                    collection_name=collection_name,
                    description=description,
                    user_id=request.user_id or None,
                )

                return collection_ai_pb2.GenerateCustomInstructionsResponse(
                    success=True,
                    custom_instructions=custom_instructions,
                    description_used=description,
                    description_generated=description_generated,
                )

            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in CollectionAIService.GenerateCustomInstructions: %s", str(e))
            return collection_ai_pb2.GenerateCustomInstructionsResponse(
                success=False,
                error=str(e),
            )

    @staticmethod
    async def _generate_with_llm(
        collection_name: str,
        document_names: list,
        user_id: str | None = None,
    ) -> str:
        """Generate collection description using LLM with prompts from prompts.yaml."""
        from src.main.utils.config.loader import get_resolved_prompts
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        agent_config = get_system_agent_model()
        model_name = agent_config.model_name

        prompts = get_resolved_prompts()
        collection_prompts = prompts.get("collection_management", {})

        if document_names:
            template = collection_prompts.get("description_generation_with_documents", "")
            if template:
                doc_list = "\n".join(f"- {name}" for name in document_names)
                prompt = template.format(
                    collection_name=collection_name,
                    doc_count=len(document_names),
                    doc_list=doc_list,
                )
            else:
                doc_list = ", ".join(document_names[:10])
                prompt = (
                    f"Generate a brief, professional description (2-3 sentences) for a knowledge collection "
                    f"named '{collection_name}' containing {len(document_names)} document(s): {doc_list}"
                )
        else:
            template = collection_prompts.get("description_generation_no_documents", "")
            if template:
                prompt = template.format(collection_name=collection_name)
            else:
                prompt = (
                    f"Generate a brief, professional description (2-3 sentences) for a knowledge collection "
                    f"named '{collection_name}'. Describe what it might be used for based on its name."
                )

        from src.main.service.llm.llm_manager import llm_manager

        llm = await llm_manager.get_llm(
            model_name=model_name,
            provider_type="system",
            user_id=user_id,
            system_provider_config={"api_key": agent_config.api_key},
        )

        response = await llm.ainvoke(prompt)
        return response.content if hasattr(response, "content") else str(response)

    @staticmethod
    async def _generate_custom_instructions_with_llm(
        collection_name: str,
        description: str,
        user_id: str | None = None,
    ) -> str:
        """Produce the system-prompt addendum baseline.

        Uses the same system-provider model as GenerateDescription. Falls
        back to a hardcoded prompt when the YAML key is missing so the
        feature degrades gracefully on a misconfigured deployment instead
        of raising.
        """
        from src.main.utils.config.loader import get_resolved_prompts
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        agent_config = get_system_agent_model()
        model_name = agent_config.model_name

        prompts = get_resolved_prompts()
        collection_prompts = prompts.get("collection_management", {})
        template = collection_prompts.get("custom_instructions_baseline", "")

        if template:
            prompt = template.format(
                collection_name=collection_name,
                description=description,
            )
        else:
            # Fallback so a missing YAML entry doesn't break the feature.
            logger.warning("collection_management.custom_instructions_baseline missing — using fallback prompt")
            prompt = (
                f"Write a 4-7 sentence system-prompt addendum (under 1500 chars) for an AI "
                f"assistant answering questions about a knowledge collection named "
                f"'{collection_name}'. Description: {description}. Cover domain frame, "
                f"technical depth, citation style, tone, taboo behaviors, and out-of-scope "
                f"handling. Output prose only — no markdown, no headers, no lists. Match "
                f"the language of the description."
            )

        from src.main.service.llm.llm_manager import llm_manager

        llm = await llm_manager.get_llm(
            model_name=model_name,
            provider_type="system",
            user_id=user_id,
            system_provider_config={"api_key": agent_config.api_key},
        )

        response = await llm.ainvoke(prompt)
        return response.content if hasattr(response, "content") else str(response)
