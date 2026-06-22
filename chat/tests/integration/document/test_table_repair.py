"""Integration tests for <br>-collapsed table repair.

Pure-function tests (detector + number guard) run with no LLM. The end-to-end
rebuild test uses the REAL system LLM (no mocks, per project policy) and asserts
the safety invariants: structure expands and NO number is hallucinated.
"""

import pytest

from src.main.service.document.table_repair import (
    detect_collapsed_table_blocks,
    numbers_preserved,
    repair_collapsed_tables,
)

# Real collapsed Race-Summary block as produced by pymupdf4llm on a racing form.
_COLLAPSED = """Churchill Downs Race 1 — conditions apply.

|#     Speed Last Race||#          Prime Power||#         Class Rating|
|---|---|---|---|---|
|2<br>Weaponized<br>84<br>6<br>Miracle Mark<br>81<br>5<br>Sound Cause<br>75||6<br>Miracle Mark<br>124.4<br>3<br>Midway Munny<br>122.6<br>1<br>Mirage<br>122.0||6<br>Miracle Mark<br>113.6<br>3<br>Midway Munny<br>112.5<br>1<br>Mirage<br>111.6|

Ordinary prose after the table that must stay untouched.
"""


class TestTableRepairPure:
    def test_detects_collapsed_block(self):
        blocks = detect_collapsed_table_blocks(_COLLAPSED)
        assert len(blocks) == 1, f"expected one collapsed block, got {blocks}"

    def test_no_false_positive_on_plain_text(self):
        plain = "Just prose.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nMore prose."
        assert detect_collapsed_table_blocks(plain) == []

    def test_number_guard_rejects_invented_value(self):
        src = "| 84 | 81 | 75 |"
        assert numbers_preserved(src, "| 84 | 81 |") is True  # subset ok
        assert numbers_preserved(src, "| 84 | 99 |") is False  # 99 not in source

    def test_noop_without_br(self):
        txt = "No tables here, just text with numbers 12 and 34."
        assert repair_collapsed_tables(txt) == txt


@pytest.mark.integration
class TestTableRepairLLM:
    def test_rebuild_recovers_structure_and_preserves_numbers(self):
        out = repair_collapsed_tables(_COLLAPSED)
        # Prose is never touched.
        assert "Ordinary prose after the table that must stay untouched." in out
        # Safety rail: every number in the result existed in the source.
        assert numbers_preserved(_COLLAPSED, out), "a number was hallucinated/altered"
        # Structure expanded: more pipe-rows than the single collapsed data row.
        collapsed_pipe_rows = sum(1 for ln in _COLLAPSED.splitlines() if ln.count("<br>") >= 3)
        out_pipe_rows = sum(1 for ln in out.splitlines() if ln.strip().startswith("|"))
        assert out_pipe_rows > collapsed_pipe_rows + 1, f"grid did not expand:\n{out}"
        # Key values survived.
        for token in ("Weaponized", "Miracle Mark", "124.4", "75"):
            assert token in out, f"missing {token!r} in rebuilt table"
