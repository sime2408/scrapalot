"""
Utility functions for the collection_workspace_map cache table.

This table replaces direct JOINs through the dropped workspaces and collections
tables. It is populated via gRPC handlers when Kotlin sends workspace/collection
context with requests.
"""

from uuid import UUID

from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger

logger = get_logger(__name__)


def upsert_collection_workspace(
    db: Session,
    collection_id: UUID,
    workspace_id: UUID,
    owner_user_id: UUID,
    collection_name: str | None = None,
    workspace_name: str | None = None,
    description: str | None = None,
    parent_collection_id: UUID | None = None,
    depth: int = 0,
    custom_instructions: str | None = None,
    graph_tier: int | None = None,
    graph_tier_provided: bool = False,
    parent_provided: bool = True,
) -> None:
    """Upsert a mapping entry. Called from gRPC handlers when context is available.

    `custom_instructions`: per-collection AI prompt
    addendum mirrored from Kotlin. Empty string from the wire is treated
    as an explicit wipe (overwrites the column with NULL); None means
    "leave alone" so that incremental updates that don't carry the field
    don't accidentally clear it.

    `graph_tier` / `graph_tier_provided`: knowledge-graph build tier mirrored from
    Kotlin. Because NULL is itself a meaningful value (inherit from parent), we can't
    use COALESCE to mean "leave alone" — `graph_tier_provided` distinguishes "set this
    (possibly to NULL/inherit)" from "field not carried, keep existing". Kotlin always
    sends it on the collections stream, so the replica stays authoritative.

    `parent_provided`: same idea for parent_collection_id. Per-event syncs always
    carry it (default True); the cold-start snapshot reconcile passes False for
    legacy snapshots that predate the field, so an old snapshot can't clobber an
    already-correct parent chain (which graph_tier inheritance depends on).
    """
    # Explicit wipe via empty string from the Redis
    # event payload. Kotlin sends "" when the user cleared the textarea;
    # we want that to overwrite the column rather than be COALESCE'd
    # back to the existing value.
    if custom_instructions == "":
        ci_value: str | None = None
        ci_clause = "custom_instructions = NULL, "
    elif custom_instructions is None:
        ci_value = None
        ci_clause = "custom_instructions = COALESCE(EXCLUDED.custom_instructions, collection_workspace_map.custom_instructions), "
    else:
        ci_value = custom_instructions
        ci_clause = "custom_instructions = EXCLUDED.custom_instructions, "

    # graph_tier: set the (possibly NULL) value when provided, else keep existing.
    if graph_tier_provided:
        gt_clause = "graph_tier = EXCLUDED.graph_tier, "
    else:
        gt_clause = "graph_tier = COALESCE(EXCLUDED.graph_tier, collection_workspace_map.graph_tier), "

    # parent: overwrite when carried, else preserve (legacy snapshots omit it).
    if parent_provided:
        pid_clause = "parent_collection_id = EXCLUDED.parent_collection_id, "
    else:
        pid_clause = "parent_collection_id = COALESCE(EXCLUDED.parent_collection_id, collection_workspace_map.parent_collection_id), "

    db.execute(
        text(
            "INSERT INTO collection_workspace_map "
            "(collection_id, workspace_id, owner_user_id, collection_name, workspace_name, description, parent_collection_id, depth, custom_instructions, graph_tier, updated_at) "
            "VALUES (:cid, :wid, :uid, :cname, :wname, :desc, :pid, :depth, :ci, :gt, NOW()) "
            "ON CONFLICT (collection_id) DO UPDATE SET "
            "workspace_id = EXCLUDED.workspace_id, "
            "owner_user_id = EXCLUDED.owner_user_id, "
            "collection_name = COALESCE(EXCLUDED.collection_name, collection_workspace_map.collection_name), "
            "workspace_name = COALESCE(EXCLUDED.workspace_name, collection_workspace_map.workspace_name), "
            "description = COALESCE(EXCLUDED.description, collection_workspace_map.description), "
            f"{pid_clause}"
            "depth = EXCLUDED.depth, "
            f"{ci_clause}"
            f"{gt_clause}"
            "updated_at = NOW()"
        ),
        {
            "cid": str(collection_id),
            "wid": str(workspace_id),
            "uid": str(owner_user_id),
            "cname": collection_name,
            "wname": workspace_name,
            "desc": description,
            "pid": str(parent_collection_id) if parent_collection_id else None,
            "depth": depth,
            "ci": ci_value,
            "gt": graph_tier if graph_tier_provided else None,
        },
    )
    db.commit()


def resolve_graph_tier(db: Session, collection_id: UUID | str | None) -> int:
    """Resolve the effective knowledge-graph build tier for a collection.

    An explicit graph_tier wins. NULL means inherit, so we walk up
    parent_collection_id until a non-NULL tier is found; a root collection that
    is still NULL resolves to 0 (no graph). Returns 0/1/2.

    One recursive SQL walk, bounded by the depth<=3 nesting cap, with a hard
    iteration guard against malformed cycles.
    """
    if collection_id is None:
        return 0
    cid = str(collection_id)
    seen: set[str] = set()
    for _ in range(8):  # nesting is capped at 4 levels; 8 is a safe cycle guard
        if cid in seen:
            break
        seen.add(cid)
        row = db.execute(
            text("SELECT graph_tier, parent_collection_id FROM collection_workspace_map WHERE collection_id = CAST(:cid AS uuid)"),
            {"cid": cid},
        ).fetchone()
        if row is None:
            return 0  # unknown collection → no graph
        tier, parent = row[0], row[1]
        if tier is not None:
            return int(tier)
        if parent is None:
            return 0  # root with no explicit tier → no graph
        cid = str(parent)
    return 0


def get_custom_instructions_for_collections(
    db: Session,
    collection_ids: list[UUID] | list[str],
) -> dict[str, str]:
    """Fetch non-empty custom_instructions for the given collection ids.

    Returns a dict mapping collection_id (string) → custom_instructions string.
    Collections without a value are omitted. Used by the system-prompt
    builder to assemble layer 3 of the priority chain when a chat is
    collection-scoped.
    """
    if not collection_ids:
        return {}
    ids = [str(c) for c in collection_ids]
    # collection_workspace_map.collection_id is UUID. psycopg2 binds Python
    # lists as text[] by default, so the bare `collection_id = ANY(:ids)`
    # would fail with "operator does not exist: uuid = text". Explicit cast
    # makes the comparison type-safe.
    rows = db.execute(
        text(
            "SELECT collection_id, custom_instructions "
            "FROM collection_workspace_map "
            "WHERE collection_id = ANY(CAST(:ids AS uuid[])) "
            "AND custom_instructions IS NOT NULL AND custom_instructions <> ''"
        ),
        {"ids": ids},
    ).fetchall()
    return {str(r[0]): r[1] for r in rows if r[1]}


def collection_graph_tier(collection_id: UUID | str | None) -> int:
    """resolve_graph_tier with a fresh short-lived session — convenience for
    housekeeping services (PageRank / communities / typed-rel) that gate on tier
    but don't already hold a Session. Returns 0/1/2."""
    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        return resolve_graph_tier(db, collection_id)
    finally:
        db.close()


def document_graph_tier(document_id: UUID | str) -> int:
    """Effective graph tier (0/1/2) for the collection a document belongs to."""
    from src.main.config.database import SessionLocal

    db = SessionLocal()
    try:
        row = db.execute(
            text("SELECT collection_id FROM documents WHERE id = CAST(:did AS uuid)"),
            {"did": str(document_id)},
        ).fetchone()
        cid = str(row[0]) if row and row[0] else None
        return resolve_graph_tier(db, cid)
    finally:
        db.close()


def get_child_collection_ids(db: Session, parent_id: UUID) -> list[UUID]:
    """Get all descendant collection IDs for a parent (recursive)."""
    rows = db.execute(
        text(
            "WITH RECURSIVE descendants AS ("
            "  SELECT collection_id FROM collection_workspace_map WHERE parent_collection_id = :pid "
            "  UNION ALL "
            "  SELECT c.collection_id FROM collection_workspace_map c "
            "  JOIN descendants d ON c.parent_collection_id = d.collection_id "
            "  WHERE c.depth <= 3"
            ") SELECT collection_id FROM descendants"
        ),
        {"pid": str(parent_id)},
    ).fetchall()
    return [UUID(str(r[0])) for r in rows]


def get_owner_for_collection(db: Session, collection_id: UUID) -> tuple[UUID, UUID, str | None, str | None] | None:
    """Returns (workspace_id, owner_user_id, collection_name, workspace_name) or None."""
    row = db.execute(
        text("SELECT workspace_id, owner_user_id, collection_name, workspace_name FROM collection_workspace_map WHERE collection_id = :cid"),
        {"cid": str(collection_id)},
    ).fetchone()
    if row:
        return UUID(str(row[0])), UUID(str(row[1])), row[2], row[3]
    return None


def get_collections_for_workspace(db: Session, workspace_id: UUID) -> list[dict]:
    """Returns all collections in a workspace from the map."""
    rows = db.execute(
        text(
            "SELECT collection_id, owner_user_id, collection_name, workspace_name, description "
            "FROM collection_workspace_map WHERE workspace_id = :wid"
        ),
        {"wid": str(workspace_id)},
    ).fetchall()
    return [
        {
            "collection_id": UUID(str(r[0])),
            "owner_user_id": UUID(str(r[1])),
            "collection_name": r[2],
            "workspace_name": r[3],
            "description": r[4],
        }
        for r in rows
    ]


def delete_collection_workspace(db: Session, collection_id: UUID) -> None:
    """Delete a mapping entry by collection_id."""
    db.execute(
        text("DELETE FROM collection_workspace_map WHERE collection_id = :cid"),
        {"cid": str(collection_id)},
    )
    db.commit()


def delete_workspace_collections(db: Session, workspace_id: UUID) -> None:
    """Delete all mapping entries for a workspace."""
    db.execute(
        text("DELETE FROM collection_workspace_map WHERE workspace_id = :wid"),
        {"wid": str(workspace_id)},
    )
    db.commit()


def update_workspace_name(db: Session, workspace_id: UUID, workspace_name: str) -> None:
    """Update workspace_name for all collections in a workspace."""
    db.execute(
        text("UPDATE collection_workspace_map SET workspace_name = :wname, updated_at = NOW() WHERE workspace_id = :wid"),
        {"wname": workspace_name, "wid": str(workspace_id)},
    )
    db.commit()


def get_collections_for_owner(db: Session, owner_user_id: UUID) -> list[dict]:
    """Returns all collections owned by a user from the map."""
    rows = db.execute(
        text(
            "SELECT collection_id, workspace_id, collection_name, workspace_name, description "
            "FROM collection_workspace_map WHERE owner_user_id = :uid"
        ),
        {"uid": str(owner_user_id)},
    ).fetchall()
    return [
        {
            "collection_id": UUID(str(r[0])),
            "workspace_id": UUID(str(r[1])),
            "collection_name": r[2],
            "workspace_name": r[3],
            "description": r[4],
        }
        for r in rows
    ]


def update_collection_description(db: Session, collection_id: UUID, description: str) -> None:
    """Update description for a specific collection."""
    db.execute(
        text("UPDATE collection_workspace_map SET description = :desc, updated_at = NOW() WHERE collection_id = :cid"),
        {"desc": description, "cid": str(collection_id)},
    )
    db.commit()
