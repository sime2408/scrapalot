"""Document tag service — colored tags with keyboard shortcuts.

Tags are workspace-scoped and user-owned. Documents can have multiple tags.
Tags work cross-collection for RAG filtering.
"""

from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)

# Default tags created on first use
DEFAULT_TAGS = [
    {"name": "Important", "color": "#ff6666", "position": 0},
    {"name": "Key Finding", "color": "#ffd400", "position": 1},
    {"name": "Methodology", "color": "#5fb236", "position": 2},
    {"name": "To Review", "color": "#2ea8e5", "position": 3},
    {"name": "Reference", "color": "#a28ae5", "position": 4},
]


def ensure_default_tags(db: Session, user_id: str, workspace_id: str) -> None:
    """Create default tags if user has no tags in this workspace."""
    # noinspection PyTypeChecker
    count: int = int(
        db.execute(
            text("SELECT COUNT(*) FROM tags WHERE user_id = :uid AND workspace_id = CAST(:wid AS uuid)"),
            {"uid": user_id, "wid": workspace_id},
        ).scalar()
        or 0
    )
    if count > 0:
        return

    for tag in DEFAULT_TAGS:
        db.execute(
            text("""
                INSERT INTO tags (name, color, position, user_id, workspace_id)
                VALUES (:name, :color, :pos, :uid, CAST(:wid AS uuid))
                ON CONFLICT DO NOTHING
            """),
            {"name": tag["name"], "color": tag["color"], "pos": tag["position"], "uid": user_id, "wid": workspace_id},
        )
    db.commit()
    logger.info("Created %d default tags for user %s", len(DEFAULT_TAGS), user_id[:8])


def list_tags(db: Session, user_id: str, workspace_id: str) -> list[dict]:
    """List all tags for a user in a workspace."""
    ensure_default_tags(db, user_id, workspace_id)
    result = db.execute(
        text("""
            SELECT t.id, t.name, t.color, t.position, t.tag_type,
                   COUNT(dt.id) as doc_count
            FROM tags t
            LEFT JOIN document_tags dt ON dt.tag_id = t.id
            WHERE t.user_id = :uid AND t.workspace_id = CAST(:wid AS uuid)
            GROUP BY t.id
            ORDER BY t.tag_type, t.position NULLS LAST, t.name
        """),
        {"uid": user_id, "wid": workspace_id},
    )
    return [{"id": str(r[0]), "name": r[1], "color": r[2], "position": r[3], "tag_type": r[4], "doc_count": r[5]} for r in result]


def create_tag(
    db: Session,
    user_id: str,
    workspace_id: str,
    name: str,
    color: str = "#aaaaaa",
    position: int | None = None,
    tag_type: int = 0,
) -> dict:
    """Create a new tag. tag_type: 0=manual, 1=automatic (from metadata keywords)."""
    result = db.execute(
        text("""
            INSERT INTO tags (name, color, position, user_id, workspace_id, tag_type)
            VALUES (:name, :color, :pos, :uid, CAST(:wid AS uuid), :tag_type)
            ON CONFLICT (name, user_id, workspace_id) DO NOTHING
            RETURNING id, name, color, position, tag_type
        """),
        {"name": name, "color": color, "pos": position, "uid": user_id, "wid": workspace_id, "tag_type": tag_type},
    )
    db.commit()
    row = result.fetchone()
    if not row:
        # Tag already exists — return existing
        existing = db.execute(
            text("SELECT id, name, color, position, tag_type FROM tags WHERE name = :name AND user_id = :uid AND workspace_id = CAST(:wid AS uuid)"),
            {"name": name, "uid": user_id, "wid": workspace_id},
        ).fetchone()
        if existing:
            return {
                "id": str(existing[0]),
                "name": existing[1],
                "color": existing[2],
                "position": existing[3],
                "tag_type": existing[4],
            }
        return {}
    return {"id": str(row[0]), "name": row[1], "color": row[2], "position": row[3], "tag_type": row[4]}


def update_tag(
    db: Session,
    tag_id: str,
    user_id: str,
    name: str | None = None,
    color: str | None = None,
    position: int | None = None,
) -> bool:
    """Update a tag (name, color, position)."""
    sets = []
    params: dict = {"tid": tag_id, "uid": user_id}
    if name is not None:
        sets.append("name = :name")
        params["name"] = name
    if color is not None:
        sets.append("color = :color")
        params["color"] = color
    if position is not None:
        sets.append("position = :pos")
        # noinspection PyTypeChecker
        params["pos"] = position
    if not sets:
        return False

    result = db.execute(
        text(f"UPDATE tags SET {', '.join(sets)} WHERE id = CAST(:tid AS uuid) AND user_id = :uid"),
        params,
    )
    db.commit()
    # noinspection PyUnresolvedReferences
    return result.rowcount > 0


def delete_tag(db: Session, tag_id: str, user_id: str) -> bool:
    """Delete a tag and all its document associations."""
    result = db.execute(
        text("DELETE FROM tags WHERE id = CAST(:tid AS uuid) AND user_id = :uid"),
        {"tid": tag_id, "uid": user_id},
    )
    db.commit()
    # noinspection PyUnresolvedReferences
    return result.rowcount > 0


def _verify_tag_ownership(db: Session, tag_id: str, user_id: str) -> bool:
    """Verify the tag belongs to a workspace the user has access to."""
    # Check if the tag's workspace is one that the user is a member of (via Kotlin's workspace_users table
    # in scrapalot_backend DB). Since Python can't query that DB, fall back to checking if the tag's
    # user_id matches OR if user_id is empty (backward compat with old Kotlin proto without user_id).
    if not user_id:
        # Old Kotlin backend didn't send user_id — allow for backward compatibility
        row = db.execute(
            text("SELECT 1 FROM tags WHERE id = CAST(:tid AS uuid)"),
            {"tid": tag_id},
        ).fetchone()
        return row is not None
    row = db.execute(
        text("SELECT 1 FROM tags WHERE id = CAST(:tid AS uuid) AND (user_id = :uid OR user_id IS NULL)"),
        {"tid": tag_id, "uid": user_id},
    ).fetchone()
    return row is not None


def tag_document(db: Session, document_id: str, tag_id: str, user_id: str) -> bool:
    """Add a tag to a document (idempotent). Verifies tag ownership."""
    try:
        if not _verify_tag_ownership(db, tag_id, user_id):
            logger.warning("Tag %s does not belong to user %s", tag_id, user_id[:8])
            return False
        db.execute(
            text("""
                INSERT INTO document_tags (document_id, tag_id)
                VALUES (CAST(:did AS uuid), CAST(:tid AS uuid))
                ON CONFLICT DO NOTHING
            """),
            {"did": document_id, "tid": tag_id},
        )
        db.commit()
        return True
    except Exception as e:
        db.rollback()
        logger.error("Failed to tag document: %s", str(e))
        return False


def untag_document(db: Session, document_id: str, tag_id: str, user_id: str) -> bool:
    """Remove a tag from a document. Verifies tag ownership."""
    if not _verify_tag_ownership(db, tag_id, user_id):
        logger.warning("Tag %s does not belong to user %s", tag_id, user_id[:8])
        return False
    result = db.execute(
        text("DELETE FROM document_tags WHERE document_id = CAST(:did AS uuid) AND tag_id = CAST(:tid AS uuid)"),
        {"did": document_id, "tid": tag_id},
    )
    db.commit()
    # noinspection PyUnresolvedReferences
    return result.rowcount > 0


def get_document_tags(db: Session, document_id: str) -> list[dict]:
    """Get all tags for a document."""
    result = db.execute(
        text("""
            SELECT t.id, t.name, t.color, t.position
            FROM tags t
            JOIN document_tags dt ON dt.tag_id = t.id
            WHERE dt.document_id = CAST(:did AS uuid)
            ORDER BY t.position NULLS LAST, t.name
        """),
        {"did": document_id},
    )
    return [{"id": str(r[0]), "name": r[1], "color": r[2], "position": r[3]} for r in result]


def auto_tag_from_keywords(db: Session, document_id: str, user_id: str, workspace_id: str, keywords: list[str]) -> int:
    """Create automatic tags from metadata keywords (CrossRef subjects) and assign to document.

    tag_type=1 (automatic). Skips empty/duplicate keywords. Returns count of tags assigned.
    """
    count = 0
    for keyword in keywords:
        keyword = keyword.strip()
        if not keyword or len(keyword) < 2 or len(keyword) > 100:
            continue
        tag = create_tag(db, user_id, workspace_id, keyword, color="#aaaaaa", tag_type=1)
        if tag and tag.get("id"):
            if tag_document(db, document_id, tag["id"], user_id):
                count += 1
    return count


def delete_auto_tags(db: Session, user_id: str, workspace_id: str) -> int:
    """Delete all automatic tags (tag_type=1) and their document associations for a user/workspace.

    Returns count of deleted tags.
    """
    # Delete document_tags first (FK cascade would handle it, but be explicit)
    db.execute(
        text("""
            DELETE FROM document_tags WHERE tag_id IN (
                SELECT id FROM tags WHERE user_id = :uid AND workspace_id = CAST(:wid AS uuid) AND tag_type = 1
            )
        """),
        {"uid": user_id, "wid": workspace_id},
    )
    result = db.execute(
        text("DELETE FROM tags WHERE user_id = :uid AND workspace_id = CAST(:wid AS uuid) AND tag_type = 1"),
        {"uid": user_id, "wid": workspace_id},
    )
    db.commit()
    # noinspection PyUnresolvedReferences
    return result.rowcount
