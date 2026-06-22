"""
SQLModel repositories for common database operations.

This module provides type-safe repositories that replace manual SQL queries
with SQLModel operations for the main application models.
"""

from datetime import UTC
from typing import Any
from uuid import UUID

from sqlmodel import Session, and_, or_, select

from src.main.models.sqlmodel_jobs import Job
from src.main.models.sqlmodel_models import (
    Document,
    UserSetting,
)
from src.main.models.sqlmodel_providers import ModelProvider, ModelProviderModel
from src.main.models.sqlmodel_research import (
    ResearchPlan,
    ResearchSource,
    ResearchSynthesis,
    ResearchTask,
    ResearchTemplate,
)
from src.main.models.sqlmodel_settings import ServerSetting
from src.main.repository.sqlmodel_base_repository import BaseRepository
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


# =============================================================================
# DOCUMENT REPOSITORY
# =============================================================================


class DocumentRepository(BaseRepository[Document]):
    """Repository for Document model"""

    def __init__(self, session: Session = None):
        super().__init__(Document, session)

    def get_collection_documents(self, collection_id: UUID, status: str | None = None) -> list[Document]:
        """Get documents in a collection, optionally filtered by status"""
        criteria: dict[str, Any] = {"collection_id": collection_id}
        if status:
            criteria["processing_status"] = status
        return self.find_by_criteria(criteria, order_by="created_at")

    def get_pending_documents(self) -> list[Document]:
        """Get documents pending processing"""
        return self.find_by_criteria({"processing_status": "pending"}, order_by="created_at")

    def search_documents(self, query: str, collection_id: UUID | None = None, limit: int = 20) -> list[Document]:
        """Search documents by title or filename"""
        # noinspection PyUnresolvedReferences
        statement = select(Document).where(or_(Document.title.ilike(f"%{query}%"), Document.filename.ilike(f"%{query}%")))

        if collection_id:
            statement = statement.where(Document.collection_id == collection_id)

        statement = statement.limit(limit)
        results = self.session.exec(statement).all()
        return list(results)


# =============================================================================
# MODEL PROVIDER REPOSITORIES
# =============================================================================


class ModelProviderRepository(BaseRepository[ModelProvider]):
    """Repository for ModelProvider model"""

    def __init__(self, session: Session = None):
        super().__init__(ModelProvider, session)

    def get_user_providers(self, user_id: UUID, active_only: bool = True) -> list[ModelProvider]:
        """Get model providers for a user"""
        criteria: dict[str, Any] = {"user_id": user_id}
        if active_only:
            criteria["is_active"] = True
        return self.find_by_criteria(criteria, order_by="created_at")

    def get_provider_by_name(self, _user_id: UUID, name: str) -> ModelProvider | None:
        """Get a specific provider by name for a user"""
        # noinspection PyTypeChecker
        return self.get_by_field("name", name, single=True)  # Note: may need user_id filter


class ModelProviderModelRepository(BaseRepository[ModelProviderModel]):
    """Repository for ModelProviderModel model"""

    def __init__(self, session: Session = None):
        super().__init__(ModelProviderModel, session)

    def get_provider_models(self, provider_id: UUID, available_only: bool = True) -> list[ModelProviderModel]:
        """Get models for a provider"""
        criteria: dict[str, Any] = {"provider_id": provider_id}
        if available_only:
            criteria["is_available"] = True
        return self.find_by_criteria(criteria, order_by="model_name")


# =============================================================================
# SETTINGS REPOSITORIES
# =============================================================================


class UserSettingRepository(BaseRepository[UserSetting]):
    """Repository for UserSetting model"""

    def __init__(self, session: Session = None):
        super().__init__(UserSetting, session)

    def get_user_setting(self, user_id: UUID, key: str) -> UserSetting | None:
        """Get a specific user setting"""
        # noinspection PyUnresolvedReferences
        statement = select(UserSetting).where(and_(UserSetting.user_id == user_id, UserSetting.key == key))
        return self.session.exec(statement).first()

    def get_user_settings(self, user_id: UUID, category: str | None = None) -> list[UserSetting]:
        """Get all settings for a user, optionally filtered by category"""
        criteria: dict[str, Any] = {"user_id": user_id}
        if category:
            criteria["category"] = category
        return self.find_by_criteria(criteria, order_by="key")

    def set_user_setting(self, user_id: UUID, key: str, value: Any, category: str | None = None) -> UserSetting:
        """Set or update a user setting"""
        setting = self.get_user_setting(user_id, key)
        if setting:
            setting.value = value
            if category:
                setting.category = category
            self.session.add(setting)
            self.session.commit()
            self.session.refresh(setting)
        else:
            setting = UserSetting(user_id=user_id, key=key, value=value, category=category)
            setting = self.create(setting)
        return setting


class ServerSettingRepository(BaseRepository[ServerSetting]):
    """Repository for ServerSetting model"""

    def __init__(self, session: Session = None):
        super().__init__(ServerSetting, session)

    def get_setting(self, key: str) -> ServerSetting | None:
        """Get a server setting by key"""
        # noinspection PyTypeChecker
        return self.get_by_field("setting_key", key, single=True)

    def set_setting(self, key: str, value: Any) -> ServerSetting:
        """Set or update a server setting"""
        setting = self.get_setting(key)
        if setting:
            setting.setting_value = value
            self.session.add(setting)
            self.session.commit()
            self.session.refresh(setting)
        else:
            setting = ServerSetting(setting_key=key, setting_value=value)
            setting = self.create(setting)
        return setting


# =============================================================================
# JOB REPOSITORIES
# =============================================================================


class JobRepository(BaseRepository[Job]):
    """Repository for Job model"""

    def __init__(self, session: Session = None):
        super().__init__(Job, session)

    def get_by_job_id(self, job_id: str) -> Job | None:
        """Get job by job_id."""
        # noinspection PyTypeChecker
        return self.get_by_field("job_id", job_id, single=True)

    def get_user_jobs(self, user_id: UUID, job_type: str | None = None) -> list[Job]:
        """Get jobs for a user, optionally filtered by type"""
        criteria: dict[str, Any] = {"user_id": user_id}
        if job_type:
            criteria["job_type"] = job_type
        return self.find_by_criteria(criteria, order_by="created_at", order_desc=True)

    def get_running_jobs(self) -> list[Job]:
        """Get currently running jobs"""
        return self.find_by_criteria({"status": "running"}, order_by="started_at")


# =============================================================================
# RESEARCH REPOSITORIES
# =============================================================================


class ResearchPlanRepository(BaseRepository[ResearchPlan]):
    """Repository for ResearchPlan model"""

    def __init__(self, session: Session = None):
        super().__init__(ResearchPlan, session)

    def get_by_message_id(self, message_id: UUID) -> ResearchPlan | None:
        """Get research plan by message ID (1:1 relationship)"""
        # noinspection PyTypeChecker
        return self.get_by_field("message_id", message_id, single=True)

    def get_session_plans(self, session_id: UUID) -> list[ResearchPlan]:
        """Get all research plans for a chat session"""
        return self.find_by_criteria({"session_id": session_id}, order_by="created_at", order_desc=True)

    def get_by_status(self, status: str, limit: int = 100) -> list[ResearchPlan]:
        """Get research plans by status"""
        return self.find_by_criteria({"status": status}, limit=limit, order_by="created_at", order_desc=True)

    def update_status(self, plan_id: UUID, status: str, progress: float = None, error_message: str = None) -> ResearchPlan | None:
        """Update research plan status and progress"""
        from datetime import datetime

        plan = self.get_by_id(plan_id)
        if not plan:
            return None

        plan.status = status
        if progress is not None:
            plan.progress = progress

        if status == "executing" and not plan.started_at:
            plan.started_at = datetime.now(UTC)
        elif status in ("completed", "failed"):
            plan.completed_at = datetime.now(UTC)

        if error_message:
            plan.error_message = error_message

        self.session.add(plan)
        self.session.commit()
        self.session.refresh(plan)
        return plan

    def create_plan(
        self,
        session_id: UUID,
        message_id: UUID,
        query: str,
        methodology: str = "analytical",
        sections: dict = None,
        complexity_score: float = 0.5,
        estimated_sources: int = 10,
        template_id: UUID = None,
        user_id: UUID = None,
    ) -> ResearchPlan:
        """Create a new research plan"""
        plan = ResearchPlan(
            session_id=session_id,
            message_id=message_id,
            user_id=user_id,
            query=query,
            methodology=methodology,
            sections=sections or {},
            complexity_score=complexity_score,
            estimated_sources=estimated_sources,
            template_id=template_id,
            status="pending",
            progress=0.0,
        )
        return self.create(plan)

    # Statuses that mean a research run is still in flight (not finished).
    RUNNING_STATES = ("pending", "planning", "executing", "synthesizing")

    def get_active_plan_for_user(self, user_id: UUID) -> ResearchPlan | None:
        """Return the user's most recent still-running research plan, if any.

        Used to (a) show the in-progress panel on a second device and (b) enforce
        one active deep-research run per user. Spans ALL of the user's sessions.

        Ignores STALE plans: an interrupted run (worker restart / crash) leaves
        the plan in a running state forever — without this cutoff that zombie
        would block the user from ever starting a new research. The window is
        generous (15 min) so a legitimately slow finalization, which can go
        several minutes between status bumps, is never mistaken for dead.
        """
        from datetime import UTC, datetime, timedelta

        stale_cutoff = datetime.now(UTC) - timedelta(minutes=15)
        return (
            self.session.query(ResearchPlan)
            # noinspection PyTypeChecker
            .filter(ResearchPlan.user_id == user_id)
            # noinspection PyTypeChecker
            .filter(ResearchPlan.status.in_(self.RUNNING_STATES))
            # noinspection PyTypeChecker
            .filter(ResearchPlan.updated_at >= stale_cutoff)
            .order_by(ResearchPlan.created_at.desc())
            .first()
        )


class ResearchTaskRepository(BaseRepository[ResearchTask]):
    """Repository for ResearchTask model"""

    def __init__(self, session: Session = None):
        super().__init__(ResearchTask, session)

    def get_plan_tasks(self, plan_id: UUID) -> list[ResearchTask]:
        """Get all tasks for a research plan"""
        return self.find_by_criteria({"plan_id": plan_id}, order_by="task_index")

    def get_pending_tasks(self, plan_id: UUID) -> list[ResearchTask]:
        """Get pending tasks for a research plan"""
        statement = (
            select(ResearchTask).where(and_(ResearchTask.plan_id == plan_id, ResearchTask.status == "pending")).order_by(ResearchTask.task_index)
        )
        results = self.session.exec(statement).all()
        return list(results)

    def update_task_status(
        self,
        task_id: UUID,
        status: str,
        progress: float = None,
        findings: dict = None,
        quality_score: float = None,
        error_message: str = None,
    ) -> ResearchTask | None:
        """Update task status and results"""
        from datetime import datetime

        task = self.get_by_id(task_id)
        if not task:
            return None

        task.status = status
        if progress is not None:
            task.progress = progress
        if findings is not None:
            task.findings = findings
        if quality_score is not None:
            task.quality_score = quality_score
        if error_message:
            task.error_message = error_message

        if status == "running" and not task.started_at:
            task.started_at = datetime.now(UTC)
        elif status in ("completed", "failed"):
            task.completed_at = datetime.now(UTC)

        self.session.add(task)
        self.session.commit()
        self.session.refresh(task)
        return task


class ResearchSourceRepository(BaseRepository[ResearchSource]):
    """Repository for ResearchSource model"""

    def __init__(self, session: Session = None):
        super().__init__(ResearchSource, session)

    def get_plan_sources(self, plan_id: UUID, used_only: bool = False) -> list[ResearchSource]:
        """Get all sources for a research plan"""
        if used_only:
            statement = (
                select(ResearchSource)
                .where(and_(ResearchSource.plan_id == plan_id, ResearchSource.used_in_synthesis is True))
                # noinspection PyUnresolvedReferences
                .order_by(ResearchSource.credibility_score.desc())
            )
            results = self.session.exec(statement).all()
            return list(results)
        return self.find_by_criteria({"plan_id": plan_id}, order_by="credibility_score", order_desc=True)

    def get_sources_by_credibility(self, plan_id: UUID, min_credibility: float = 0.7) -> list[ResearchSource]:
        """Get high-credibility sources for a plan"""
        statement = (
            select(ResearchSource)
            .where(and_(ResearchSource.plan_id == plan_id, ResearchSource.credibility_score >= min_credibility))
            # noinspection PyUnresolvedReferences
            .order_by(ResearchSource.credibility_score.desc())
        )
        results = self.session.exec(statement).all()
        return list(results)

    def bulk_create_sources(self, sources: list[ResearchSource]) -> list[ResearchSource]:
        """Create multiple sources at once"""
        for source in sources:
            self.session.add(source)
        self.session.commit()
        for source in sources:
            self.session.refresh(source)
        return sources


class ResearchSynthesisRepository(BaseRepository[ResearchSynthesis]):
    """Repository for ResearchSynthesis model"""

    def __init__(self, session: Session = None):
        super().__init__(ResearchSynthesis, session)

    def get_by_plan_id(self, plan_id: UUID) -> ResearchSynthesis | None:
        """Get synthesis by plan ID (1:1 relationship)"""
        # noinspection PyTypeChecker
        return self.get_by_field("plan_id", plan_id, single=True)

    def create_synthesis(
        self,
        plan_id: UUID,
        title: str,
        main_content: str,
        executive_summary: str = None,
        sections: dict = None,
        conclusions: list[str] = None,
        limitations: list[str] = None,
        recommendations: list[str] = None,
        citations: list[dict] = None,
        bibliography: list[dict] = None,
        quality_score: float = 0.0,
        quality_dimensions: dict = None,
        word_count: int = 0,
        total_sources_used: int = 0,
    ) -> ResearchSynthesis:
        """Create a research synthesis"""
        from datetime import datetime

        synthesis = ResearchSynthesis(
            plan_id=plan_id,
            title=title,
            main_content=main_content,
            executive_summary=executive_summary,
            sections=sections or {},
            conclusions=conclusions or [],
            limitations=limitations or [],
            recommendations=recommendations or [],
            citations=citations or [],
            bibliography=bibliography or [],
            quality_score=quality_score,
            quality_dimensions=quality_dimensions or {},
            word_count=word_count,
            total_sources_used=total_sources_used,
            synthesis_completed_at=datetime.now(UTC),
        )
        return self.create(synthesis)

    def update_synthesis(
        self,
        synthesis_id: UUID,
        main_content: str = None,
        quality_score: float = None,
        quality_dimensions: dict = None,
        validation_results: dict = None,
    ) -> ResearchSynthesis | None:
        """Update synthesis content and quality metrics"""
        from datetime import datetime

        synthesis = self.get_by_id(synthesis_id)
        if not synthesis:
            return None

        if main_content is not None:
            synthesis.main_content = main_content
            synthesis.word_count = len(main_content.split())
        if quality_score is not None:
            synthesis.quality_score = quality_score
        if quality_dimensions is not None:
            synthesis.quality_dimensions = quality_dimensions
        if validation_results is not None:
            synthesis.validation_results = validation_results
            synthesis.qa_completed_at = datetime.now(UTC)

        self.session.add(synthesis)
        self.session.commit()
        self.session.refresh(synthesis)
        return synthesis


class ResearchTemplateRepository(BaseRepository[ResearchTemplate]):
    """Repository for ResearchTemplate model"""

    def __init__(self, session: Session = None):
        super().__init__(ResearchTemplate, session)

    def get_user_templates(self, user_id: UUID) -> list[ResearchTemplate]:
        """Get all templates for a user"""
        return self.find_by_criteria({"user_id": user_id}, order_by="use_count", order_desc=True)

    def get_default_template(self, user_id: UUID) -> ResearchTemplate | None:
        """Get user's default template"""
        statement = select(ResearchTemplate).where(and_(ResearchTemplate.user_id == user_id, ResearchTemplate.is_default is True))
        return self.session.exec(statement).first()

    def increment_usage(self, template_id: UUID) -> ResearchTemplate | None:
        """Increment template usage counter"""
        from datetime import datetime

        template = self.get_by_id(template_id)
        if not template:
            return None

        template.use_count += 1
        template.last_used_at = datetime.now(UTC)
        self.session.add(template)
        self.session.commit()
        self.session.refresh(template)
        return template


# =============================================================================
# REPOSITORY FACTORY
# =============================================================================


class RepositoryFactory:
    """Factory for creating repository instances with shared session"""

    def __init__(self, session: Session = None):
        self.session = session

    def document_repository(self) -> DocumentRepository:
        return DocumentRepository(self.session)

    def model_provider_repository(self) -> ModelProviderRepository:
        return ModelProviderRepository(self.session)

    def model_provider_model_repository(self) -> ModelProviderModelRepository:
        return ModelProviderModelRepository(self.session)

    def user_setting_repository(self) -> UserSettingRepository:
        return UserSettingRepository(self.session)

    def server_setting_repository(self) -> ServerSettingRepository:
        return ServerSettingRepository(self.session)

    def job_repository(self) -> JobRepository:
        return JobRepository(self.session)

    def research_plan_repository(self) -> ResearchPlanRepository:
        return ResearchPlanRepository(self.session)

    def research_task_repository(self) -> ResearchTaskRepository:
        return ResearchTaskRepository(self.session)

    def research_source_repository(self) -> ResearchSourceRepository:
        return ResearchSourceRepository(self.session)

    def research_synthesis_repository(self) -> ResearchSynthesisRepository:
        return ResearchSynthesisRepository(self.session)

    def research_template_repository(self) -> ResearchTemplateRepository:
        return ResearchTemplateRepository(self.session)
