"""
Integration tests for tabular (CSV / TSV / XLSX) document ingestion.

These exercise the REAL parser used by both the streaming dispatcher
(`DocumentService.process_tabular`) and the Celery worker dispatcher
(`DocumentService.process_tabular` → `document_processor.process_tabular` →
`TabularProcessor.process_tabular`). No mocks: real files, real pandas/openpyxl,
real csv module.

Validated behavior:
- CSV is parsed into a GitHub-flavored Markdown table (not one raw blob).
- A multi-sheet XLSX yields one section per worksheet with the sheet name as a
  heading, and every chunk is self-describing (header row present).
- TSV delimiter is auto-detected.
- Wide/large tables chunk by row group and repeat the header on each chunk.
- The dispatch routing decision sends tabular extensions to the tabular parser
  (and away from the PDF/Docling path).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from src.main.service.document.document_processor_tabular import (
    _TABULAR_EXTENSIONS,
    _is_tabular_extension,
    process_tabular,
)
from src.main.service.document.documents import DocumentService

_FIXTURE_DIR = Path(__file__).parent.parent.parent / "fixtures" / "tabular"
_CSV = _FIXTURE_DIR / "employees.csv"
_XLSX = _FIXTURE_DIR / "financials.xlsx"
_XLS = _FIXTURE_DIR / "sales_legacy.xls"


def _is_markdown_table(text: str) -> bool:
    """A GFM table has a header row and a `| --- | --- |` separator line."""
    lines = [ln for ln in text.splitlines() if ln.strip().startswith("|")]
    if len(lines) < 2:
        return False
    sep = lines[1].replace(" ", "")
    return set(sep) <= set("|-:") and "---" in sep


@pytest.mark.integration
class TestTabularParsing:
    def test_fixtures_exist(self):
        assert _CSV.exists(), f"missing fixture {_CSV}"
        assert _XLSX.exists(), f"missing fixture {_XLSX}"

    def test_csv_renders_markdown_table_not_blob(self):
        docs = DocumentService.process_tabular(file_path=str(_CSV))
        assert docs, "no documents produced from CSV"
        # Not one opaque blob: content is a Markdown table.
        full = "\n\n".join(d.page_content for d in docs)
        assert _is_markdown_table(docs[0].page_content), f"not a markdown table:\n{docs[0].page_content}"
        # Header labels present.
        assert "name" in full and "department" in full and "salary" in full
        # A specific cell value is retrievable from the rendered content.
        assert "Carol Nguyen" in full
        assert "Staff Engineer" in full
        # Metadata shape matches other parsers.
        meta = docs[0].metadata
        assert meta["file_type"] == "csv"
        assert meta["title"] == "employees"
        assert meta["processing_method"] == "tabular"
        assert int(meta["word_count"]) > 0

    def test_xlsx_one_section_per_sheet_with_headings(self):
        docs = process_tabular(file_path=str(_XLSX))
        assert docs, "no documents produced from XLSX"
        joined = "\n\n".join(d.page_content for d in docs)
        # Each sheet name rendered as a Markdown heading.
        assert "## Quarterly Revenue" in joined
        assert "## Product Catalog" in joined
        # Every chunk is self-describing: contains a markdown table.
        for d in docs:
            assert _is_markdown_table(d.page_content), f"sheet chunk not a table:\n{d.page_content}"
        # Cell values from BOTH sheets are present.
        assert "Asia Pacific" in joined
        assert "Hydraulic Press Model X" in joined
        # Sheet name carried in metadata.
        sheet_names = {d.metadata.get("sheet_name") for d in docs}
        assert "Quarterly Revenue" in sheet_names
        assert "Product Catalog" in sheet_names

    def test_xls_legacy_renders_markdown_tables(self):
        # Legacy BIFF .xls goes through the xlrd engine (not openpyxl).
        docs = process_tabular(file_path=str(_XLS))
        assert docs, "no documents produced from legacy XLS"
        joined = "\n\n".join(d.page_content for d in docs)
        for d in docs:
            assert _is_markdown_table(d.page_content), f"xls sheet chunk not a table:\n{d.page_content}"
        # Both worksheets parsed, sheet names rendered as headings.
        assert "## Q1" in joined and "## Q2" in joined
        sheet_names = {d.metadata.get("sheet_name") for d in docs}
        assert {"Q1", "Q2"} <= sheet_names
        # Cell values from both sheets present.
        assert "Widget" in joined and "Gizmo" in joined
        assert docs[0].metadata["file_type"] == "xls"

    def test_tsv_delimiter_autodetect(self, tmp_path):
        tsv = tmp_path / "data.tsv"
        tsv.write_text("city\tpopulation\tcountry\nTokyo\t37400068\tJapan\nDelhi\t28514000\tIndia\n")
        docs = process_tabular(file_path=str(tsv))
        assert docs
        content = docs[0].page_content
        assert _is_markdown_table(content)
        # Columns split correctly (delimiter detected) — 3 header cells.
        header_line = next(ln for ln in content.splitlines() if "city" in ln)
        assert header_line.count("|") == 4  # 3 columns → 4 pipes
        assert "Tokyo" in content and "37400068" in content

    def test_large_table_chunks_repeat_header(self, tmp_path):
        # Build a CSV with > _ROWS_PER_CHUNK (200) rows to force multiple chunks.
        rows = ["id,label,value"]
        for i in range(450):
            rows.append(f"{i},item_{i},{i * 7}")
        big = tmp_path / "big.csv"
        big.write_text("\n".join(rows) + "\n")
        docs = process_tabular(file_path=str(big))
        # 450 data rows / 200 per chunk = 3 chunks.
        assert len(docs) == 3, f"expected 3 row-group chunks, got {len(docs)}"
        for d in docs:
            # Header repeated on every chunk → self-describing.
            assert "| id | label | value |" in d.page_content
            assert _is_markdown_table(d.page_content)
        # The last row only appears in the last chunk.
        assert "item_449" in docs[-1].page_content
        assert "item_449" not in docs[0].page_content

    def test_bom_and_quoting_handled(self, tmp_path):
        # UTF-8 BOM + quoted field containing a comma and a newline.
        f = tmp_path / "quoted.csv"
        content = '﻿name,note\n"Smith, John","line one\nline two"\nDoe,plain\n'
        f.write_bytes(content.encode("utf-8"))
        docs = process_tabular(file_path=str(f))
        assert docs
        md = docs[0].page_content
        # BOM stripped → header is "name", not "﻿name".
        assert md.splitlines()[0].lstrip("|").strip().startswith("name")
        # Quoted comma kept as a single cell value.
        assert "Smith, John" in md
        # Embedded newline collapsed to a single table row.
        assert "line one line two" in md

    def test_dispatch_routes_tabular_away_from_pdf(self):
        # The worker/streaming dispatchers branch on these extensions; assert the
        # routing contract the dispatchers rely on.
        for ext in (".csv", ".tsv", ".xlsx", ".xls"):
            assert _is_tabular_extension(ext)
            assert ext in _TABULAR_EXTENSIONS
        assert not _is_tabular_extension(".pdf")
        assert not _is_tabular_extension(".txt")
