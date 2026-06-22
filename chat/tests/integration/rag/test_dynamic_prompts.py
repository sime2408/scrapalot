"""
Integration tests for Phase 4 category-conditioned prompt variants.

Covers the variant resolver, the prompts.yaml lookup, and the operator kill
switch. The full LLM-judge regression test (PRD acceptance #5) is Phase-5
territory and not implemented here.

Run inside scrapalot-chat container:

    docker exec scrapalot-chat python -m pytest \\
        tests/integration/rag/test_dynamic_prompts.py -v
"""

from __future__ import annotations

import pytest

from src.main.service.rag.prompt_variants import (
    KNOWN_VARIANTS,
    get_variant_prefix,
    resolve_prompt_variant,
    variant_prefix_for,
)

# =============================================================================
# resolve_prompt_variant routing
# =============================================================================


@pytest.mark.integration
def test_temporal_query_picks_temporal_variant():
    """has_temporal_constraint or non-empty temporal_indicators → temporal_reasoning."""
    assert resolve_prompt_variant({"has_temporal_constraint": True}) == "temporal_reasoning"
    assert resolve_prompt_variant({"temporal_indicators": ["last quarter"]}) == "temporal_reasoning"


@pytest.mark.integration
def test_knowledge_update_takes_priority_over_summary():
    """When both update + summary flags fire, knowledge_update wins (more specific)."""
    qc = {"is_knowledge_update_question": True, "is_summary_question": True}
    assert resolve_prompt_variant(qc) == "knowledge_update"


@pytest.mark.integration
def test_multi_session_query_picks_multi_session():
    assert resolve_prompt_variant({"requires_multi_session_synthesis": True}) == "multi_session"


@pytest.mark.integration
def test_preference_query_picks_preference_recall():
    assert resolve_prompt_variant({"is_preference_question": True}) == "preference_recall"


@pytest.mark.integration
def test_summary_query_picks_summary():
    assert resolve_prompt_variant({"is_summary_question": True}) == "summary"


@pytest.mark.integration
def test_default_when_no_signal():
    """Empty / null characteristics fall through to 'default'."""
    assert resolve_prompt_variant(None) == "default"
    assert resolve_prompt_variant({}) == "default"
    # Generic factual query — every category flag is false.
    qc = {
        "has_temporal_constraint": False,
        "is_summary_question": False,
        "is_knowledge_update_question": False,
        "requires_multi_session_synthesis": False,
        "is_preference_question": False,
    }
    assert resolve_prompt_variant(qc) == "default"


@pytest.mark.integration
def test_resolver_returns_only_known_variants():
    """Whatever the input, the result must be a member of KNOWN_VARIANTS."""
    for qc in [
        None,
        {},
        {"has_temporal_constraint": True},
        {"is_summary_question": True},
        {"is_knowledge_update_question": True},
        {"requires_multi_session_synthesis": True},
        {"is_preference_question": True},
        # All-on case — first match wins.
        {
            "has_temporal_constraint": True,
            "is_summary_question": True,
            "is_knowledge_update_question": True,
            "requires_multi_session_synthesis": True,
            "is_preference_question": True,
        },
    ]:
        variant = resolve_prompt_variant(qc)
        assert variant in KNOWN_VARIANTS, f"unknown variant {variant!r} for qc={qc}"


# =============================================================================
# get_variant_prefix
# =============================================================================


@pytest.mark.integration
def test_default_variant_has_empty_prefix():
    """The default variant intentionally returns an empty prefix so the
    synthesis path falls through to the standard system template."""
    assert get_variant_prefix("default") == ""


@pytest.mark.integration
def test_known_variants_have_nonempty_prefix():
    """Every non-default variant must have text in prompts.yaml."""
    for variant in KNOWN_VARIANTS:
        if variant == "default":
            continue
        prefix = get_variant_prefix(variant)
        assert prefix, f"variant {variant!r} has no yaml entry"
        assert len(prefix) > 50, f"variant {variant!r} prefix is implausibly short"


@pytest.mark.integration
def test_unknown_variant_falls_back_quietly():
    """An invalid variant name returns empty (logged as warning, no crash)."""
    assert get_variant_prefix("nonexistent_variant_xyz") == ""


@pytest.mark.integration
def test_variant_prefix_for_round_trip():
    """`variant_prefix_for` returns (variant_name, prefix_text) consistently."""
    name, prefix = variant_prefix_for({"is_summary_question": True})
    assert name == "summary"
    assert "bullet" in prefix.lower()


# =============================================================================
# Operator kill switch
# =============================================================================


@pytest.mark.integration
def test_dynamic_variants_disabled_returns_default(monkeypatch):
    """When `rag.prompts.dynamic_variants_enabled=false`, the resolver
    short-circuits to 'default' regardless of the QueryCharacteristics."""
    import src.main.utils.config.loader as cl

    rag_cfg = cl.resolved_config.setdefault("rag", {}).setdefault("prompts", {})
    original = rag_cfg.get("dynamic_variants_enabled", True)
    rag_cfg["dynamic_variants_enabled"] = False
    try:
        assert resolve_prompt_variant({"has_temporal_constraint": True}) == "default"
        assert variant_prefix_for({"is_summary_question": True}) == ("default", "")
    finally:
        rag_cfg["dynamic_variants_enabled"] = original


# =============================================================================
# QueryCharacteristics object compatibility
# =============================================================================


@pytest.mark.integration
def test_resolver_accepts_pydantic_query_characteristics():
    """The resolver works with the real Pydantic model, not just dicts."""
    from src.main.service.agents.rag_agents.strategy_router import QueryCharacteristics

    qc = QueryCharacteristics(
        query_type="factual",
        complexity_score=2,
        intent="information_lookup",
        domain_indicators=[],
        requires_multi_hop=False,
        requires_relationships=False,
        key_entities=[],
        is_summary_question=True,
    )
    assert resolve_prompt_variant(qc) == "summary"


@pytest.mark.integration
def test_new_qc_fields_registered_on_model():
    """The Phase 4 fields are present on the Pydantic class so the LLM
    populates them through structured-output extraction."""
    from src.main.service.agents.rag_agents.strategy_router import QueryCharacteristics

    fields = QueryCharacteristics.model_fields
    assert "is_preference_question" in fields
    assert "requires_multi_session_synthesis" in fields
    assert "is_knowledge_update_question" in fields
