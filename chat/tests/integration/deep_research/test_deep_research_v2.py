"""
Integration tests for Deep Research v2 features (P1-P5, P7).

Tests use REAL LLM calls (no mocks), REAL database, REAL API.
Run inside Docker: docker exec scrapalot-chat python -m pytest tests/integration/deep_research/ -v

These tests verify:
- P1: Writing Tone enum and prompt injection
- P2: Section deduplication in synthesis prompt
- P3: Source curation agent (LLM-based filtering)
- P5: Auto agent persona selection
- P7: Cost tracking per phase
"""

import asyncio

import pytest

from src.main.service.deep_research.models.research_models import ResearchResult, ResearchTone

# ============================================================================
# P1: Writing Tone
# ============================================================================


class TestWritingTone:
    """Test the ResearchTone enum and its integration with synthesis."""

    def test_all_tones_have_descriptions(self):
        """Every tone value should have a non-empty description."""
        for tone in ResearchTone:
            assert tone.description, f"Tone {tone.value} has no description"
            assert len(tone.description) > 10, f"Tone {tone.value} description too short"

    def test_tone_from_string(self):
        """Tone enum should be constructible from lowercase string."""
        assert ResearchTone("objective") == ResearchTone.OBJECTIVE
        assert ResearchTone("analytical") == ResearchTone.ANALYTICAL
        assert ResearchTone("simple") == ResearchTone.SIMPLE

    def test_invalid_tone_raises(self):
        """Invalid tone string should raise ValueError."""
        with pytest.raises(ValueError):
            ResearchTone("nonexistent_tone")

    def test_tone_injected_into_synthesis_prompt(self):
        """Tone and persona should appear in the synthesis prompt."""
        from src.main.service.deep_research.agents.synthesis_agent import SynthesisRequest

        request = SynthesisRequest(
            research_results=[
                ResearchResult(title="Test", content="Test content about AI", source_url="https://example.com"),
            ],
            query="What is AI?",
            writing_tone="analytical",
            writing_tone_description="critical evaluation and detailed examination",
            persona_context="You are an AI research expert.",
        )

        from src.main.service.deep_research.agents.synthesis_agent import ResearchSynthesisAgent

        # Instantiate with a dummy model — we only test prompt generation, not LLM call
        class FakeModel:
            model_name = "test"

        # noinspection PyTypeChecker
        agent = ResearchSynthesisAgent.__new__(ResearchSynthesisAgent)
        agent.model = FakeModel()
        agent.packet_emitter = None
        agent._model = "openai:gpt-4o-mini"

        prompt = agent._prepare_synthesis_input(request)

        assert "analytical" in prompt.lower()
        assert "critical evaluation" in prompt
        assert "AI research expert" in prompt
        assert "SECTION DEDUPLICATION" in prompt


# ============================================================================
# P2: Section Deduplication
# ============================================================================


class TestSectionDeduplication:
    """Test that synthesis prompt includes deduplication context."""

    def test_existing_sections_listed_in_prompt(self):
        """The synthesis prompt should list existing section topics for deduplication."""
        from src.main.service.deep_research.agents.synthesis_agent import ResearchSynthesisAgent, SynthesisRequest

        results = [
            ResearchResult(title="Benefits of Meditation", content="Content A"),
            ResearchResult(title="Risks of Meditation", content="Content B"),
            ResearchResult(title="Meditation Techniques", content="Content C"),
        ]

        request = SynthesisRequest(
            research_results=results,
            query="Meditation research",
        )

        # noinspection PyTypeChecker
        agent = ResearchSynthesisAgent.__new__(ResearchSynthesisAgent)
        agent.model = type("M", (), {"model_name": "test"})()
        agent.packet_emitter = None
        agent._model = "openai:gpt-4o-mini"

        prompt = agent._prepare_synthesis_input(request)

        assert "Benefits of Meditation" in prompt
        assert "Risks of Meditation" in prompt
        assert "Meditation Techniques" in prompt
        assert "SECTION DEDUPLICATION" in prompt
        assert "must be unique" in prompt.lower() or "MUST NOT repeat" in prompt


# ============================================================================
# P3: Source Curation Agent (real LLM call)
# ============================================================================


@pytest.mark.integration
class TestSourceCuration:
    """Test source curation with real LLM calls."""

    def test_curation_filters_irrelevant_sources(self):
        """Curation should drop clearly irrelevant sources while keeping relevant ones."""
        from src.main.service.deep_research.agents.source_curation_agent import SourceCurationAgent
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        config = get_system_agent_model(agent_type="research_planner")
        agent = SourceCurationAgent(
            model=None,
            api_key=config.api_key,
            provider_type=config.provider_type,
        )

        results = [
            ResearchResult(
                title="Cardiovascular Benefits of Meditation",
                content="Studies show meditation reduces blood pressure by 5-10 mmHg.",
                source_url="https://pubmed.ncbi.nlm.nih.gov/123",
            ),
            ResearchResult(title="Best Pizza Recipes 2026", content="Top 10 pizza recipes for home cooking.", source_url="https://recipes.com/pizza"),
            ResearchResult(
                title="Mindfulness and Stress Reduction",
                content="A meta-analysis of 47 trials found mindfulness reduces anxiety scores.",
                source_url="https://scholar.google.com/456",
            ),
            ResearchResult(
                title="Buy Cheap Supplements Now!", content="SALE! 50% off on all supplements.", source_url="https://spam-supplements.com"
            ),
            ResearchResult(
                title="Neural Correlates of Meditation",
                content="fMRI studies reveal changes in default mode network during meditation.",
                source_url="https://nature.com/789",
            ),
        ]

        curated = asyncio.get_event_loop().run_until_complete(agent.curate_sources("Effects of meditation on health", results, max_results=10))

        # Should keep the 3 relevant sources and drop pizza + spam
        curated_titles = [r.title for r in curated]
        assert "Cardiovascular Benefits of Meditation" in curated_titles
        assert "Neural Correlates of Meditation" in curated_titles
        assert len(curated) >= 3
        assert len(curated) <= 4  # Might keep mindfulness too

    def test_curation_returns_all_when_few_sources(self):
        """With 3 or fewer sources, curation should skip and return all."""
        from src.main.service.deep_research.agents.source_curation_agent import SourceCurationAgent
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        config = get_system_agent_model(agent_type="research_planner")
        agent = SourceCurationAgent(
            model=None,
            api_key=config.api_key,
            provider_type=config.provider_type,
        )
        results = [
            ResearchResult(title="A", content="Content A"),
            ResearchResult(title="B", content="Content B"),
        ]

        curated = asyncio.get_event_loop().run_until_complete(agent.curate_sources("test query", results))

        assert len(curated) == 2


# ============================================================================
# P5: Auto Agent Persona Selection (real LLM call)
# ============================================================================


@pytest.mark.integration
class TestPersonaSelection:
    """Test persona selection with real LLM calls."""

    def test_medical_query_gets_medical_persona(self):
        """A medical query should produce a medical-related persona."""
        from src.main.service.deep_research.agents.persona_agent import PersonaSelectionAgent
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        config = get_system_agent_model(agent_type="research_planner")
        agent = PersonaSelectionAgent(
            model=None,
            api_key=config.api_key,
            provider_type=config.provider_type,
        )

        persona = asyncio.get_event_loop().run_until_complete(agent.select_persona("Effects of meditation on cardiovascular health"))

        assert persona.persona_name, "Persona name should not be empty"
        assert persona.persona_emoji, "Persona emoji should not be empty"
        assert persona.domain, "Domain should not be empty"
        assert persona.role_prompt, "Role prompt should not be empty"
        # Domain should be health/medical related
        assert any(word in persona.domain.lower() for word in ["medic", "health", "science", "bio"]), (
            f"Expected medical domain, got: {persona.domain}"
        )

    def test_finance_query_gets_finance_persona(self):
        """A finance query should produce a finance-related persona."""
        from src.main.service.deep_research.agents.persona_agent import PersonaSelectionAgent
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        config = get_system_agent_model(agent_type="research_planner")
        agent = PersonaSelectionAgent(
            model=None,
            api_key=config.api_key,
            provider_type=config.provider_type,
        )

        persona = asyncio.get_event_loop().run_until_complete(agent.select_persona("Should I invest in NVIDIA stock for long-term growth?"))

        assert any(word in persona.domain.lower() for word in ["financ", "invest", "business", "econom"]), (
            f"Expected finance domain, got: {persona.domain}"
        )


# ============================================================================
# P7: Cost Tracking
# ============================================================================


class TestCostTracking:
    """Test cost estimation and tracking."""

    def test_cost_estimation_gpt4o_mini(self):
        """Cost estimation for the gpt-4o-mini model should use correct pricing."""
        from src.main.service.deep_research.cost_tracker import estimate_cost

        # 1M input tokens @ $0.15, 1M output tokens @ $0.60
        cost = estimate_cost(1_000_000, 1_000_000, "gpt-4o-mini")
        assert abs(cost - 0.75) < 0.001

    def test_cost_estimation_gpt4o(self):
        """Cost estimation for the gpt-4o model should use correct pricing."""
        from src.main.service.deep_research.cost_tracker import estimate_cost

        # 1M input @ $2.50, 1M output @ $10.00
        cost = estimate_cost(1_000_000, 1_000_000, "gpt-4o")
        assert abs(cost - 12.50) < 0.01

    def test_cost_tracker_accumulates(self):
        """Cost tracker should accumulate costs across phases."""
        from src.main.service.deep_research.cost_tracker import ResearchCostTracker

        tracker = ResearchCostTracker(model="gpt-4o-mini")

        tracker.record_phase("planning", 5000, 2000, "gpt-4o-mini")
        tracker.record_phase("search", 10000, 3000, "gpt-4o-mini")
        tracker.record_phase("synthesis", 8000, 5000, "gpt-4o")

        assert tracker.total_input_tokens == 23000
        assert tracker.total_output_tokens == 10000
        assert tracker.total_cost > 0
        assert len(tracker.phases) == 3
        assert "planning" in tracker.phases
        assert "search" in tracker.phases
        assert "synthesis" in tracker.phases

    def test_cost_tracker_emits_packets(self):
        """Cost tracker should emit packets through the emitter."""
        from src.main.service.deep_research.cost_tracker import ResearchCostTracker
        from src.main.service.streaming.packet_emitter import PacketEmitter

        emitter = PacketEmitter()
        packets = []

        # Monkey-patch emit to capture packets
        original_emit = emitter.emit

        def capture_emit(packet):
            result = original_emit(packet)
            packets.append(result)
            return result

        emitter.emit = capture_emit

        tracker = ResearchCostTracker(packet_emitter=emitter, model="gpt-4o-mini")
        tracker.record_phase("planning", 5000, 2000)
        tracker.emit_total()

        assert len(packets) >= 2  # At least phase + total
        assert '"research_cost"' in packets[0]
        assert '"planning"' in packets[0]


# ============================================================================
# Streaming Packet Serialization
# ============================================================================


class TestStreamingPackets:
    """Test new streaming packet types serialize correctly."""

    def test_agent_persona_packet(self):
        """AgentPersonaPacket should serialize to valid JSON."""
        from src.main.dto.streaming import AgentPersonaPacket

        packet = AgentPersonaPacket(
            persona_name="Medical Research Analyst",
            persona_emoji="🏥",
            persona_prompt="You are a medical research expert.",
            domain="medicine",
        )
        json_str = packet.model_dump_json()
        assert '"agent_persona"' in json_str
        assert '"Medical Research Analyst"' in json_str

    def test_source_curation_packet(self):
        """SourceCurationPacket should serialize correctly."""
        from src.main.dto.streaming import SourceCurationPacket

        packet = SourceCurationPacket(
            status="completed",
            total_sources=20,
            curated_count=15,
            dropped_count=5,
            dropped_reasons=["Irrelevant content"],
            average_relevance=0.82,
        )
        json_str = packet.model_dump_json()
        assert '"source_curation"' in json_str
        assert '"completed"' in json_str

    def test_research_cost_packet(self):
        """ResearchCostPacket should serialize correctly."""
        from src.main.dto.streaming import ResearchCostPacket

        packet = ResearchCostPacket(
            phase="synthesis",
            input_tokens=8000,
            output_tokens=5000,
            estimated_cost_usd=0.023,
            model="gpt-4o",
            cumulative_cost_usd=0.045,
        )
        json_str = packet.model_dump_json()
        assert '"research_cost"' in json_str
        assert '"synthesis"' in json_str

    def test_all_new_packets_in_union(self):
        """All new packet types should be in the StreamPacket union."""
        import typing

        from src.main.dto.streaming import AgentPersonaPacket, ResearchCostPacket, SourceCurationPacket, StreamPacket

        union_args = typing.get_args(StreamPacket)
        assert AgentPersonaPacket in union_args
        assert SourceCurationPacket in union_args
        assert ResearchCostPacket in union_args


# ============================================================================
# P4: Report Export PDF/DOCX
# ============================================================================


class TestReportExport:
    """Test report export to DOCX, HTML, and MD formats."""

    SAMPLE_MD = """# Research Report: AI in Healthcare

## Executive Summary

Artificial intelligence is transforming healthcare delivery.

## Key Findings

- Finding 1: AI improves diagnostic accuracy by 15%
- Finding 2: Cost savings of $150B annually

## Data Analysis

| Metric | Before AI | After AI |
|--------|----------|---------|
| Accuracy | 78% | 93% |
| Cost | $500 | $350 |

## Conclusions

AI in healthcare shows significant promise.
"""

    def test_export_docx(self):
        """DOCX export should produce valid binary output."""
        from src.main.service.deep_research.report_export_service import export_report

        data, content_type, filename = export_report(self.SAMPLE_MD, "docx", "AI Healthcare Report")

        assert len(data) > 1000, "DOCX too small"
        assert content_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        assert filename.endswith(".docx")
        # DOCX files start with PK (ZIP format)
        assert data[:2] == b"PK"

    def test_export_html(self):
        """HTML export should produce styled HTML with CSS."""
        from src.main.service.deep_research.report_export_service import export_report

        data, _content_type, filename = export_report(self.SAMPLE_MD, "html", "AI Healthcare Report")

        html = data.decode("utf-8")
        assert "<html" in html
        assert "<style>" in html
        assert "Research Report" in html
        assert filename.endswith(".html")

    def test_export_md(self):
        """MD export should return raw markdown."""
        from src.main.service.deep_research.report_export_service import export_report

        data, _content_type, filename = export_report(self.SAMPLE_MD, "md", "AI Healthcare Report")

        assert data == self.SAMPLE_MD.encode("utf-8")
        assert filename.endswith(".md")

    def test_export_invalid_format(self):
        """Invalid format should raise ValueError."""
        from src.main.service.deep_research.report_export_service import export_report

        with pytest.raises(ValueError, match="Unsupported"):
            # noinspection PyTypeChecker
            export_report("# Test", "pdf", "Test")


# ============================================================================
# P6: Multiple Report Types
# ============================================================================


class TestReportTypes:
    """Test report type enum and prompt injection."""

    def test_all_report_types_have_instructions(self):
        """Every report type should have a non-empty prompt instruction."""
        from src.main.service.deep_research.models.research_models import ReportType

        for rt in ReportType:
            assert rt.prompt_instruction, f"Report type {rt.value} has no instruction"
            assert len(rt.prompt_instruction) > 20

    def test_report_type_from_string(self):
        """Report type enum should be constructible from lowercase string."""
        from src.main.service.deep_research.models.research_models import ReportType

        assert ReportType("standard") == ReportType.STANDARD
        assert ReportType("outline") == ReportType.OUTLINE
        assert ReportType("executive_summary") == ReportType.EXECUTIVE_SUMMARY
        assert ReportType("bibliography") == ReportType.BIBLIOGRAPHY
        assert ReportType("detailed") == ReportType.DETAILED

    def test_report_type_in_synthesis_prompt(self):
        """Report type instruction should appear in synthesis prompt."""
        from src.main.service.deep_research.agents.synthesis_agent import ResearchSynthesisAgent, SynthesisRequest
        from src.main.service.deep_research.models.research_models import ReportType

        request = SynthesisRequest(
            research_results=[ResearchResult(title="Test", content="Content")],
            query="Test query",
            report_type="outline",
            report_type_instruction=ReportType.OUTLINE.prompt_instruction,
        )

        # noinspection PyTypeChecker
        agent = ResearchSynthesisAgent.__new__(ResearchSynthesisAgent)
        agent.model = type("M", (), {"model_name": "test"})()
        agent.packet_emitter = None
        agent._model = "openai:gpt-4o-mini"

        prompt = agent._prepare_synthesis_input(request)
        assert "outline" in prompt.lower()
        assert "OUTLINE ONLY" in prompt


# ============================================================================
# P9: Academic Retrievers (real API calls — free, no key needed)
# ============================================================================


@pytest.mark.integration
@pytest.mark.slow
class TestAcademicRetrievers:
    """Test academic search providers with real API calls.
    Marked slow because free APIs rate-limit aggressively (ArXiv/S2: 429 after ~3 calls/min)."""

    def test_arxiv_search(self):
        """ArXiv should return papers for a scientific query."""
        from src.main.service.deep_research.research_providers.arxiv_provider import ArxivProvider

        provider = ArxivProvider()
        results = asyncio.get_event_loop().run_until_complete(provider.search("transformer attention mechanism", max_results=5))

        assert len(results) > 0, "ArXiv should return results"
        assert results[0].title, "First result should have a title"
        assert results[0].url, "First result should have a URL"
        assert results[0].content, "First result should have content (abstract)"
        assert results[0].credibility_score >= 0.8

    def test_semantic_scholar_search(self):
        """Semantic Scholar should return papers with citation data (may return empty on 429)."""
        from src.main.service.deep_research.research_providers.semantic_scholar_provider import SemanticScholarProvider

        provider = SemanticScholarProvider()
        results = asyncio.get_event_loop().run_until_complete(provider.search("deep learning image classification", max_results=5))

        # Semantic Scholar aggressively rate-limits (429) without API key
        # Empty result is acceptable — provider handles error gracefully
        assert isinstance(results, list), "Should return a list"
        if results:
            assert results[0].title, "First result should have a title"
            assert results[0].content, "First result should have content"

    def test_pubmed_search(self):
        """PubMed should return biomedical papers."""
        from src.main.service.deep_research.research_providers.pubmed_provider import PubMedProvider

        provider = PubMedProvider()
        results = asyncio.get_event_loop().run_until_complete(provider.search("meditation cardiovascular health", max_results=5))

        assert len(results) > 0, "PubMed should return results"
        assert results[0].title, "First result should have a title"
        assert "pubmed" in results[0].url.lower()
        assert results[0].credibility_score >= 0.8

    def test_pubmed_provider_returns_sources_with_correct_fields(self):
        """PubMed sources should have proper field types."""
        from src.main.service.deep_research.research_providers.pubmed_provider import PubMedProvider

        provider = PubMedProvider()
        results = asyncio.get_event_loop().run_until_complete(provider.search("CRISPR gene therapy", max_results=3))

        if results:  # May be empty due to rate limits
            src = results[0]
            assert isinstance(src.title, str)
            assert isinstance(src.url, str)
            assert isinstance(src.credibility_score, float)
            assert src.credibility_score >= 0.8

    def test_provider_factory_creates_academic_providers(self):
        """Provider factory should create academic providers by name."""
        from src.main.service.deep_research.research_providers.provider_factory import ResearchProviderFactory

        arxiv = ResearchProviderFactory.create_provider("arxiv")
        assert arxiv.provider_name == "arxiv"

        scholar = ResearchProviderFactory.create_provider("semantic_scholar")
        assert scholar.provider_name == "semantic_scholar"

        pubmed = ResearchProviderFactory.create_provider("pubmed")
        assert pubmed.provider_name == "pubmed"


# ============================================================================
# P10: Three-Tier LLM System
# ============================================================================


def _assert_valid_agent_config(config, agent_type: str) -> None:
    """Every tier agent must resolve to a usable model config — a non-empty
    provider + model, and (for key-based providers) an API key. Provider-
    agnostic: the system AI provider is admin-configurable, so we assert the
    resolution contract, not a hardcoded vendor model name."""
    assert config is not None, f"{agent_type}: no config resolved"
    assert config.provider_type, f"{agent_type}: empty provider_type"
    assert config.model_name, f"{agent_type}: empty model_name"
    if config.provider_type.lower() not in ("ollama", "vllm", "lmstudio"):
        assert config.api_key, f"{agent_type}: no api_key for provider '{config.provider_type}'"


class TestThreeTierLLM:
    """Three-tier LLM routing.

    Asserts the routing CONTRACT (every agent type resolves to a valid model,
    and explicit overrides win) rather than hardcoded OpenAI model names — the
    old name-based assertions broke when the system AI provider was migrated to
    DeepSeek (the model is admin-configurable; see memory/project_deepseek_migration).
    """

    def test_fast_tier_agents_resolve_valid_config(self):
        """Every FAST-tier agent type resolves to a usable model config."""
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        fast_agents = ["strategy_router", "query_analyzer", "task_decomposer", "source_curation", "persona_selection"]
        for agent_type in fast_agents:
            _assert_valid_agent_config(get_system_agent_model(agent_type=agent_type), agent_type)

    def test_smart_tier_agents_resolve_valid_config(self):
        """Every SMART-tier agent type resolves to a usable model config."""
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        for agent_type in ("synthesis", "research_coordinator"):
            _assert_valid_agent_config(get_system_agent_model(agent_type=agent_type), agent_type)

    def test_strategic_tier_planner_resolves_valid_config(self):
        """The STRATEGIC-tier planner resolves to a usable model config."""
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        _assert_valid_agent_config(get_system_agent_model(agent_type="research_planner"), "research_planner")

    def test_env_override_is_honored(self):
        """The resolution MECHANISM: an explicit env-var override (the highest-
        priority source in get_system_agent_model) must win. Deterministic +
        provider-agnostic — proves model resolution honors overrides regardless
        of the deployed system provider. Uses agent_type=None so no per-agent
        config.yaml override layers on top of the env base model."""
        import os

        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        prev_provider = os.environ.get("AGENT_PROVIDER_TYPE")
        prev_model = os.environ.get("AGENT_MODEL_NAME")
        try:
            os.environ["AGENT_PROVIDER_TYPE"] = "openai"
            os.environ["AGENT_MODEL_NAME"] = "gpt-4o-mini"
            config = get_system_agent_model()  # no agent_type → no override layered on top
            assert config.provider_type == "openai", f"env override ignored, got provider {config.provider_type}"
            assert config.model_name == "gpt-4o-mini", f"env override ignored, got model {config.model_name}"
        finally:
            # Restore env so the override never leaks into sibling tests.
            for key, prev in (("AGENT_PROVIDER_TYPE", prev_provider), ("AGENT_MODEL_NAME", prev_model)):
                if prev is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = prev

    def test_cost_estimation_o4_mini(self):
        """o4-mini should have proper pricing in cost tracker."""
        from src.main.service.deep_research.cost_tracker import estimate_cost

        cost = estimate_cost(1_000_000, 1_000_000, "o4-mini")
        assert abs(cost - 5.50) < 0.01  # $1.10/M input + $4.40/M output


# ============================================================================
# P12: Review/Revise Loop
# ============================================================================


class TestReviewRevisePackets:
    """Test review/revise streaming packets."""

    def test_review_feedback_packet(self):
        """ReviewFeedbackPacket should serialize correctly."""
        from src.main.dto.streaming import ReviewFeedbackPacket

        packet = ReviewFeedbackPacket(
            round=1,
            accepted=False,
            feedback="Needs more citations",
            quality_score=0.55,
            issues_found=3,
        )
        json_str = packet.model_dump_json()
        assert '"review_feedback"' in json_str
        assert '"Needs more citations"' in json_str

    def test_revision_packet(self):
        """RevisionPacket should serialize correctly."""
        from src.main.dto.streaming import RevisionPacket

        packet = RevisionPacket(
            round=1,
            sections_revised=2,
            revision_summary="Added citations to findings section",
        )
        json_str = packet.model_dump_json()
        assert '"revision"' in json_str

    def test_review_revise_packets_in_union(self):
        """Review/revise packets should be in StreamPacket union."""
        import typing

        from src.main.dto.streaming import ReviewFeedbackPacket, RevisionPacket, StreamPacket

        union_args = typing.get_args(StreamPacket)
        assert ReviewFeedbackPacket in union_args
        assert RevisionPacket in union_args


@pytest.mark.integration
class TestReviewReviseLoop:
    """Test review/revise loop with real LLM calls."""

    def test_reviewer_accepts_good_draft(self):
        """Reviewer should accept a well-written draft."""
        from src.main.service.deep_research.agents.review_agent import ReviewerAgent
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        config = get_system_agent_model(agent_type="research_planner")
        reviewer = ReviewerAgent(model=None, api_key=config.api_key, provider_type=config.provider_type)

        good_draft = """## Executive Summary

Meditation has been shown to reduce cardiovascular risk factors including blood pressure,
heart rate variability, and cortisol levels ([Mayo Clinic](https://mayoclinic.org/meditation)).

## Key Findings

### Blood Pressure Reduction
Multiple meta-analyses confirm that mindfulness meditation reduces systolic blood pressure
by 4-8 mmHg ([AHA Journal](https://aha.org/study-123)).

### Stress Biomarkers
Cortisol levels decrease by 15-25% after 8 weeks of regular meditation practice
([NIH Study](https://pubmed.ncbi.nlm.nih.gov/456)).

## Conclusions and Recommendations

1. Daily meditation of 15-20 minutes is recommended for cardiovascular health
2. Mindfulness-based stress reduction (MBSR) has the strongest evidence base
3. Further research needed on long-term cardiovascular outcomes"""

        review = asyncio.get_event_loop().run_until_complete(reviewer.review(good_draft, "Effects of meditation on cardiovascular health"))

        assert review.quality_score >= 0.5, f"Good draft should score >= 0.5, got {review.quality_score}"
        assert isinstance(review.accepted, bool)
        assert isinstance(review.issues, list)

    def test_full_review_revise_loop(self):
        """Full loop should improve or accept a draft within 2 rounds."""
        from src.main.service.deep_research.agents.review_agent import ReviewerAgent, ReviserAgent, review_and_revise_loop
        from src.main.utils.llm.agent_model_utils import get_system_agent_model

        config = get_system_agent_model(agent_type="research_planner")
        reviewer = ReviewerAgent(model=None, api_key=config.api_key, provider_type=config.provider_type)
        reviser = ReviserAgent(model=None, api_key=config.api_key, provider_type=config.provider_type)

        draft = """## Summary
AI is changing healthcare. Some studies show improvements.

## Findings
Various findings about AI in healthcare exist."""

        final_content, score = asyncio.get_event_loop().run_until_complete(
            review_and_revise_loop(draft, "AI applications in healthcare", reviewer, reviser)
        )

        assert final_content, "Should return content"
        assert len(final_content) > 0
        assert 0.0 <= score <= 1.0
