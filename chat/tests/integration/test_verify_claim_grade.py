"""
Integration tests for Feature 2: GRADE evidence grading + bias + logical
fallacy detection on the Notes "Verify Claim" action.

Exercises the full Kotlin REST stack (UI → Gateway → Kotlin backend →
gRPC → Python AI → structured-output LLM call) against several claims
with known rigor characteristics. Runs inside the scrapalot-chat
container via the standard `authenticated_session` + `api_base_url`
fixtures.

Marked `slow` because each test is a real LLM round-trip through the
structured-output path (~9s observed).
"""

import pytest


@pytest.mark.integration
@pytest.mark.slow
class TestVerifyClaimGrade:
    """POST /notes/assistant/verify end-to-end with GRADE + critical thinking."""

    @staticmethod
    def _post_verify(authenticated_session, api_base_url: str, claim: str, locale: str = "en"):
        return authenticated_session.post(
            f"{api_base_url}/notes/assistant/verify",
            json={
                "claim_text": claim,
                "collection_ids": [],
                "include_web": True,
                "locale": locale,
            },
            timeout=60,
        )

    def test_response_shape_has_all_feature2_fields(self, authenticated_session, api_base_url):
        """Every successful verify-claim call must populate the Feature 2 payload.

        This is the contract test — if Kotlin drops any of the new
        fields the frontend type becomes a lie and the panel degrades
        silently, so we assert presence explicitly.
        """
        response = self._post_verify(
            authenticated_session,
            api_base_url,
            "Regular exercise reduces the risk of cardiovascular disease",
        )
        assert response.status_code == 200, f"Unexpected status: {response.status_code} {response.text[:300]}"
        data = response.json()

        # Original fields still present
        assert "verdict" in data
        assert "confidence" in data
        assert "supporting_evidence" in data
        assert "contradicting_evidence" in data
        assert "suggestion" in data

        # Feature 2 fields present
        assert "evidence_quality" in data, f"Missing evidence_quality in response: {sorted(data.keys())}"
        assert "bias_flags" in data
        assert "fallacy_warnings" in data

        # Type assertions
        assert isinstance(data["bias_flags"], list)
        assert isinstance(data["fallacy_warnings"], list)

    def test_evidence_quality_always_populated(self, authenticated_session, api_base_url):
        """evidence_quality is never null — Python service falls back to
        very_low on LLM failure so the frontend can always render the block."""
        response = self._post_verify(
            authenticated_session,
            api_base_url,
            "Meditation reduces cortisol levels",
        )
        assert response.status_code == 200
        eq = response.json()["evidence_quality"]
        assert eq is not None, "evidence_quality must never be null in the response"

        assert "grade" in eq
        assert eq["grade"] in ("high", "moderate", "low", "very_low"), f"Unexpected grade value: {eq['grade']}"
        assert "rationale" in eq
        assert "downgrades" in eq and isinstance(eq["downgrades"], list)
        assert "upgrades" in eq and isinstance(eq["upgrades"], list)

    def test_anecdotal_claim_gets_low_grade_and_fallacies(self, authenticated_session, api_base_url):
        """Anecdote-tier pseudoscience should GRADE low/very_low and flag
        at least one causation fallacy (post hoc). Regression guard
        against the LLM silently dropping its critical-thinking hat.
        """
        response = self._post_verify(
            authenticated_session,
            api_base_url,
            "Drinking lemon water every morning cures cancer because my aunt stopped her tumor growth after starting it",
        )
        assert response.status_code == 200
        data = response.json()

        # Should contradict or at most be unverified — definitely not "supported"
        assert data["verdict"] in ("contradicted", "partially_supported", "unverified"), f"Pseudoscience claim got verdict={data['verdict']}"

        # GRADE must be low or very_low for anecdote-backed claims
        grade = data["evidence_quality"]["grade"]
        assert grade in ("low", "very_low"), f"Anecdotal cancer-cure claim graded as {grade}; expected low/very_low"

        # At least one causation fallacy (post hoc ergo propter hoc)
        # should appear — the "started lemon water → tumor stopped" wording
        # is the textbook example.
        causation_fallacies = [f for f in (data.get("fallacy_warnings") or []) if f["category"] == "causation"]
        assert causation_fallacies, f"Post hoc claim did not trigger any causation fallacy. Got fallacies: {data.get('fallacy_warnings')}"

    def test_fallacy_description_is_not_empty(self, authenticated_session, api_base_url):
        """Fallacy descriptions must be non-empty sentences, not bare
        placeholder strings. We do not try to enforce "claim-specific"
        wording programmatically because LLM paraphrases frequently
        replace domain terms with semantically-equivalent phrases
        (e.g. "timing of events" for "shortly after"); that would
        make the test flake on wording variance without catching real
        regressions.
        """
        response = self._post_verify(
            authenticated_session,
            api_base_url,
            "Vaccines cause autism because my son was diagnosed shortly after receiving the MMR vaccine",
        )
        assert response.status_code == 200
        fallacies = response.json().get("fallacy_warnings") or []

        for f in fallacies:
            description = (f.get("description") or "").strip()
            assert len(description) >= 20, f"Fallacy description is too short to be meaningful: {description!r}"
            assert f.get("name"), "Fallacy name must not be empty"
            assert f.get("category"), "Fallacy category must not be empty"

    def test_bias_flags_have_required_structure(self, authenticated_session, api_base_url):
        """Every bias flag must be a full BiasFlag dict (category/name/description)."""
        response = self._post_verify(
            authenticated_session,
            api_base_url,
            "Every successful entrepreneur dropped out of college, so dropping out makes you successful",
        )
        assert response.status_code == 200
        for flag in response.json().get("bias_flags") or []:
            assert "category" in flag
            assert flag["category"] in (
                "cognitive",
                "selection",
                "measurement",
                "analysis",
                "confounding",
            ), f"Invalid bias category: {flag['category']}"
            assert "name" in flag and flag["name"]
            assert "description" in flag and flag["description"]

    def test_empty_bias_and_fallacy_for_clean_claim(self, authenticated_session, api_base_url):
        """A well-hedged mainstream claim should NOT get padded with
        invented biases or fallacies. Regression guard against the LLM
        filling the lists with boilerplate."""
        response = self._post_verify(
            authenticated_session,
            api_base_url,
            "Several randomized controlled trials suggest that a Mediterranean diet "
            "may be associated with reduced cardiovascular risk, though effect sizes "
            "vary across populations",
        )
        assert response.status_code == 200
        data = response.json()

        # This claim is carefully hedged and cites RCTs — any biases
        # or fallacies should be few and point-specific, not a long
        # list. Loose ceiling so the test doesn't flake on LLM variance.
        bias_count = len(data.get("bias_flags") or [])
        fallacy_count = len(data.get("fallacy_warnings") or [])
        assert bias_count <= 3, f"Clean hedged claim got {bias_count} biases (expected <=3)"
        assert fallacy_count <= 2, f"Clean hedged claim got {fallacy_count} fallacies (expected <=2)"
