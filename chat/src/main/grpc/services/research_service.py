"""
ResearchDataService gRPC Implementation

Implements the ResearchDataService defined in research.proto.
Provides retrieval and deletion of deep research data (plans, synthesis, sources).
"""

from datetime import UTC
import json

import grpc

from src.main.grpc import research_pb2, research_pb2_grpc
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def _safe_json_dump(obj):
    """Safely serialize to JSON string, returning empty string for None."""
    if obj is None:
        return ""
    try:
        return json.dumps(obj)
    except (TypeError, ValueError):
        return str(obj)


# noinspection PyUnresolvedReferences
def _plan_to_proto(plan) -> research_pb2.ResearchPlanInfo:
    """Convert a research plan DB model to protobuf message."""
    proto_msg = research_pb2.ResearchPlanInfo(
        id=str(plan.id) if plan.id else "",
        session_id=str(plan.session_id) if plan.session_id else "",
        message_id=str(plan.message_id) if plan.message_id else "",
        query=plan.query or "",
        methodology=plan.methodology or "",
        sections_json=_safe_json_dump(plan.sections),
        complexity_score=float(plan.complexity_score) if plan.complexity_score else 0.0,
        status=plan.status or "",
        progress=float(plan.progress) if plan.progress else 0.0,
        error_message=plan.error_message or "",
        created_at=plan.created_at.isoformat() if plan.created_at else "",
        updated_at=plan.updated_at.isoformat() if plan.updated_at else "",
        discoveries_json=_safe_json_dump(plan.discoveries) if plan.discoveries else "[]",
    )
    # Try to set council_deliberation_json if proto supports it (field 14)
    cd = getattr(plan, "council_deliberation", None)
    if cd:
        try:
            proto_msg.council_deliberation_json = _safe_json_dump(cd)
        except (AttributeError, ValueError):
            pass  # Proto stubs not yet regenerated — silently skip
    return proto_msg


# noinspection PyUnresolvedReferences
def _synthesis_to_proto(synthesis) -> research_pb2.ResearchSynthesisInfo:
    """Convert a research synthesis DB model to protobuf message."""
    return research_pb2.ResearchSynthesisInfo(
        id=str(synthesis.id) if synthesis.id else "",
        plan_id=str(synthesis.plan_id) if synthesis.plan_id else "",
        title=synthesis.title or "",
        executive_summary=synthesis.executive_summary or "",
        main_content=synthesis.main_content or "",
        sections_json=_safe_json_dump(synthesis.sections),
        conclusions_json=_safe_json_dump(synthesis.conclusions),
        limitations_json=_safe_json_dump(synthesis.limitations),
        recommendations_json=_safe_json_dump(synthesis.recommendations),
        citations_json=_safe_json_dump(synthesis.citations),
        bibliography_json=_safe_json_dump(synthesis.bibliography),
        quality_score=float(synthesis.quality_score) if synthesis.quality_score else 0.0,
        quality_dimensions_json=_safe_json_dump(synthesis.quality_dimensions),
        word_count=int(synthesis.word_count) if synthesis.word_count else 0,
        total_sources_used=int(synthesis.total_sources_used) if synthesis.total_sources_used else 0,
        created_at=synthesis.created_at.isoformat() if synthesis.created_at else "",
    )


# noinspection PyUnresolvedReferences
def _source_to_proto(source) -> research_pb2.ResearchSourceInfo:
    """Convert a research source DB model to protobuf message."""
    return research_pb2.ResearchSourceInfo(
        id=str(source.id) if source.id else "",
        url=source.url or "",
        title=source.title or "",
        domain=source.domain or "",
        source_type=source.source_type or "",
        content_snippet=source.content_snippet or "",
        credibility_score=float(source.credibility_score) if source.credibility_score else 0.0,
        used_in_synthesis=bool(source.used_in_synthesis) if source.used_in_synthesis is not None else False,
        citation_count=int(source.citation_count) if source.citation_count else 0,
    )


# noinspection PyUnresolvedReferences
class ResearchDataServiceServicer(research_pb2_grpc.ResearchDataServiceServicer):
    """ResearchDataService gRPC implementation."""

    async def GetByPlan(
        self,
        request: research_pb2.GetByPlanRequest,
        context: grpc.aio.ServicerContext,
    ) -> research_pb2.FullResearchResponse:
        """Get full research data by plan ID."""
        logger.info("ResearchDataService.GetByPlan called - plan_id=%s", request.plan_id)

        try:
            from src.main.config.database import SessionLocal

            db = SessionLocal()
            try:
                return self._get_full_research(db, plan_id=request.plan_id)
            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in ResearchDataService.GetByPlan: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, f"Failed to get research: {e!s}")
            return research_pb2.FullResearchResponse(found=False)

    async def GetByMessage(
        self,
        request: research_pb2.GetByMessageRequest,
        context: grpc.aio.ServicerContext,
    ) -> research_pb2.FullResearchResponse:
        """Get full research data by message ID."""
        logger.info("ResearchDataService.GetByMessage called - message_id=%s", request.message_id)

        try:
            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_research import ResearchPlan

            db = SessionLocal()
            try:
                # noinspection PyTypeChecker
                plan = db.query(ResearchPlan).filter(ResearchPlan.message_id == request.message_id).first()

                if not plan:
                    return research_pb2.FullResearchResponse(found=False)

                return self._get_full_research(db, plan_id=str(plan.id))
            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in ResearchDataService.GetByMessage: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, f"Failed to get research: {e!s}")
            return research_pb2.FullResearchResponse(found=False)

    async def GetSessionPlans(
        self,
        request: research_pb2.GetSessionPlansRequest,
        context: grpc.aio.ServicerContext,
    ) -> research_pb2.SessionPlansResponse:
        """Get all research plans for a session."""
        logger.info("ResearchDataService.GetSessionPlans called - session_id=%s", request.session_id)

        try:
            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_research import ResearchPlan

            db = SessionLocal()
            try:
                plans = (
                    db.query(ResearchPlan)
                    # noinspection PyTypeChecker
                    .filter(ResearchPlan.session_id == request.session_id)
                    .order_by(ResearchPlan.created_at.desc())
                    .all()
                )

                return research_pb2.SessionPlansResponse(plans=[_plan_to_proto(p) for p in plans])
            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in ResearchDataService.GetSessionPlans: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, f"Failed to get session plans: {e!s}")
            return research_pb2.SessionPlansResponse()

    async def DeleteByMessageIds(
        self,
        request: research_pb2.DeleteByMessageIdsRequest,
        context: grpc.aio.ServicerContext,
    ) -> research_pb2.DeleteByMessageIdsResponse:
        """Delete research plans linked to the given message IDs (cascade deletes tasks/sources/synthesis)."""
        logger.info("ResearchDataService.DeleteByMessageIds called - %d message_ids", len(request.message_ids))

        if not request.message_ids:
            return research_pb2.DeleteByMessageIdsResponse(deleted_count=0)

        try:
            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_research import ResearchPlan

            db = SessionLocal()
            try:
                plans = db.query(ResearchPlan).filter(ResearchPlan.message_id.in_(request.message_ids)).all()

                deleted_count = len(plans)
                for plan in plans:
                    db.delete(plan)

                if deleted_count > 0:
                    db.commit()
                    logger.info("Deleted %d research plans for message IDs", deleted_count)

                return research_pb2.DeleteByMessageIdsResponse(deleted_count=deleted_count)
            finally:
                db.close()

        except Exception as e:
            logger.exception("Error in ResearchDataService.DeleteByMessageIds: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, f"Failed to delete research plans: {e!s}")
            return research_pb2.DeleteByMessageIdsResponse(deleted_count=0)

    async def GetActiveResearch(
        self,
        request: research_pb2.GetActiveResearchRequest,
        context: grpc.aio.ServicerContext,
    ) -> research_pb2.ActiveResearchResponse:
        """Return the running plan for a session if one exists."""
        logger.info(
            "ResearchDataService.GetActiveResearch called - session_id=%s user_id=%s",
            request.session_id,
            request.user_id,
        )

        try:
            from datetime import datetime, timedelta

            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_research import ResearchPlan

            running_states = ("planning", "executing", "synthesizing", "pending")
            # Treat plans with no recent updated_at as zombies (orchestrator
            # crashed mid-flight and left the row in a non-terminal state).
            stale_cutoff = datetime.now(UTC) - timedelta(minutes=5)
            db = SessionLocal()
            try:
                # Session-scoped lookup — only when a session id was supplied. A
                # second device may call with an empty session_id (it has no local
                # session for this run); casting "" to uuid would raise, so skip
                # straight to the user-scoped fallback below.
                plan = None
                if request.session_id:
                    plan = (
                        db.query(ResearchPlan)
                        # noinspection PyTypeChecker
                        .filter(ResearchPlan.session_id == request.session_id)
                        # noinspection PyTypeChecker
                        .filter(ResearchPlan.status.in_(running_states))
                        # noinspection PyTypeChecker
                        .filter(ResearchPlan.updated_at >= stale_cutoff)
                        .order_by(ResearchPlan.created_at.desc())
                        .first()
                    )

                # Cross-device: if this session has nothing running, surface the
                # user's active run from ANY of their sessions so a second device
                # (e.g. mobile) shows the in-progress panel.
                cross_device = False
                if not plan and request.user_id:
                    user_plan = (
                        db.query(ResearchPlan)
                        # noinspection PyTypeChecker
                        .filter(ResearchPlan.user_id == request.user_id)
                        # noinspection PyTypeChecker
                        .filter(ResearchPlan.status.in_(running_states))
                        # noinspection PyTypeChecker
                        .filter(ResearchPlan.updated_at >= stale_cutoff)
                        .order_by(ResearchPlan.created_at.desc())
                        .first()
                    )
                    if user_plan:
                        plan = user_plan
                        cross_device = True

                if not plan:
                    return research_pb2.ActiveResearchResponse(found=False)

                phase = "planning"
                progress = float(plan.progress) if plan.progress else 0.0
                if plan.status == "executing":
                    phase = "search" if progress >= 0.5 else "decomposition"
                elif plan.status == "synthesizing":
                    phase = "synthesis"

                if cross_device:
                    logger.info(
                        "GetActiveResearch cross-device hit: user=%s sees plan=%s from another session",
                        request.user_id,
                        plan.id,
                    )

                return research_pb2.ActiveResearchResponse(
                    found=True,
                    plan_id=str(plan.id),
                    status=plan.status or "",
                    progress=progress,
                    current_phase=phase,
                    started_at=plan.created_at.isoformat() if plan.created_at else "",
                    query=plan.query or "",
                )
            finally:
                db.close()
        except Exception as e:
            logger.exception("Error in ResearchDataService.GetActiveResearch: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, f"Failed to get active research: {e!s}")
            return research_pb2.ActiveResearchResponse(found=False)

    async def CancelResearch(
        self,
        request: research_pb2.CancelResearchRequest,
        context: grpc.aio.ServicerContext,
    ) -> research_pb2.CancelResearchResponse:
        """Set a Redis flag the orchestrator polls at every phase boundary."""
        logger.info("ResearchDataService.CancelResearch called - plan_id=%s", request.plan_id)

        if not request.plan_id:
            return research_pb2.CancelResearchResponse(cancelled=False)

        previous_status = ""
        try:
            from src.main.config.database import SessionLocal
            from src.main.models.sqlmodel_research import ResearchPlan

            db = SessionLocal()
            try:
                # noinspection PyTypeChecker
                plan = db.query(ResearchPlan).filter(ResearchPlan.id == request.plan_id).first()
                if plan:
                    previous_status = plan.status or ""
                    if plan.status not in ("completed", "failed", "cancelled"):
                        plan.status = "cancelled"
                        plan.error_message = "Cancelled by user"
                        db.commit()
            finally:
                db.close()
        except Exception as e:
            logger.warning("CancelResearch DB update failed (continuing with Redis flag): %s", str(e))

        try:
            from src.main.utils.redis.client import get_redis_client

            client = get_redis_client()
            if client is not None:
                key = f"scrapalot:cancel_research:{request.plan_id}"
                client.setex(key, 3600, "1")
        except Exception as e:
            logger.exception("CancelResearch Redis flag set failed: %s", str(e))
            await context.abort(grpc.StatusCode.INTERNAL, f"Failed to cancel: {e!s}")
            return research_pb2.CancelResearchResponse(cancelled=False)

        return research_pb2.CancelResearchResponse(cancelled=True, previous_status=previous_status)

    @staticmethod
    def _get_full_research(db, plan_id: str) -> research_pb2.FullResearchResponse:
        """Get full research data (plan + synthesis + sources) by plan ID."""
        from src.main.models.sqlmodel_research import ResearchPlan, ResearchSource, ResearchSynthesis

        # noinspection PyTypeChecker
        plan = db.query(ResearchPlan).filter(ResearchPlan.id == plan_id).first()
        if not plan:
            return research_pb2.FullResearchResponse(found=False)

        # noinspection PyTypeChecker
        synthesis = db.query(ResearchSynthesis).filter(ResearchSynthesis.plan_id == plan_id).first()

        # noinspection PyTypeChecker
        sources = db.query(ResearchSource).filter(ResearchSource.plan_id == plan_id).all()

        response = research_pb2.FullResearchResponse(
            found=True,
            plan=_plan_to_proto(plan),
            sources=[_source_to_proto(s) for s in sources],
        )

        if synthesis:
            response.synthesis.CopyFrom(_synthesis_to_proto(synthesis))

        return response
