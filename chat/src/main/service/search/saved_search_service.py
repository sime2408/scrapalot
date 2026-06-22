"""Saved search service — virtual collections with auto-updating criteria.

Criteria format:
{
  "conditions": [
    {"field": "title", "operator": "contains", "value": "agriculture"},
    {"field": "year", "operator": "gte", "value": "2020"},
    {"field": "tag", "operator": "equals", "value": "Important"}
  ],
  "match": "all"  // "all" = AND, "any" = OR
}
"""

from datetime import UTC, datetime
import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from src.main.utils.core.logger import get_logger
from src.main.utils.redis.client import get_redis_client

logger = get_logger(__name__)

# Redis cache settings
CACHE_KEY_PREFIX = "scrapalot:saved_search"
CACHE_TTL = 300  # 5 minutes

# Supported fields and their SQL mappings
FIELD_MAPPINGS = {
    "title": "d.title",
    "filename": "d.filename",
    "year": "CAST(d.extracted_metadata->'resolved'->>'year' AS int)",
    "author": "d.extracted_metadata->'resolved'->>'authors'",
    "doi": "d.extracted_metadata->'identifiers'->>'doi'",
    "source_type": "d.extracted_metadata->'resolved'->>'document_type'",
    "processing_status": "d.processing_status",
    "created_at": "d.created_at",
    "updated_at": "d.updated_at",
    "file_type": "d.file_type",
    "page_count": "d.page_count",
    "file_size": "d.file_size",
    "collection_id": "dc.collection_id::text",
    "fulltextContent": "d.content",
}

# Operators that do not need a value parameter
NO_VALUE_OPERATORS = {"exists", "not_exists"}

# Text-comparison operators
TEXT_OPERATORS = {"contains", "equals", "isNot", "doesNotContain", "beginsWith"}

# Numeric-comparison operators
NUMERIC_OPERATORS = {"gte", "lte", "isLessThan", "isGreaterThan"}

# Date-comparison operators
DATE_OPERATORS = {"isBefore", "isAfter", "isInTheLast"}


def create_saved_search(db: Session, user_id: str, workspace_id: str, name: str, criteria: dict, color: str | None = None) -> dict:
    """Create a new saved search."""
    result = db.execute(
        text("""
            INSERT INTO saved_searches (name, user_id, workspace_id, criteria, color)
            VALUES (:name, :uid, CAST(:wid AS uuid), CAST(:criteria AS jsonb), :color)
            RETURNING id, name, criteria, color, is_pinned, created_at
        """),
        {"name": name, "uid": user_id, "wid": workspace_id, "criteria": json.dumps(criteria), "color": color},
    )
    db.commit()
    row = result.fetchone()
    # noinspection PyUnresolvedReferences
    return {
        "id": str(row[0]),
        "name": row[1],
        "criteria": row[2],
        "color": row[3],
        "is_pinned": row[4],
        "created_at": str(row[5]),
    }


def update_saved_search(
    db: Session,
    search_id: str,
    user_id: str,
    name: str | None = None,
    criteria: dict | None = None,
    color: str | None = None,
    is_pinned: bool | None = None,
) -> dict | None:
    """Update an existing saved search. Returns updated record or None if not found."""
    # Build dynamic SET clause
    set_parts = ["updated_at = now()"]
    params: dict[str, Any] = {"sid": search_id, "uid": user_id}

    if name is not None:
        set_parts.append("name = :name")
        params["name"] = name
    if criteria is not None:
        set_parts.append("criteria = CAST(:criteria AS jsonb)")
        params["criteria"] = json.dumps(criteria)
    if color is not None:
        set_parts.append("color = :color")
        params["color"] = color
    if is_pinned is not None:
        set_parts.append("is_pinned = :is_pinned")
        params["is_pinned"] = is_pinned

    query = f"""
        UPDATE saved_searches SET {", ".join(set_parts)}
        WHERE id = CAST(:sid AS uuid) AND user_id = :uid
        RETURNING id, name, criteria, icon, color, sort_order, is_pinned, result_count, last_evaluated_at, created_at, updated_at
    """
    result = db.execute(text(query), params)
    db.commit()
    row = result.fetchone()
    if not row:
        return None

    # Invalidate cache
    _invalidate_cache(search_id)

    return _row_to_dict(row)


def list_saved_searches(db: Session, user_id: str, workspace_id: str) -> list[dict]:
    """List all saved searches for a user in a workspace."""
    result = db.execute(
        text("""
            SELECT id, name, criteria, icon, color, sort_order, is_pinned, result_count, last_evaluated_at, created_at, updated_at
            FROM saved_searches
            WHERE user_id = :uid AND workspace_id = CAST(:wid AS uuid)
            ORDER BY is_pinned DESC, sort_order, name
        """),
        {"uid": user_id, "wid": workspace_id},
    )
    return [_row_to_dict(r) for r in result]


def delete_saved_search(db: Session, search_id: str, user_id: str) -> bool:
    """Delete a saved search."""
    result = db.execute(
        text("DELETE FROM saved_searches WHERE id = CAST(:sid AS uuid) AND user_id = :uid"),
        {"sid": search_id, "uid": user_id},
    )
    db.commit()
    _invalidate_cache(search_id)
    # noinspection PyUnresolvedReferences
    return result.rowcount > 0


def evaluate_saved_search(db: Session, search_id: str, user_id: str, limit: int = 200) -> list[str]:
    """Evaluate a saved search and return matching document IDs."""
    # Check cache first
    cached = _get_cached_results(search_id)
    if cached is not None:
        return cached[:limit]

    search = db.execute(
        text("SELECT criteria, workspace_id FROM saved_searches WHERE id = CAST(:sid AS uuid) AND user_id = :uid"),
        {"sid": search_id, "uid": user_id},
    ).fetchone()
    if not search:
        return []

    criteria = search[0] if isinstance(search[0], dict) else json.loads(search[0])
    workspace_id = str(search[1])

    doc_ids = evaluate_criteria(db, criteria, workspace_id, limit)

    # Update result_count and last_evaluated_at
    db.execute(
        text("""
            UPDATE saved_searches SET result_count = :cnt, last_evaluated_at = :ts
            WHERE id = CAST(:sid AS uuid)
        """),
        {"cnt": len(doc_ids), "ts": datetime.now(UTC), "sid": search_id},
    )
    db.commit()

    # Cache results
    _set_cached_results(search_id, doc_ids)

    return doc_ids


def preview_search(db: Session, criteria: dict, workspace_id: str) -> int:
    """Preview search — returns count of matching documents without full ID list."""
    conditions = criteria.get("conditions", [])
    match_mode = criteria.get("match", "all")

    if not conditions:
        return 0

    where_parts = []
    params: dict[str, Any] = {"wid": workspace_id}

    for i, cond in enumerate(conditions):
        clause = _build_condition_clause(cond, i, params)
        if clause:
            where_parts.append(clause)

    if not where_parts:
        return 0

    joiner = " AND " if match_mode == "all" else " OR "
    where_clause = joiner.join(where_parts)

    query = f"""
        SELECT COUNT(DISTINCT d.id) FROM documents d
        JOIN document_collections dc ON dc.document_id = d.id
        JOIN collection_workspace_map cwm ON cwm.collection_id = dc.collection_id
        WHERE cwm.workspace_id = CAST(:wid AS uuid)
        AND ({where_clause})
    """

    result = db.execute(text(query), params)
    return result.scalar() or 0


def _resolve_nested_search(
    db: Session,
    search_id: str,
    workspace_id: str,
    depth: int = 0,
    max_depth: int = 3,
    visited: set | None = None,
) -> list[str]:
    """Resolve a referenced saved search to document IDs (recursive, with cycle/depth guard)."""
    if depth >= max_depth:
        logger.warning("Nested saved search max depth %d reached at search %s", max_depth, search_id)
        return []
    if visited is None:
        visited = set()
    # noinspection PyUnresolvedReferences
    if search_id in visited:
        logger.warning("Cycle detected in nested saved search: %s", search_id)
        return []
    # noinspection PyUnresolvedReferences
    visited.add(search_id)

    row = db.execute(
        text("SELECT criteria FROM saved_searches WHERE id = CAST(:sid AS uuid)"),
        {"sid": search_id},
    ).fetchone()
    if not row or not row[0]:
        return []

    ref_criteria = row[0] if isinstance(row[0], dict) else json.loads(row[0])
    return evaluate_criteria(db, ref_criteria, workspace_id, limit=10000)


def evaluate_criteria(db: Session, criteria: dict, workspace_id: str, limit: int = 200) -> list[str]:
    """Evaluate search criteria and return matching document IDs."""
    conditions = criteria.get("conditions", [])
    match_mode = criteria.get("match", "all")

    if not conditions:
        return []

    # Resolve nested saved search conditions first
    saved_search_conds = [c for c in conditions if c.get("field") == "savedSearch"]
    regular_conds = [c for c in conditions if c.get("field") != "savedSearch"]

    nested_doc_ids: set = set()
    for cond in saved_search_conds:
        ref_id = cond.get("value", "")
        if ref_id:
            ids = _resolve_nested_search(db, ref_id, workspace_id)
            nested_doc_ids.update(ids)

    where_parts = []
    params: dict[str, Any] = {"wid": workspace_id, "lim": limit}

    for i, cond in enumerate(regular_conds):
        clause = _build_condition_clause(cond, i, params)
        if clause:
            where_parts.append(clause)

    # Add nested search IDs as IN clause
    if nested_doc_ids:
        id_list = ",".join(f"'{did}'" for did in nested_doc_ids)
        where_parts.append(f"d.id::text IN ({id_list})")

    if not where_parts:
        return []

    joiner = " AND " if match_mode == "all" else " OR "
    where_clause = joiner.join(where_parts)

    query = f"""
        SELECT DISTINCT d.id FROM documents d
        JOIN document_collections dc ON dc.document_id = d.id
        JOIN collection_workspace_map cwm ON cwm.collection_id = dc.collection_id
        WHERE cwm.workspace_id = CAST(:wid AS uuid)
        AND d.deleted_at IS NULL
        AND ({where_clause})
        LIMIT :lim
    """

    result = db.execute(text(query), params)
    return [str(r[0]) for r in result]


def invalidate_workspace_caches(db: Session, workspace_id: str) -> int:
    """Invalidate all saved search caches for a workspace. Returns count of invalidated caches."""
    result = db.execute(
        text("SELECT id FROM saved_searches WHERE workspace_id = CAST(:wid AS uuid)"),
        {"wid": workspace_id},
    )
    count = 0
    for row in result:
        _invalidate_cache(str(row[0]))
        count += 1
    if count > 0:
        logger.info("Invalidated %d saved search caches for workspace %s", count, workspace_id)
    return count


# ── Internal helpers ──────────────────────────────────────────────────────


def _build_condition_clause(cond: dict, index: int, params: dict[str, Any]) -> str | None:
    """Build a single SQL WHERE clause from a condition dict."""
    field = cond.get("field", "")
    operator = cond.get("operator", "")
    value = cond.get("value", "")
    param_key = f"v{index}"

    # Special fields
    if field == "tag":
        params[param_key] = value
        if operator == "isNot":
            return (
                f"NOT EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id AND t.name = :{param_key})"
            )
        if operator == "doesNotContain":
            return f"NOT EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id AND LOWER(t.name) LIKE LOWER(CONCAT('%', :{param_key}, '%')))"
        if operator == "contains":
            return f"EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id AND LOWER(t.name) LIKE LOWER(CONCAT('%', :{param_key}, '%')))"
        # Default: equals
        return f"EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id AND t.name = :{param_key})"

    if field == "has_summary":
        if value == "true" or operator == "exists":
            return "EXISTS (SELECT 1 FROM document_summaries ds WHERE ds.document_id = d.id)"
        return "NOT EXISTS (SELECT 1 FROM document_summaries ds WHERE ds.document_id = d.id)"

    if field == "graph_status":
        params[param_key] = value
        if operator == "isNot":
            return f"EXISTS (SELECT 1 FROM graph_sync_status gs WHERE gs.document_id = d.id::text AND gs.status != :{param_key})"
        return f"EXISTS (SELECT 1 FROM graph_sync_status gs WHERE gs.document_id = d.id::text AND gs.status = :{param_key})"

    if field == "annotationText":
        # Annotation text search requires cross-DB query to Kotlin DB.
        # Deferred — requires postgres_fdw or service-to-service auth for REST call.
        logger.info("annotationText search not yet supported (cross-DB)")
        return None

    if field == "chunkContent":
        # Search within embedded chunk text (langchain_pg_embedding.document)
        params[param_key] = value
        if operator == "doesNotContain":
            return f"NOT EXISTS (SELECT 1 FROM langchain_pg_embedding e WHERE e.collection_id = dc.collection_id::text AND LOWER(e.document) LIKE LOWER(CONCAT('%', :{param_key}, '%')))"
        if operator == "contains":
            return f"EXISTS (SELECT 1 FROM langchain_pg_embedding e WHERE e.collection_id = dc.collection_id::text AND LOWER(e.document) LIKE LOWER(CONCAT('%', :{param_key}, '%')))"
        return None

    if field == "savedSearch":
        # Recursive saved search — resolve referenced search to document IDs
        # Handled at a higher level to prevent SQL injection; skip here
        return None

    if field not in FIELD_MAPPINGS:
        return None

    sql_field = FIELD_MAPPINGS[field]
    params[param_key] = value

    # Author uses JSONB text search
    if field == "author":
        return _build_author_clause(operator, param_key)

    # Existence operators
    if operator == "exists":
        return f"{sql_field} IS NOT NULL"
    if operator == "not_exists":
        return f"{sql_field} IS NULL"

    # Text operators
    if operator == "contains":
        return f"LOWER({sql_field}) LIKE LOWER(CONCAT('%', :{param_key}, '%'))"
    if operator == "equals":
        return f"{sql_field} = :{param_key}"
    if operator == "isNot":
        return f"{sql_field} != :{param_key}"
    if operator == "doesNotContain":
        return f"LOWER({sql_field}) NOT LIKE LOWER(CONCAT('%', :{param_key}, '%'))"
    if operator == "beginsWith":
        return f"LOWER({sql_field}) LIKE LOWER(CONCAT(:{param_key}, '%'))"

    # Numeric operators
    if operator == "gte":
        return f"{sql_field} >= CAST(:{param_key} AS int)"
    if operator == "lte":
        return f"{sql_field} <= CAST(:{param_key} AS int)"
    if operator == "isLessThan":
        return f"{sql_field} < CAST(:{param_key} AS int)"
    if operator == "isGreaterThan":
        return f"{sql_field} > CAST(:{param_key} AS int)"

    # Date operators
    if operator == "isBefore":
        return f"{sql_field} < CAST(:{param_key} AS timestamptz)"
    if operator == "isAfter":
        return f"{sql_field} > CAST(:{param_key} AS timestamptz)"
    if operator == "isInTheLast":
        return f"{sql_field} >= NOW() - INTERVAL '1 day' * CAST(:{param_key} AS int)"

    return None


def _build_author_clause(operator: str, param_key: str) -> str:
    """Build author-specific clause (JSONB array text search)."""
    author_field = "LOWER(d.extracted_metadata->'resolved'->>'authors')"
    if operator == "contains":
        return f"{author_field} LIKE LOWER(CONCAT('%', :{param_key}, '%'))"
    if operator == "equals":
        return f"{author_field} = LOWER(:{param_key})"
    if operator == "isNot":
        return f"{author_field} != LOWER(:{param_key})"
    if operator == "doesNotContain":
        return f"{author_field} NOT LIKE LOWER(CONCAT('%', :{param_key}, '%'))"
    if operator == "beginsWith":
        return f"{author_field} LIKE LOWER(CONCAT(:{param_key}, '%'))"
    return f"{author_field} LIKE LOWER(CONCAT('%', :{param_key}, '%'))"


def _row_to_dict(row) -> dict:
    """Convert a saved_searches query row to dict."""
    return {
        "id": str(row[0]),
        "name": row[1],
        "criteria": row[2],
        "icon": row[3],
        "color": row[4],
        "sort_order": row[5],
        "is_pinned": row[6],
        "result_count": row[7],
        "last_evaluated_at": str(row[8]) if row[8] else None,
        "created_at": str(row[9]),
        "updated_at": str(row[10]),
    }


# ── Redis cache ──────────────────────────────────────────────────────────


def _get_cached_results(search_id: str) -> list[str] | None:
    """Return cached document IDs or None on miss."""
    try:
        redis_client = get_redis_client()
        key = f"{CACHE_KEY_PREFIX}:{search_id}:results"
        # noinspection PyUnresolvedReferences,PyTypeChecker
        data = redis_client.get(key)
        if data:
            # noinspection PyTypeChecker
            return json.loads(data)
    except Exception as e:
        logger.debug("Cache read failed for %s: %s", search_id, e)
    return None


def _set_cached_results(search_id: str, doc_ids: list[str]) -> None:
    """Cache document IDs with TTL."""
    try:
        redis_client = get_redis_client()
        key = f"{CACHE_KEY_PREFIX}:{search_id}:results"
        redis_client.setex(key, CACHE_TTL, json.dumps(doc_ids))
    except Exception as e:
        logger.debug("Cache write failed for %s: %s", search_id, e)


def _invalidate_cache(search_id: str) -> None:
    """Remove cached results for a search."""
    try:
        redis_client = get_redis_client()
        redis_client.delete(f"{CACHE_KEY_PREFIX}:{search_id}:results")
    except Exception as e:
        logger.debug("Cache invalidation failed for %s: %s", search_id, e)
