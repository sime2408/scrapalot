"""
Packet emission service for managing streaming responses.
"""

import json
from typing import Any, Literal

from src.main.dto.streaming import (
    AgentPoolStatusPacket,
    AgentStatusPacket,
    AudioDeltaPacket,
    CitationDeltaPacket,
    CitationInfoPacket,
    CitationStartPacket,
    ContentExtractionPacket,
    CoordinationPlanPacket,
    CoordinationQualityGatePacket,
    ErrorPacket,
    ImageAttachedPacket,
    InterAgentCommunicationPacket,
    MessageDeltaPacket,
    MessageStartPacket,
    ModelInsightDeltaPacket,
    ModelInsightStartPacket,
    Packet,
    ParallelGroupPacket,
    PlanningProgressPacket,
    QualityGatePacket,
    RagDebugInfoPacket,
    ReasoningDeltaPacket,
    ReasoningStartPacket,
    ResearchPlanPacket,
    ResearchQueryPacket,
    ResearchResultPacket,
    ResearchSectionPacket,
    ResearchStartPacket,
    ResearchThinkingPacket,
    ResultRankingPacket,
    SearchFusionPacket,
    SearchProgressPacket,
    SearchStrategyPacket,
    SectionEndPacket,
    SourceEvaluationPacket,
    StatusPacket,
    StreamEndPacket,
    StreamPacket,
    TaskCoordinationPacket,
    TaskDecompositionPlanPacket,
    TaskExecutionPacket,
    ToolDeltaPacket,
    ToolStartPacket,
    TranscriptionFinalPacket,
    TranscriptionPartialPacket,
)
from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


class PacketEmitter:
    """Manages packet emission with automatic indexing"""

    def __init__(self, buffer_mode=False):
        self.packet_index = 0
        self.buffer_mode = buffer_mode
        self.buffer = [] if buffer_mode else None

    def emit(self, packet_obj: StreamPacket) -> str:
        """
        Emit a packet and return its JSON representation.

        Args:
            packet_obj: The packet object to emit

        Returns:
            JSON string representation of the packet
        """
        packet = Packet(ind=self.packet_index, obj=packet_obj)
        self.packet_index += 1

        # Log packet emission at DEBUG level (not INFO to avoid noise)
        packet_type = getattr(packet_obj, "type", "unknown")

        # Log important packets at INFO level for visibility
        if packet_type in [
            "planning_progress",
            "research_plan",
            "task_decomposition",
            "synthesis_start",
            "validation_start",
            "quality_assessment",
            "research_step_start",
            "research_step_complete",
            "research_gap_analysis",
        ]:
            # For progress packets, include the progress value
            if packet_type == "planning_progress" and hasattr(packet_obj, "progress"):
                # noinspection PyUnresolvedReferences
                logger.info("Emitted packet: %s (progress: %.1f%%)", packet_type, packet_obj.progress * 100)
            else:
                logger.info("Emitted packet: %s", packet_type)
        else:
            logger.debug("Emitted packet [%d]: %s", self.packet_index - 1, packet_type)

        json_str = packet.model_dump_json() + "\n"

        # If in buffer mode, store the packet instead of returning it
        if self.buffer_mode and self.buffer is not None:
            self.buffer.append(json_str)

        return json_str

    def emit_custom(self, packet_type: str, content: Any) -> str:
        """
        Emit a custom packet that doesn't fit predefined types.

        This is used for flexible packet types like routing_decision, strategy_selected, etc.
        that don't conform to the StreamPacket discriminated union.

        Args:
            packet_type: The type string for the packet
            content: The content payload (can be any JSON-serializable structure)

        Returns:
            JSON string representation of the packet with proper indexing
        """
        packet_dict = {
            "ind": self.packet_index,
            "obj": {
                "type": packet_type,
                "content": content,
            },
        }
        self.packet_index += 1

        json_str = json.dumps(packet_dict) + "\n"

        # If in buffer mode, store the packet instead of returning it
        if self.buffer_mode and self.buffer is not None:
            self.buffer.append(json_str)

        return json_str

    def emit_message_start(self, content: str = "", **kwargs) -> str:
        """Convenience method for message start"""
        return self.emit(MessageStartPacket(content=content, **kwargs))

    def emit_message_delta(self, content: str) -> str:
        """Convenience method for message delta"""
        return self.emit(MessageDeltaPacket(content=content))

    def emit_rag_debug_info(self, **kwargs) -> str:
        """Convenience method for RAG debug info"""
        return self.emit(RagDebugInfoPacket(**kwargs))

    def emit_status(self, content: str, stage: str | None = None) -> str:
        """Convenience method for status updates"""
        return self.emit(StatusPacket(content=content, stage=stage))

    def emit_error(self, content: str, error_code: str | None = None, traceback: str | None = None) -> str:
        """Convenience method for errors"""
        return self.emit(ErrorPacket(content=content, error_code=error_code, traceback=traceback))

    def emit_audio_delta(
        self,
        *,
        conversation_id: str,
        audio_b64: str,
        mime_type: str = "audio/mpeg",
        sentence_index: int = 0,
        chunk_index: int = 0,
        is_final_chunk: bool = False,
    ) -> str:
        """Emit one streamed TTS audio chunk for the UI to play."""
        return self.emit(
            AudioDeltaPacket(
                conversation_id=conversation_id,
                audio_b64=audio_b64,
                mime_type=mime_type,
                sentence_index=sentence_index,
                chunk_index=chunk_index,
                is_final_chunk=is_final_chunk,
            )
        )

    def emit_transcription_partial(
        self,
        *,
        session_id: str,
        committed_text: str,
        mutable_text: str,
        chunk_index: int,
        language: str | None = None,
    ) -> str:
        """Emit a partial transcript while the user is still speaking."""
        return self.emit(
            TranscriptionPartialPacket(
                session_id=session_id,
                committed_text=committed_text,
                mutable_text=mutable_text,
                chunk_index=chunk_index,
                language=language,
            )
        )

    def emit_transcription_final(
        self,
        *,
        session_id: str,
        text: str,
        chunk_index: int,
        language: str | None = None,
        duration_s: float | None = None,
    ) -> str:
        """Emit the final consolidated transcript on speech-end."""
        return self.emit(
            TranscriptionFinalPacket(
                session_id=session_id,
                text=text,
                chunk_index=chunk_index,
                language=language,
                duration_s=duration_s,
            )
        )

    def emit_image_attached(
        self,
        *,
        message_id: str,
        storage_path: str,
        mime_type: str,
        idx: int = 0,
        total: int = 1,
        kind: Literal["image", "audio", "video", "document"] = "image",
        width: int | None = None,
        height: int | None = None,
        prompt: str | None = None,
        revised_prompt: str | None = None,
        model_name: str | None = None,
        cost_cents: int | None = None,
    ) -> str:
        """Emit one persisted artifact (image, audio clip, ...) for the UI to render."""
        return self.emit(
            ImageAttachedPacket(
                message_id=message_id,
                kind=kind,
                storage_path=storage_path,
                mime_type=mime_type,
                width=width,
                height=height,
                prompt=prompt,
                revised_prompt=revised_prompt,
                model_name=model_name,
                idx=idx,
                total=total,
                cost_cents=cost_cents,
            )
        )

    def emit_stream_end(
        self,
        reason: Literal["completed", "error", "cancelled", "clarification_needed", "plan_preview_ready"] = "completed",
        **kwargs,
    ) -> str:
        """Convenience method for stream end"""
        return self.emit(StreamEndPacket(reason=reason, **kwargs))

    def emit_citation_start(self) -> str:
        """Convenience method for citation start"""
        return self.emit(CitationStartPacket())

    def emit_citation_info(self, citation_num: int, document_id: str, document_title: str, **kwargs) -> str:
        """Convenience method for citation info"""
        return self.emit(CitationInfoPacket(citation_num=citation_num, document_id=document_id, document_title=document_title, **kwargs))

    def emit_citation_delta(self, citations: list[dict]) -> str:
        """Convenience method for citation batch"""
        return self.emit(CitationDeltaPacket(citations=citations))

    def emit_reasoning_start(self) -> str:
        """Convenience method for reasoning start"""
        return self.emit(ReasoningStartPacket())

    def emit_reasoning_delta(self, reasoning: str, streamed: bool = False) -> str:
        """Emit a reasoning ("thinking") delta.

        The reasoning channel carries two very different kinds of payload:

        * **Narration beats** (default, ``streamed=False``) — complete sentences
          emitted one step at a time (e.g. ``_narrate`` in agentic RAG). Each is
          a self-contained line, so we append a newline separator; without it the
          UI concatenates adjacent beats into ``...kolekcije.Koristim...``.
        * **Raw token deltas** (``streamed=True``) — sub-word fragments streamed
          from an LLM (DeepSeek ``reasoning_content``, HyDE/rewrite token loops).
          These MUST be forwarded verbatim; appending anything between fragments
          splits words apart (``K oris nik`` instead of ``Korisnik``).

        The separator lives in the packet payload so the frontend can always
        concatenate deltas verbatim regardless of source.
        """
        text = reasoning if streamed else reasoning + "\n"
        return self.emit(ReasoningDeltaPacket(reasoning=text))

    def emit_model_insight_start(self) -> str:
        """Convenience method for the start of the model-knowledge insight block"""
        return self.emit(ModelInsightStartPacket())

    def emit_model_insight_delta(self, content: str) -> str:
        """Convenience method for incremental model-knowledge insight content"""
        return self.emit(ModelInsightDeltaPacket(content=content))

    def emit_section_end(self) -> str:
        """Convenience method for section end"""
        return self.emit(SectionEndPacket())

    def emit_tool_start(self, tool_name: str, tool_params: dict | None = None) -> str:
        """Convenience method for tool start"""
        # noinspection PyTypeChecker
        return self.emit(ToolStartPacket(tool_name=tool_name, tool_params=tool_params))

    def emit_tool_artifact(
        self,
        *,
        artifact_id: str,
        tool_name: str,
        summary: str,
        size_bytes: int,
        expires_at,
    ) -> str:
        """File-artifact tool delivery.

        Emits a `tool_artifact` packet so the UI can show a compact pill
        ("📎 grep_search: 47 matches") instead of the full JSON. The LLM
        receives the same packet via the agent-side bridge and can decide
        whether to load the data via `read_artifact`.
        """
        from src.main.dto.streaming import ToolArtifactPacket

        return self.emit(
            ToolArtifactPacket(
                artifact_id=artifact_id,
                tool_name=tool_name,
                summary=summary,
                size_bytes=size_bytes,
                expires_at=expires_at,
            )
        )

    def emit_tool_delta(self, tool_name: str, content: str) -> str:
        """Convenience method for tool progress"""
        return self.emit(ToolDeltaPacket(tool_name=tool_name, content=content))

    def emit_research_start(
        self,
        search_type: Literal["web", "deep", "hybrid"],
        research_id: str | None = None,
    ) -> str:
        """Convenience method for research start"""
        return self.emit(ResearchStartPacket(search_type=search_type, research_id=research_id))

    def emit_research_query(self, query: str, search_engine: str | None = None) -> str:
        """Convenience method for research query"""
        return self.emit(ResearchQueryPacket(query=query, search_engine=search_engine))

    def emit_research_result(self, title: str, url: str, snippet: str, relevance_score: float | None = None) -> str:
        """Convenience method for research result"""
        return self.emit(ResearchResultPacket(title=title, url=url, snippet=snippet, relevance_score=relevance_score))

    def emit_research_plan(
        self,
        plan_title: str,
        sections: list[dict],
        methodology: str,
        estimated_duration: int,
        complexity_score: float,
        total_questions: int,
    ) -> str:
        """Convenience method for research plan"""
        return self.emit(
            ResearchPlanPacket(
                plan_title=plan_title,
                sections=sections,
                methodology=methodology,
                estimated_duration=estimated_duration,
                complexity_score=complexity_score,
                total_questions=total_questions,
            )
        )

    def emit_planning_progress(self, stage: str, progress: float, message: str = "", current_section: str | None = None) -> str:
        """Convenience method for planning progress"""
        return self.emit(PlanningProgressPacket(stage=stage, progress=progress, message=message, current_section=current_section))

    def emit_research_section(
        self,
        section_id: str,
        title: str,
        priority: int,
        status: str,
        progress: float = 0.0,
        sources_found: int = 0,
        research_questions: list[str] | None = None,
    ) -> str:
        """Convenience method for research section"""
        return self.emit(
            ResearchSectionPacket(
                section_id=section_id,
                title=title,
                priority=priority,
                status=status,
                progress=progress,
                sources_found=sources_found,
                research_questions=research_questions or [],
            )
        )

    def emit_research_thinking(self, stage: str, content: str, confidence: float | None = None) -> str:
        """Convenience method for research thinking"""
        return self.emit(ResearchThinkingPacket(stage=stage, content=content, confidence=confidence))

    # ============================================================================
    # TASK EXECUTION PACKET METHODS -
    # ============================================================================

    def emit_task_decomposition_plan(self, total_tasks: int, parallel_groups: int, estimated_duration: int, critical_path_length: int) -> str:
        """Convenience method for task decomposition plan"""
        return self.emit(
            TaskDecompositionPlanPacket(
                total_tasks=total_tasks,
                parallel_groups=parallel_groups,
                estimated_duration=estimated_duration,
                critical_path_length=critical_path_length,
            )
        )

    def emit_task_execution(self, task_id: str, task_title: str, status: str, agent_type: str, progress: float | None = None) -> str:
        """Convenience method for task execution status"""
        return self.emit(TaskExecutionPacket(task_id=task_id, task_title=task_title, status=status, agent_type=agent_type, progress=progress))

    def emit_parallel_group(self, group_id: int, task_count: int, status: str, completion_percentage: float) -> str:
        """Convenience method for parallel group status"""
        return self.emit(ParallelGroupPacket(group_id=group_id, task_count=task_count, status=status, completion_percentage=completion_percentage))

    def emit_quality_gate(self, gate_name: str, status: str, quality_metrics: dict[str, float] | None = None) -> str:
        """Convenience method for quality gate results"""
        return self.emit(QualityGatePacket(gate_name=gate_name, status=status, quality_metrics=quality_metrics or {}))

    def emit_task_coordination(self, stage: str, active_tasks: int, completed_tasks: int, failed_tasks: int, overall_progress: float) -> str:
        """Convenience method for task coordination progress"""
        return self.emit(
            TaskCoordinationPacket(
                stage=stage,
                active_tasks=active_tasks,
                completed_tasks=completed_tasks,
                failed_tasks=failed_tasks,
                overall_progress=overall_progress,
            )
        )

    # ============================================================================
    # MULTI-AGENT COORDINATION PACKET METHODS
    # ============================================================================

    def emit_coordination_plan(self, total_agents: int, agent_types: list[str], execution_phases: int, estimated_duration: int) -> str:
        """Convenience method for coordination plan initialization"""
        return self.emit(
            CoordinationPlanPacket(
                total_agents=total_agents,
                agent_types=agent_types,
                execution_phases=execution_phases,
                estimated_duration=estimated_duration,
            )
        )

    def emit_agent_status(self, agent_id: str, agent_type: str, status: str, current_task: str | None = None, progress: float = 0.0) -> str:
        """Convenience method for agent status updates"""
        return self.emit(AgentStatusPacket(agent_id=agent_id, agent_type=agent_type, status=status, current_task=current_task, progress=progress))

    def emit_inter_agent_communication(self, sender_agent: str, recipient_agent: str, communication_type: str, summary: str) -> str:
        """Convenience method for inter-agent communication"""
        return self.emit(
            InterAgentCommunicationPacket(
                sender_agent=sender_agent,
                recipient_agent=recipient_agent,
                communication_type=communication_type,
                summary=summary,
            )
        )

    def emit_coordination_quality_gate(self, phase_name: str, agents_validated: list[str], quality_scores: dict[str, float], gate_status: str) -> str:
        """Convenience method for coordination quality gates"""
        return self.emit(
            CoordinationQualityGatePacket(
                phase_name=phase_name,
                agents_validated=agents_validated,
                quality_scores=quality_scores,
                gate_status=gate_status,
            )
        )

    def emit_agent_pool_status(
        self,
        total_agents: int,
        active_agents: int,
        idle_agents: int,
        agent_type_distribution: dict[str, int] | None = None,
        resource_utilization: float = 0.0,
    ) -> str:
        """Convenience method for agent pool status"""
        return self.emit(
            AgentPoolStatusPacket(
                total_agents=total_agents,
                active_agents=active_agents,
                idle_agents=idle_agents,
                agent_type_distribution=agent_type_distribution or {},
                resource_utilization=resource_utilization,
            )
        )

    # ============================================================================
    # Enhanced Search and Data Collection Emissions
    # ============================================================================

    def emit_search_strategy_start(self, task_id: str, _query_type: str, complexity: float) -> str:
        """Emit search strategy generation start"""
        return self.emit_status(f"Generating search strategy for task {task_id} (complexity: {complexity:.1f})", stage="search_strategy")

    def emit_search_strategy_completed(self, _strategy_id: str, total_queries: int, providers_allocated: list[str], expected_sources: int) -> str:
        """Convenience method for search strategy completion"""
        return self.emit(
            SearchStrategyPacket(
                total_queries=total_queries,
                providers_allocated=providers_allocated,
                expected_sources=expected_sources,
                strategy_type="ai_generated",
            )
        )

    def emit_source_evaluation_start(self, source_url: str, _evaluation_type: str) -> str:
        """Emit source evaluation start"""
        return self.emit(SourceEvaluationPacket(source_url=source_url, evaluation_status="evaluating"))

    def emit_source_evaluation_completed(self, source_url: str, credibility_score: float, bias_score: float) -> str:
        """Convenience method for source evaluation completion"""
        return self.emit(
            SourceEvaluationPacket(
                source_url=source_url,
                credibility_score=credibility_score,
                bias_score=bias_score,
                evaluation_status="completed",
            )
        )

    def emit_search_progress(
        self,
        provider: str,
        queries_completed: int,
        total_queries: int,
        sources_found: int,
        quality_score: float | None = None,
    ) -> str:
        """Convenience method for search progress updates"""
        return self.emit(
            SearchProgressPacket(
                provider=provider,
                queries_completed=queries_completed,
                total_queries=total_queries,
                sources_found=sources_found,
                quality_score=quality_score,
            )
        )

    def emit_content_extraction_start(self, source_url: str, extraction_type: str, data_types: list[str] | None = None) -> str:
        """Emit content extraction start"""
        return self.emit(
            ContentExtractionPacket(
                source_url=source_url,
                extraction_type=extraction_type,
                progress=0.0,
                data_extracted={"types_requested": data_types or []},
            )
        )

    def emit_content_extraction_completed(self, source_url: str, extraction_type: str, data_extracted: int, confidence_score: float) -> str:
        """Convenience method for content extraction completion"""
        return self.emit(
            ContentExtractionPacket(
                source_url=source_url,
                extraction_type=extraction_type,
                progress=1.0,
                data_extracted={"items_extracted": data_extracted, "confidence": confidence_score},
            )
        )

    def emit_search_fusion_start(self, _provider_count: int, total_sources: int) -> str:
        """Emit search result fusion start"""
        return self.emit(SearchFusionPacket(phase="deduplication", original_sources=total_sources, fused_results=0))

    def emit_search_fusion_completed(self, original_sources: int, fused_results: int, deduplication_ratio: float) -> str:
        """Convenience method for search fusion completion"""
        return self.emit(
            SearchFusionPacket(
                phase="completed",
                original_sources=original_sources,
                fused_results=fused_results,
                deduplication_ratio=deduplication_ratio,
            )
        )

    def emit_result_ranking_start(self, _result_count: int, ranking_strategy: str) -> str:
        """Emit result ranking start"""
        return self.emit(ResultRankingPacket(ranking_strategy=ranking_strategy, results_processed=0))

    def emit_result_ranking_completed(self, ranked_results: int, average_relevance: float, quality_threshold: float) -> str:
        """Convenience method for result ranking completion"""
        return self.emit(
            ResultRankingPacket(
                ranking_strategy="completed",
                results_processed=ranked_results,
                average_relevance=average_relevance,
                quality_threshold=quality_threshold,
            )
        )

    # ============================================================================
    # Synthesis & Quality Assurance Packet Methods
    # ============================================================================

    def emit_synthesis_start(self, status: str, total_sources: int, synthesis_style: str) -> str:
        """Convenience method for synthesis start"""
        from src.main.dto.streaming import SynthesisStartPacket

        # noinspection PyArgumentList
        return self.emit(SynthesisStartPacket(status=status, total_sources=total_sources, synthesis_style=synthesis_style))

    # noinspection PyUnusedLocal
    def emit_synthesis_delta(self, content: str, progress: float, current_stage: str | None = None) -> str:
        """Convenience method for synthesis progress"""
        from src.main.dto.streaming import SynthesisDeltaPacket

        return self.emit(SynthesisDeltaPacket(content=content, progress=progress))

    def emit_validation_start(self, status: str, total_sources: int, validation_depth: str) -> str:
        """Convenience method for validation start"""
        from src.main.dto.streaming import ValidationStartPacket

        return self.emit(ValidationStartPacket(status=status, total_sources=total_sources, validation_depth=validation_depth))

    def emit_validation_result(
        self,
        reliability_score: float,
        contradictions_count: int,
        high_credibility_sources: int,
        validation_summary: str,
    ) -> str:
        """Convenience method for validation results"""
        from src.main.dto.streaming import ValidationResultPacket

        return self.emit(
            ValidationResultPacket(
                reliability_score=reliability_score,
                contradictions_count=contradictions_count,
                high_credibility_sources=high_credibility_sources,
                validation_summary=validation_summary,
            )
        )

    def emit_quality_assessment_start(self, quality_standard: str, _assessment_dimensions: list[str]) -> str:
        """Convenience method for quality assessment start"""
        return self.emit_status(f"Starting quality assessment with {quality_standard} standard", stage="quality_assessment")

    def emit_quality_assessment_result(
        self,
        overall_quality_score: float,
        quality_level: str,
        _academic_readiness: bool,
        _improvement_priorities: list[str] | None = None,
    ) -> str:
        """Convenience method for quality assessment results"""
        return self.emit_status(
            f"Quality assessment completed: {quality_level} (Score: {overall_quality_score:.2f})",
            stage="quality_assessment_complete",
        )

    def emit_citation_processing_start(self, _total_sources: int, _citation_style: str) -> str:
        """Convenience method for citation processing start"""
        return self.emit_citation_start()

    def emit_citation_processing_complete(self, total_citations: int, _bibliography_generated: bool, citation_style: str) -> str:
        """Convenience method for citation processing completion"""
        return self.emit_status(f"Citations processed: {total_citations} sources in {citation_style} style", stage="citations_complete")

    def emit_clarification_questions(self, questions: list[dict], request_id: str, research_context: str) -> str:
        """Emit clarification questions before deep research begins."""
        from src.main.dto.streaming import ClarificationQuestionsPacket

        return self.emit(
            ClarificationQuestionsPacket(
                questions=questions,
                request_id=request_id,
                research_context=research_context,
            )
        )

    def emit_plan_preview(
        self,
        plan_id: str,
        title: str,
        objective: str,
        methodology: str,
        sections: list[dict],
        total_questions: int = 0,
        estimated_sources: int = 0,
        source_types: list[str] | None = None,
        estimated_duration_minutes: int = 5,
    ) -> str:
        """Emit a research plan preview after clarification, before full research begins."""
        from src.main.dto.streaming import PlanPreviewPacket, PlanPreviewSection

        return self.emit(
            PlanPreviewPacket(
                plan_id=plan_id,
                title=title,
                objective=objective,
                methodology=methodology,
                sections=[PlanPreviewSection(**s) for s in sections],
                total_questions=total_questions,
                estimated_sources=estimated_sources,
                source_types=source_types or [],
                estimated_duration_minutes=estimated_duration_minutes,
            )
        )

    def emit_research_report(
        self,
        plan_id: str,
        title: str,
        executive_summary: str,
        full_report_markdown: str,
        quality_score: float | None = None,
        total_sources: int = 0,
        word_count: int = 0,
    ) -> str:
        """Emit the final research report in Markdown format."""
        from src.main.dto.streaming import ResearchReportPacket

        return self.emit(
            ResearchReportPacket(
                plan_id=plan_id,
                title=title,
                executive_summary=executive_summary,
                full_report_markdown=full_report_markdown,
                quality_score=quality_score,
                total_sources=total_sources,
                word_count=word_count,
            )
        )

    def emit_discovery_start(self, total_sources: int = 0) -> str:
        """Emit discovery extraction start."""
        from src.main.dto.streaming import DiscoveryStartPacket

        return self.emit(DiscoveryStartPacket(total_sources=total_sources))

    def emit_discovery(
        self,
        discovery_index: int,
        title: str,
        claim: str,
        summary: str,
        evidence_count: int,
        confidence: float,
        category: str,
        novelty: str = "",
        sources: list = None,
        tags: list = None,
    ) -> str:
        """Emit a single structured discovery."""
        from src.main.dto.streaming import DiscoveryPacket

        return self.emit(
            DiscoveryPacket(
                discovery_index=discovery_index,
                title=title,
                claim=claim,
                summary=summary,
                evidence_count=evidence_count,
                confidence=confidence,
                category=category,
                novelty=novelty,
                sources=sources or [],
                tags=tags or [],
            )
        )

    def emit_discovery_complete(self, total_discoveries: int, average_confidence: float = 0.0) -> str:
        """Emit discovery extraction completion."""
        from src.main.dto.streaming import DiscoveryCompletePacket

        return self.emit(
            DiscoveryCompletePacket(
                total_discoveries=total_discoveries,
                average_confidence=average_confidence,
            )
        )

    # ============================================================================
    # PAPER GENERATION: Progress and completion packets
    # ============================================================================

    def emit_paper_progress(
        self,
        stage: str,
        progress: float,
        current_section: str | None = None,
        sections_completed: int | None = None,
        sections_total: int | None = None,
    ) -> str:
        """Emit paper generation progress update."""
        from src.main.dto.streaming import PaperProgressPacket

        # noinspection PyTypeChecker
        return self.emit(
            PaperProgressPacket(
                stage=stage,
                progress=progress,
                current_section=current_section,
                sections_completed=sections_completed,
                sections_total=sections_total,
            )
        )

    def emit_paper_complete(
        self,
        paper_id: str,
        download_url: str,
        fmt: str = "pdf",
        page_count: int | None = None,
        word_count: int | None = None,
    ) -> str:
        """Emit paper generation completion."""
        from src.main.dto.streaming import PaperCompletePacket

        # noinspection PyTypeChecker
        return self.emit(
            PaperCompletePacket(
                paper_id=paper_id,
                download_url=download_url,
                format=fmt,
                page_count=page_count,
                word_count=word_count,
            )
        )

    def emit_paper_error(self, error: str, stage: str, recoverable: bool = False) -> str:
        """Emit paper generation error."""
        from src.main.dto.streaming import PaperErrorPacket

        # noinspection PyTypeChecker
        return self.emit(PaperErrorPacket(error=error, stage=stage, recoverable=recoverable))

    # ============================================================================
    # ITERATIVE RESEARCH: Iteration lifecycle packets
    # ============================================================================

    def emit_iteration_start(self, iteration: int, max_iterations: int, current_objective: str, evolving_objective: str) -> str:
        """Emit iteration start."""
        from src.main.dto.streaming import IterationStartPacket

        return self.emit(
            IterationStartPacket(
                iteration=iteration,
                max_iterations=max_iterations,
                current_objective=current_objective,
                evolving_objective=evolving_objective,
            )
        )

    def emit_iteration_complete(self, iteration: int, total_insights: int, has_hypothesis: bool, will_continue: bool) -> str:
        """Emit iteration completion."""
        from src.main.dto.streaming import IterationCompletePacket

        return self.emit(
            IterationCompletePacket(
                iteration=iteration,
                total_insights=total_insights,
                has_hypothesis=has_hypothesis,
                will_continue=will_continue,
            )
        )

    def emit_reflection_complete(
        self, evolving_objective: str, current_objective: str, key_insights: list[str], methodology: str, iteration: int
    ) -> str:
        """Emit reflection completion with updated state."""
        from src.main.dto.streaming import ReflectionCompletePacket

        return self.emit(
            ReflectionCompletePacket(
                evolving_objective=evolving_objective,
                current_objective=current_objective,
                key_insights=key_insights,
                methodology=methodology,
                iteration=iteration,
            )
        )

    def emit_continuation_decision(self, should_continue: bool, reasoning: str, confidence: str, trigger_reason: str | None, iteration: int) -> str:
        """Emit continue/stop decision."""
        from src.main.dto.streaming import ContinuationDecisionPacket

        return self.emit(
            ContinuationDecisionPacket(
                should_continue=should_continue,
                reasoning=reasoning,
                confidence=confidence,
                trigger_reason=trigger_reason,
                iteration=iteration,
            )
        )

    def emit_hypothesis(
        self,
        hypothesis: str,
        rationale: str,
        novelty_statement: str = "",
        experimental_design: str | None = None,
        iteration: int = 1,
    ) -> str:
        """Emit hypothesis generation/refinement."""
        from src.main.dto.streaming import HypothesisPacket

        return self.emit(
            HypothesisPacket(
                hypothesis=hypothesis,
                rationale=rationale,
                novelty_statement=novelty_statement,
                experimental_design=experimental_design,
                iteration=iteration,
            )
        )

    def emit_iteration_state(self, state) -> str:
        """Emit full iteration state snapshot."""
        from src.main.dto.streaming import IterationStatePacket

        return self.emit(
            IterationStatePacket(
                objective=state.objective,
                evolving_objective=state.evolving_objective,
                current_objective=state.current_objective,
                key_insights=state.key_insights,
                methodology=state.methodology,
                current_hypothesis=state.current_hypothesis,
                iteration_count=state.iteration_count,
                max_iterations=state.max_iterations,
                discoveries=state.discoveries,
            )
        )

    # ============================================================================
    # CONSCIOUSNESS COUNCIL PACKETS (Feature 4)
    # ============================================================================

    def emit_council_start(self, members: list[str], selection_reason: str = "") -> str:
        """Emit the convening of the council with its selected archetypes."""
        from src.main.dto.streaming import CouncilStartPacket

        return self.emit(
            CouncilStartPacket(
                members=list(members),
                selection_reason=selection_reason,
            )
        )

    def emit_council_member(
        self,
        member_index: int,
        total_members: int,
        archetype: str,
        label: str,
        emoji: str,
        position: str,
        reasoning: str,
        key_risk: str,
        surprising_insight: str,
    ) -> str:
        """Emit a single archetype's contribution to the deliberation."""
        from src.main.dto.streaming import CouncilMemberPacket

        return self.emit(
            CouncilMemberPacket(
                member_index=member_index,
                total_members=total_members,
                archetype=archetype,
                label=label,
                emoji=emoji,
                position=position,
                reasoning=reasoning,
                key_risk=key_risk,
                surprising_insight=surprising_insight,
            )
        )

    def emit_council_synthesis(
        self,
        convergence_points: list[str],
        core_tension: str,
        blind_spot: str,
        recommended_path: str,
        confidence: str,
        question_to_sit_with: str,
        tension_edges: list[dict] | None = None,
    ) -> str:
        """Emit the council's synthesis across all members."""
        from src.main.dto.streaming import CouncilSynthesisPacket

        return self.emit(
            CouncilSynthesisPacket(
                convergence_points=list(convergence_points),
                core_tension=core_tension,
                blind_spot=blind_spot,
                recommended_path=recommended_path,
                confidence=confidence,
                question_to_sit_with=question_to_sit_with,
                tension_edges=list(tension_edges or []),
            )
        )

    # ============================================================================
    # DEEP RESEARCH v2: Agent Persona, Source Curation, Cost Tracking
    # ============================================================================

    def emit_agent_persona(self, persona_name: str, persona_emoji: str, persona_prompt: str, domain: str) -> str:
        """Emit the selected research persona."""
        from src.main.dto.streaming import AgentPersonaPacket

        return self.emit(
            AgentPersonaPacket(
                persona_name=persona_name,
                persona_emoji=persona_emoji,
                persona_prompt=persona_prompt,
                domain=domain,
            )
        )

    def emit_source_curation(
        self,
        status: str,
        total_sources: int,
        curated_count: int = 0,
        dropped_count: int = 0,
        dropped_reasons: list[str] | None = None,
        average_relevance: float = 0.0,
    ) -> str:
        """Emit source curation progress/results."""
        from src.main.dto.streaming import SourceCurationPacket

        return self.emit(
            SourceCurationPacket(
                status=status,
                total_sources=total_sources,
                curated_count=curated_count,
                dropped_count=dropped_count,
                dropped_reasons=dropped_reasons or [],
                average_relevance=average_relevance,
            )
        )

    def emit_research_cost(
        self,
        phase: str,
        input_tokens: int,
        output_tokens: int,
        estimated_cost_usd: float,
        model: str,
        cumulative_cost_usd: float,
    ) -> str:
        """Emit per-phase cost tracking data."""
        from src.main.dto.streaming import ResearchCostPacket

        return self.emit(
            ResearchCostPacket(
                phase=phase,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                estimated_cost_usd=estimated_cost_usd,
                model=model,
                cumulative_cost_usd=cumulative_cost_usd,
            )
        )

    # ============================================================================
    # ADAPTIVE MULTI-STEP RESEARCH PACKETS
    # ============================================================================

    def emit_research_step_start(self, step: int, max_steps: int, complexity: str, focus: str) -> str:
        """Emit the start of an adaptive research step."""
        from src.main.dto.streaming import ResearchStepStartPacket

        return self.emit(
            ResearchStepStartPacket(
                step=step,
                max_steps=max_steps,
                complexity=complexity,
                focus=focus,
            )
        )

    def emit_research_step_complete(self, step: int, learnings_count: int, gaps_found: int, coverage_score: float, continuing: bool) -> str:
        """Emit completion of an adaptive research step."""
        from src.main.dto.streaming import ResearchStepCompletePacket

        return self.emit(
            ResearchStepCompletePacket(
                step=step,
                learnings_count=learnings_count,
                gaps_found=gaps_found,
                coverage_score=coverage_score,
                continuing=continuing,
            )
        )

    def emit_research_gap_analysis(self, step: int, gaps: list[str], follow_up_queries: list[str], coverage_score: float) -> str:
        """Emit gap analysis results between adaptive research steps."""
        from src.main.dto.streaming import ResearchGapAnalysisPacket

        return self.emit(
            ResearchGapAnalysisPacket(
                step=step,
                gaps=gaps,
                follow_up_queries=follow_up_queries,
                coverage_score=coverage_score,
            )
        )

    def reset(self):
        """Reset the emitter state"""
        self.packet_index = 0
