"""
Deep Research Database Models

These models support the deep research feature with:
1. User-level permanent data (templates, preferences)
2. Session-level research data (plans, tasks, sources, synthesis)

Relationships:
- User -> ResearchTemplate (1:N) - Reusable research templates per user
- Message -> ResearchPlan (1:1) - Each deep research message has one plan
- ResearchPlan -> ResearchTask (1:N) - Plan decomposes into tasks
- ResearchPlan -> ResearchSource (1:N) - Sources collected during research
- ResearchPlan -> ResearchSynthesis (1:1) - Final synthesis report
"""

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import Column, Float, ForeignKey, Index, Text
from sqlmodel import Field, Relationship

from src.main.models.sqlite_compat import ScrapalotJSON, ScrapalotJSONB
from src.main.models.sqlmodel_base import BaseModel, ScrapalotUUID

# =============================================================================
# USER-LEVEL PERMANENT DATA
# =============================================================================


class ResearchTemplate(BaseModel, table=True):
    """
    Reusable research plan templates saved by users.

    Stores user preferences for research methodology, agent configurations,
    and quality standards that can be applied to future research sessions.
    """

    __tablename__ = "research_templates"
    __table_args__ = (
        Index("ix_research_templates_name", "name"),
        {"extend_existing": True},
    )

    # id, created_at, updated_at inherited from BaseModel

    # User ID (plain UUID, no FK constraint)
    user_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            nullable=False,
            index=True,
        )
    )

    # Template metadata
    name: str = Field(max_length=255, description="Template name")
    description: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    is_default: bool = Field(default=False, description="Whether this is the user's default template")
    is_system: bool = Field(default=False, description="Whether this is a system-seeded template (not owned by user)")

    # Template type (scientific_paper, literature_review, concept_exploration, fact_verification, comparative_analysis)
    template_type: str | None = Field(default=None, max_length=50)

    # Research configuration
    methodology: str | None = Field(
        default="analytical",
        max_length=50,
        description="Research methodology: analytical, comparative, narrative, thematic",
    )
    depth: int = Field(default=3, description="Research depth 1-5 (maps to research_depth)")
    breadth: int = Field(default=3, description="Research breadth 1-5 (maps to research_breadth)")
    source_types: list[str] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
        description="Prioritized source types for this template",
    )
    output_format: str = Field(
        default="report", max_length=50, description="Output format: report, summary, bullet_points, academic_paper, annotated_bibliography"
    )
    clarification_categories: list[str] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
        description="Question categories to prioritize for clarification",
    )
    tone: str = Field(default="objective", max_length=50, description="Research tone: objective, analytical, narrative, persuasive")
    max_iterations: int = Field(default=1, description="Max iterative research loops")
    agent_config: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Agent type preferences and configurations",
    )
    quality_standards: dict[str, float] = Field(
        default_factory=lambda: {"accuracy": 0.85, "completeness": 0.80, "citation": 0.90},
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Quality thresholds for research output",
    )
    citation_style: str = Field(default="APA", max_length=20, description="Citation format: APA, MLA, Chicago, IEEE")

    # Usage tracking
    use_count: int = Field(default=0, description="Number of times this template has been used")
    last_used_at: datetime | None = Field(default=None, description="Last time this template was used")

    # (no relationships to User - managed by Kotlin backend)


# =============================================================================
# SESSION-LEVEL RESEARCH DATA
# =============================================================================


class ResearchPlan(BaseModel, table=True):
    """
    Research plan generated for a deep research query.

    Each deep research message creates one research plan that tracks
    the entire research lifecycle from planning through synthesis.
    """

    __tablename__ = "research_plans"
    __table_args__ = (
        Index("ix_research_plans_status", "status"),
        {"extend_existing": True},
    )

    # id, created_at, updated_at inherited from BaseModel

    # Owning user (plain UUID, no FK — users table is owned by Kotlin). Lets us
    # find a user's active research across ALL their sessions/devices, so the
    # panel shows on a second device and we can enforce one active run per user.
    # Nullable for backfill safety on existing rows.
    user_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            ScrapalotUUID(),
            nullable=True,
            index=True,
        ),
    )

    # Link to chat session and message (plain UUIDs, no FK — tables owned by Kotlin)
    session_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            nullable=False,
            index=True,
        )
    )
    message_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            nullable=False,
            index=True,
        )
    )

    # Optional template reference
    template_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("research_templates.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # Clarification session link (plain UUID, no FK — clarification_sessions table is Python-owned)
    clarification_session_id: UUID | None = Field(
        default=None,
        sa_column=Column(ScrapalotUUID(), nullable=True),
    )
    clarification_context: dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(ScrapalotJSON(), nullable=True),
        description="Full Q&A context from clarification session",
    )

    # Research query and plan
    query: str = Field(sa_column=Column(Text, nullable=False), description="Original user query")
    methodology: str = Field(default="analytical", max_length=50)

    # Plan structure (from the research planner)
    sections: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Research sections with questions and objectives",
    )
    complexity_score: float = Field(
        default=0.5,
        sa_column=Column(Float, nullable=False, server_default="0.5"),
        description="Query complexity score (0.0-1.0)",
    )
    estimated_sources: int = Field(default=10, description="Estimated number of sources needed")

    # Execution status
    status: str = Field(
        default="pending",
        max_length=20,
        description="Status: pending, planning, executing, synthesizing, completed, failed",
    )
    progress: float = Field(
        default=0.0,
        sa_column=Column(Float, nullable=False, server_default="0.0"),
        description="Overall progress (0.0-1.0)",
    )

    # Timing
    started_at: datetime | None = Field(default=None)
    completed_at: datetime | None = Field(default=None)

    # Error tracking
    error_message: str | None = Field(default=None, sa_column=Column(Text, nullable=True))

    # Structured discoveries (synthesis output)
    discoveries: list[dict[str, Any]] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
        description="Structured findings extracted from synthesis report",
    )

    # Iterative research state (AI Scientist)
    iteration_count: int = Field(default=1, description="Number of research iterations completed")
    research_state: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Serialized ResearchIterationState — persists across iterations",
    )

    # Council deliberation (strategy council output)
    council_deliberation: dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(ScrapalotJSONB(), nullable=True),
    )

    # Relationships
    template: Optional["ResearchTemplate"] = Relationship()
    tasks: list["ResearchTask"] = Relationship(back_populates="plan", sa_relationship_kwargs={"cascade": "all, delete-orphan"})
    sources: list["ResearchSource"] = Relationship(back_populates="plan", sa_relationship_kwargs={"cascade": "all, delete-orphan"})
    synthesis: Optional["ResearchSynthesis"] = Relationship(
        back_populates="plan", sa_relationship_kwargs={"uselist": False, "cascade": "all, delete-orphan"}
    )


class ResearchTask(BaseModel, table=True):
    """
    Individual research task decomposed from a research plan.

    Tasks are created during (task decomposition) and track
    the execution of specific research sub-objectives.
    """

    __tablename__ = "research_tasks"
    __table_args__ = (
        Index("ix_research_tasks_status", "status"),
        Index("ix_research_tasks_agent_type", "agent_type"),
        {"extend_existing": True},
    )

    # id, created_at, updated_at inherited from BaseModel

    plan_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("research_plans.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )
    )

    # Task definition
    task_index: int = Field(description="Order of this task in the plan")
    title: str = Field(max_length=500, description="Task title/objective")
    description: str | None = Field(default=None, sa_column=Column(Text, nullable=True))

    # Agent assignment (from coordinator)
    agent_type: str = Field(max_length=50, description="Agent type: geographic, temporal, statistical, policy, synthesis, etc.")
    parallel_group: int = Field(default=0, description="Tasks in same group can run in parallel")
    dependencies: list[str] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
        description="List of task IDs this task depends on",
    )

    # Execution
    status: str = Field(default="pending", max_length=20, description="Status: pending, running, completed, failed, skipped")
    progress: float = Field(default=0.0, sa_column=Column(Float, nullable=False, server_default="0.0"))

    # Results
    findings: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Research findings from this task",
    )
    quality_score: float | None = Field(default=None, sa_column=Column(Float, nullable=True), description="Quality score of task output (0.0-1.0)")

    # Timing
    started_at: datetime | None = Field(default=None)
    completed_at: datetime | None = Field(default=None)

    # Error tracking
    error_message: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    retry_count: int = Field(default=0)

    # Relationships
    plan: Optional["ResearchPlan"] = Relationship(back_populates="tasks")


class ResearchSource(BaseModel, table=True):
    """
    Web source collected and evaluated during research.

    Sources are discovered during web search enhancement
    and include credibility and quality assessments.
    """

    __tablename__ = "research_sources"
    __table_args__ = (
        Index("ix_research_sources_credibility_score", "credibility_score"),
        {"extend_existing": True},
    )

    # id, created_at, updated_at inherited from BaseModel

    plan_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("research_plans.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        )
    )

    # Source identification
    url: str = Field(sa_column=Column(Text, nullable=False), description="Source URL")
    title: str | None = Field(default=None, max_length=500, description="Page/article title")
    domain: str | None = Field(default=None, max_length=255, description="Source domain")
    source_type: str | None = Field(default=None, max_length=50, description="Type: academic, news, government, technical, blog, etc.")

    # Content
    content_snippet: str | None = Field(
        default=None, sa_column=Column(Text, nullable=True), description="Extracted content snippet (first 2000 chars)"
    )
    extracted_data: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Structured data extracted from source",
    )

    # Quality assessment (from source evaluator)
    credibility_score: float = Field(
        default=0.5,
        sa_column=Column(Float, nullable=False, server_default="0.5"),
        description="Credibility score (0.0-1.0)",
    )
    bias_score: float = Field(
        default=0.0,
        sa_column=Column(Float, nullable=False, server_default="0.0"),
        description="Bias score (0.0-1.0, higher = more biased)",
    )
    quality_indicators: dict[str, float] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Detailed quality breakdown",
    )

    # Usage in synthesis
    used_in_synthesis: bool = Field(default=False, description="Whether this source was used in final report")
    citation_count: int = Field(default=0, description="Number of citations in final report")

    # Metadata
    fetched_at: datetime | None = Field(default=None)
    evaluation_completed: bool = Field(default=False)

    # Relationships
    plan: Optional["ResearchPlan"] = Relationship(back_populates="sources")


class ResearchSynthesis(BaseModel, table=True):
    """
    Final synthesis and quality assurance results for a research plan.

    Created during synthesis & QA, containing the final report,
    quality scores, and validation results.
    """

    __tablename__ = "research_synthesis"
    __table_args__ = (
        Index("ix_research_synthesis_quality_score", "quality_score"),
        {"extend_existing": True},
    )

    # id, created_at, updated_at inherited from BaseModel

    plan_id: UUID = Field(
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("research_plans.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
            unique=True,
        )
    )

    # Report content
    title: str = Field(max_length=500, description="Report title")
    executive_summary: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    main_content: str | None = Field(default=None, sa_column=Column(Text, nullable=True), description="Full synthesized report content (markdown)")
    sections: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Structured report sections",
    )

    # Conclusions and recommendations
    conclusions: list[str] = Field(default_factory=list, sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"))
    limitations: list[str] = Field(default_factory=list, sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"))
    recommendations: list[str] = Field(default_factory=list, sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"))

    # Citations and bibliography
    citations: list[dict[str, str]] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
        description="In-text citation references",
    )
    bibliography: list[dict[str, str]] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
        description="Full bibliography entries",
    )
    citation_style: str = Field(default="APA", max_length=20)

    # Quality assurance results
    quality_score: float = Field(
        default=0.0,
        sa_column=Column(Float, nullable=False, server_default="0.0"),
        description="Overall quality score (0.0-1.0)",
    )
    quality_dimensions: dict[str, float] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Scores for: accuracy, completeness, consistency, citation, balance",
    )
    validation_results: dict[str, bool] = Field(
        default_factory=dict,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="{}"),
        description="Validation check results",
    )

    # Cross-source validation
    claims_validated: int = Field(default=0, description="Number of claims cross-validated")
    contradictions_found: int = Field(default=0, description="Number of contradictions detected")
    contradiction_resolutions: list[dict[str, str]] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
        description="How contradictions were resolved",
    )

    # Statistics
    total_sources_used: int = Field(default=0)
    word_count: int = Field(default=0)

    # Metadata
    synthesis_completed_at: datetime | None = Field(default=None)
    qa_completed_at: datetime | None = Field(default=None)

    # Relationships
    plan: Optional["ResearchPlan"] = Relationship(back_populates="synthesis")


# =============================================================================
# CLARIFICATION SESSION (AI Scientist)
# =============================================================================


class ClarificationSession(BaseModel, table=True):
    """
    Persists the full clarification flow for a research query.

    State machine: created → questions_generated → answers_submitted
                   → plan_generated → approved / expired
    """

    __tablename__ = "clarification_sessions"
    __table_args__ = (
        Index("ix_clarification_sessions_user", "user_id"),
        Index("ix_clarification_sessions_status", "status"),
        {"extend_existing": True},
    )

    # User and session link (plain UUIDs, no FK)
    user_id: UUID = Field(sa_column=Column(ScrapalotUUID(), nullable=False, index=True))
    session_id: UUID | None = Field(default=None, sa_column=Column(ScrapalotUUID(), nullable=True))

    # Query and template
    initial_query: str = Field(sa_column=Column(Text, nullable=False))
    template_type: str | None = Field(default=None, max_length=50)

    # Clarification data
    questions: list[dict[str, Any]] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
    )
    answers: list[dict[str, Any]] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
    )
    plan_preview: dict[str, Any] | None = Field(
        default=None,
        sa_column=Column(ScrapalotJSON(), nullable=True),
    )
    plan_feedback: list[dict[str, Any]] = Field(
        default_factory=list,
        sa_column=Column(ScrapalotJSON(), nullable=False, server_default="[]"),
        description="[{feedback, previous_plan, regenerated_plan, timestamp}]",
    )

    # State
    status: str = Field(
        default="created",
        max_length=30,
        description="created, questions_generated, answers_submitted, plan_generated, approved, expired",
    )


# =============================================================================
# PAPER GENERATION (AI Scientist)
# =============================================================================


class CollectionPodcast(BaseModel, table=True):
    """NotebookLM-style two-host audio overview of a collection.

    The MP3 itself is written to disk under the user's upload tree; this row
    tracks generation status + the final script (so the UI can show a
    transcript next to the player without re-calling the LLM).
    """

    __tablename__ = "collection_podcasts"
    __table_args__ = (
        Index("idx_collection_podcasts_collection", "collection_id", "created_at"),
        Index("idx_collection_podcasts_user", "user_id"),
        {"extend_existing": True},
    )

    collection_id: UUID = Field(sa_column=Column(ScrapalotUUID(), nullable=False))
    user_id: UUID = Field(sa_column=Column(ScrapalotUUID(), nullable=False))
    language: str = Field(default="en", max_length=8)
    status: str = Field(
        default="pending",
        max_length=32,
        description="pending | generating_script | rendering_audio | completed | failed",
    )
    title: str | None = Field(default=None, max_length=500)
    file_path: str | None = Field(
        default=None,
        sa_column=Column(Text, nullable=True),
        description="Relative path under user's upload tree",
    )
    file_size: int | None = Field(default=None)
    duration_ms: int | None = Field(default=None)
    script_json: Any | None = Field(
        default=None,
        sa_column=Column("script_json", ScrapalotJSONB(), nullable=True),
    )
    error: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    completed_at: datetime | None = Field(default=None)


class Paper(BaseModel, table=True):
    """Generated paper from deep research + notes content."""

    __tablename__ = "papers"
    __table_args__ = (
        Index("idx_papers_user", "user_id"),
        Index("idx_papers_workspace", "workspace_id", "created_at"),
        {"extend_existing": True},
    )

    user_id: str = Field(max_length=255)
    workspace_id: str = Field(max_length=255)
    research_plan_id: UUID | None = Field(
        default=None,
        sa_column=Column(
            ScrapalotUUID(),
            ForeignKey("research_plans.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    note_id: str | None = Field(default=None, max_length=255)
    template_key: str = Field(max_length=50)
    title: str | None = Field(default=None, max_length=500)
    status: str = Field(default="pending", max_length=20, description="pending, processing, completed, failed")
    output_format: str = Field(default="pdf", max_length=10)
    file_path: str | None = Field(default=None, max_length=500)
    paper_metadata: dict[str, Any] | None = Field(
        default=None,
        sa_column=Column("metadata", ScrapalotJSON(), nullable=True),
    )
    error_message: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    word_count: int | None = Field(default=None)
    page_count: int | None = Field(default=None)
    completed_at: datetime | None = Field(default=None)
