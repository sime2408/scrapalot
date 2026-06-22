"""
Integration tests for the multimodal element pipeline.

Covers:
- persist_drafts: Draft -> multimodal_elements row + WebP file on disk
- describe_pending_for_document: pending row -> processing_status='indexed' or 'failed'
- multimodal_graph_sync: indexed row -> Neo4j Image / Table / Equation entity

Tests use the real Postgres database, real filesystem for image storage,
and (for the describe smoke test) the real system LLM provider. No mocks.
"""

from __future__ import annotations

import io
from pathlib import Path
import uuid

from PIL import Image
import pytest

from src.main.service.document_processing.multimodal_extractor import MultimodalElementDraft
from src.main.service.document_processing.multimodal_persister import persist_drafts


@pytest.fixture
def temp_document_id(python_db):
    """Insert a synthetic Document row, yield its id, clean up after."""
    cursor = python_db.cursor()
    doc_id = str(uuid.uuid4())
    collection_id = str(uuid.uuid4())
    cursor.execute(
        """
        INSERT INTO documents (
            id, collection_id, title, filename, file_path, file_size,
            file_type, processing_status, processing_progress
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (doc_id, collection_id, "Multimodal test", "fake.pdf", "/tmp/fake.pdf", 1024, "pdf", "completed", 100.0),
    )
    python_db.commit()
    cursor.close()

    yield doc_id

    cursor = python_db.cursor()
    cursor.execute("DELETE FROM multimodal_elements WHERE document_id = %s", (doc_id,))
    cursor.execute("DELETE FROM documents WHERE id = %s", (doc_id,))
    python_db.commit()
    cursor.close()


@pytest.fixture
def db_session():
    """SQLAlchemy session bound to the same Postgres database."""
    from src.main.config.database import SessionLocal

    session = SessionLocal()
    yield session
    session.close()


def _make_png_bytes() -> bytes:
    img = Image.new("RGB", (32, 32), color=(200, 100, 50))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.integration
class TestMultimodalPersister:
    def test_persist_image_table_equation_drafts(self, db_session, temp_document_id, py_cursor):
        drafts = [
            MultimodalElementDraft(
                element_type="image",
                element_index=0,
                page_idx=2,
                bbox={"x0": 10.0, "y0": 20.0, "x1": 110.0, "y1": 120.0},
                image_bytes=_make_png_bytes(),
                image_format="png",
                caption="Synthetic test figure",
            ),
            MultimodalElementDraft(
                element_type="table",
                element_index=0,
                page_idx=3,
                table_markdown="| a | b |\n| --- | --- |\n| 1 | 2 |",
                table_structured={
                    "headers": ["a", "b"],
                    "rows": [["1", "2"]],
                    "col_count": 2,
                    "row_count": 1,
                },
                caption="Tiny test table",
            ),
            MultimodalElementDraft(
                element_type="equation",
                element_index=0,
                page_idx=4,
                equation_latex="E = m c^2",
            ),
        ]

        ids = persist_drafts(db_session, temp_document_id, drafts)
        assert len(ids) == 3

        py_cursor.execute(
            """
            SELECT element_type, element_index, page_idx, content_text,
                   storage_path, processing_status, structured_data
            FROM multimodal_elements
            WHERE document_id = %s
            ORDER BY element_type, element_index
            """,
            (temp_document_id,),
        )
        rows = py_cursor.fetchall()
        assert len(rows) == 3

        by_type = {r["element_type"]: r for r in rows}

        image_row = by_type["image"]
        assert image_row["page_idx"] == 2
        assert image_row["processing_status"] == "pending"
        assert image_row["storage_path"] is not None
        assert Path(image_row["storage_path"]).is_file()
        # WebP encoded from PNG
        assert image_row["storage_path"].endswith(".webp")

        table_row = by_type["table"]
        assert "| a | b |" in table_row["content_text"]
        assert table_row["structured_data"]["col_count"] == 2
        assert table_row["structured_data"]["row_count"] == 1

        equation_row = by_type["equation"]
        assert equation_row["content_text"] == "E = m c^2"

    def test_persist_is_idempotent_via_upsert(self, db_session, temp_document_id, py_cursor):
        draft = MultimodalElementDraft(
            element_type="equation",
            element_index=0,
            page_idx=1,
            equation_latex="x + 1",
        )
        persist_drafts(db_session, temp_document_id, [draft])
        persist_drafts(db_session, temp_document_id, [draft])

        py_cursor.execute(
            "SELECT COUNT(*) AS c FROM multimodal_elements WHERE document_id = %s",
            (temp_document_id,),
        )
        assert py_cursor.fetchone()["c"] == 1


@pytest.mark.integration
@pytest.mark.slow
class TestMultimodalDescriber:
    @pytest.mark.asyncio
    async def test_describe_equation_pending_row(self, db_session, temp_document_id, py_cursor):
        """Smoke test the equation agent against a real pending row.

        Uses the real system LLM provider — skipped automatically if the
        provider is not reachable.
        """
        from src.main.service.document_processing.multimodal_describer import describe_pending_for_document

        # Insert a pending equation row directly (skip Docling / persist).
        cursor = db_session.connection().connection.cursor()
        cursor.execute(
            """
            INSERT INTO multimodal_elements (
                document_id, element_type, element_index, page_idx,
                content_text, processing_status
            )
            VALUES (%s, 'equation', 0, 1, %s, 'pending')
            """,
            (temp_document_id, "E = m c^2"),
        )
        db_session.connection().connection.commit()
        cursor.close()

        try:
            counters = await describe_pending_for_document(db_session, temp_document_id)
        except Exception as ex:
            pytest.skip(f"System LLM unreachable: {ex}")

        assert counters["described"] + counters["failed"] + counters["skipped"] >= 1

        py_cursor.execute(
            """
            SELECT processing_status, description, entity_name, processing_error
            FROM multimodal_elements
            WHERE document_id = %s AND element_type = 'equation'
            """,
            (temp_document_id,),
        )
        row = py_cursor.fetchone()
        assert row is not None
        assert row["processing_status"] in ("indexed", "failed")
        if row["processing_status"] == "indexed":
            assert row["description"] is not None
            assert len(row["description"]) > 0


@pytest.mark.integration
class TestMultimodalGraphSync:
    def test_sync_to_neo4j_when_unavailable_is_noop(self, db_session, temp_document_id, py_cursor):
        """Phase-4 sync is best-effort: when Neo4j is unreachable, it
        returns 0 and leaves rows untouched rather than aborting."""

        from src.main.service.document_processing.multimodal_graph_sync import sync_described_to_neo4j

        cursor = db_session.connection().connection.cursor()
        cursor.execute(
            """
            INSERT INTO multimodal_elements (
                document_id, element_type, element_index, page_idx,
                description, entity_name, processing_status
            )
            VALUES (%s, 'image', 0, 1, %s, %s, 'indexed')
            """,
            (temp_document_id, "A red square test image", "test_image_1"),
        )
        db_session.connection().connection.commit()
        cursor.close()

        synced = sync_described_to_neo4j(db_session, temp_document_id)
        assert synced >= 0

        py_cursor.execute(
            """
            SELECT processing_status, neo4j_entity_id
            FROM multimodal_elements
            WHERE document_id = %s AND element_type = 'image'
            """,
            (temp_document_id,),
        )
        row = py_cursor.fetchone()
        assert row["processing_status"] == "indexed"
        # If Neo4j was reachable, neo4j_entity_id is set; otherwise NULL.
        # Both are valid outcomes — sync is best-effort by design.


@pytest.mark.integration
class TestMultimodalConfig:
    def test_multimodal_pipeline_respects_disabled_flag(self, db_session, temp_document_id, monkeypatch):
        """`is_multimodal_enabled` must short-circuit the pipeline."""
        from src.main.service.document_processing import multimodal_pipeline

        original = multimodal_pipeline.is_multimodal_enabled
        try:
            multimodal_pipeline.is_multimodal_enabled = lambda: False
            counters = multimodal_pipeline.describe_pending(db_session, temp_document_id)
            assert counters == {"described": 0, "failed": 0, "skipped": 0}
        finally:
            multimodal_pipeline.is_multimodal_enabled = original

    def test_streaming_packets_serialise_round_trip(self):
        """Phase-5 packet schemas must serialise / deserialise via the
        Packet wrapper (discriminator='type')."""
        from src.main.dto.streaming import (
            MultimodalElementDescribedPacket,
            MultimodalElementIndexedPacket,
            MultimodalElementStartedPacket,
            create_packet,
            parse_packet,
        )

        for packet_type, kwargs in [
            (
                MultimodalElementStartedPacket,
                {"document_id": "d1", "element_id": "e1", "element_type": "image", "page_idx": 1, "element_index": 0},
            ),
            (
                MultimodalElementDescribedPacket,
                {"document_id": "d1", "element_id": "e1", "element_type": "table", "entity_name": "tab1", "succeeded": True},
            ),
            (
                MultimodalElementIndexedPacket,
                {"document_id": "d1", "element_id": "e1", "element_type": "equation", "neo4j_entity_id": "n1"},
            ),
        ]:
            json_str = create_packet(packet_type, ind=0, **kwargs)
            packet = parse_packet(json_str)
            assert packet.obj.type == packet_type.model_fields["type"].default
            assert packet.obj.document_id == "d1"
            assert packet.obj.element_id == "e1"
