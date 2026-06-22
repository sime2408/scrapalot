"""
End-to-end API tests for the notes version-control endpoints.

Covers the named-save and restore-with-undo surfaces under
`/api/v1/notes/{id}/versions/*`:

    POST /notes/{id}/versions/save-named            — explicit user save-point
    GET  /notes/{id}/versions                        — listing (auto + named + restore rows)
    POST /notes/{id}/versions/{vid}/restore          — apply a previous version

The auto-snapshot path (every successful note update spawns a
`kind=auto` row) is exercised implicitly via _create_note → restore;
its own contract is owned by the older notes-collaboration tests.

These tests are kept *fast* on purpose — no LLM in the loop, so the
fast slice can run them on every commit without the slow-marker gate
the assistant-endpoint tests carry.
"""

from __future__ import annotations

import time
import uuid

import pytest
import requests

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_workspace_id(authenticated_session, gateway_url: str) -> str:
    """Pick the first workspace the admin user has access to. We don't
    care which one — the named-save / restore flow is workspace-
    agnostic — but `workspace_id` is a `@NotNull` field on
    CreateNoteRequest so we have to feed something."""
    r = authenticated_session.get(f"{gateway_url}/workspaces", timeout=15)
    r.raise_for_status()
    body = r.json()
    workspaces = body.get("workspaces") if isinstance(body, dict) else body
    assert workspaces, "no workspaces visible to test user"
    return workspaces[0]["id"]


def _create_note(authenticated_session, gateway_url: str, *, content: str = "") -> dict:
    """Create a fresh note for a test and return the response payload.

    Each version-control test gets its own note because the named-save
    tests mutate version state — sharing a fixture note across tests
    would couple them through `versions[]` and make order-dependent
    failures unbearable to debug."""
    title = f"e2e-versions-{uuid.uuid4().hex[:8]}"
    body = content or (
        "<h1>Working Memory & Attention</h1>"
        "<p>The role of long-form attention in working memory remains debated. "
        "Several studies report dissociations between short-term store and "
        "central executive function.</p>"
    )
    workspace_id = _get_workspace_id(authenticated_session, gateway_url)
    response = authenticated_session.post(
        f"{gateway_url}/notes",
        json={
            "title": title,
            "content": body,
            "workspace_id": workspace_id,
            "note_type": "rich",
        },
        timeout=30,
    )
    assert response.status_code in (200, 201), f"Note create failed: {response.text}"
    return response.json()


def _delete_note(authenticated_session, gateway_url: str, note_id: str) -> None:
    """Best-effort cleanup. We don't assert because a 404 on cleanup
    of a partial-success test is fine — we want the loud assertion to
    be the actual feature failure, not the teardown."""
    try:
        authenticated_session.delete(f"{gateway_url}/notes/{note_id}", timeout=15)
    except requests.RequestException:
        pass


# ---------------------------------------------------------------------------
# Named saves + restore-with-undo
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestNoteVersions:
    """Named save-points and restore-with-undo on note_versions.

    No LLM in the loop, so these are kept fast (<2 s typical) — the
    assistant-endpoint tests with the `slow` marker live separately."""

    def test_save_named_then_list_includes_named_kind(self, authenticated_session, gateway_url):
        note = _create_note(authenticated_session, gateway_url)
        note_id = note["id"]
        try:
            label = "Pre-revision draft"
            message = "Saving before I rewrite the second half."
            saved = authenticated_session.post(
                f"{gateway_url}/notes/{note_id}/versions/save-named",
                json={"label": label, "message": message},
                timeout=15,
            )
            assert saved.status_code in (200, 201), saved.text
            saved_body = saved.json()
            # Response is the persisted NoteVersionResponse — confirm
            # all named-save fields landed (kind/label/message +
            # parent_version_id null for non-restore rows).
            assert saved_body["kind"] == "named"
            assert saved_body["label"] == label
            assert saved_body["message"] == message
            # Jackson is configured to drop null fields globally, so
            # `parent_version_id` is absent for kind=named rows. Use
            # `.get()` to assert "either missing or null", which is the
            # contract the frontend already handles via `?? null`.
            assert saved_body.get("parent_version_id") is None

            listing = authenticated_session.get(
                f"{gateway_url}/notes/{note_id}/versions",
                timeout=15,
            )
            assert listing.status_code == 200, listing.text
            versions = listing.json()
            assert isinstance(versions, list)
            named_versions = [v for v in versions if v.get("kind") == "named"]
            assert len(named_versions) >= 1
            assert any(v["label"] == label for v in named_versions)
        finally:
            _delete_note(authenticated_session, gateway_url, note_id)

    def test_save_named_rejects_blank_label(self, authenticated_session, gateway_url):
        """Validation guard: the label is the only navigation handle
        for the named-save action; rejecting blank labels keeps the
        version list useful."""
        note = _create_note(authenticated_session, gateway_url)
        note_id = note["id"]
        try:
            response = authenticated_session.post(
                f"{gateway_url}/notes/{note_id}/versions/save-named",
                json={"label": "   ", "message": "anything"},
                timeout=15,
            )
            assert response.status_code in (400, 422), response.text
        finally:
            _delete_note(authenticated_session, gateway_url, note_id)

    def test_restore_creates_pre_restore_snapshot(self, authenticated_session, gateway_url):
        """Restore should leave a `kind=restore` snapshot of the
        BEFORE-state in the version list, with parent_version_id pointing
        at the version we restored TO. That's the undo handle."""
        note = _create_note(
            authenticated_session,
            gateway_url,
            content="<p>Original v1 content</p>",
        )
        note_id = note["id"]
        try:
            # Save a named v1 anchor we can restore to later.
            v1 = authenticated_session.post(
                f"{gateway_url}/notes/{note_id}/versions/save-named",
                json={"label": "v1", "message": None},
                timeout=15,
            )
            assert v1.status_code in (200, 201), v1.text
            v1_id = v1.json()["id"]

            # Mutate the note so v1.content differs from current.
            authenticated_session.put(
                f"{gateway_url}/notes/{note_id}",
                json={"content": "<p>Mutated v2 content — should be restorable to v1.</p>"},
                timeout=15,
            )
            # Small sleep so the restore-snapshot's createdAt clearly
            # follows the named-save in any timestamp ordering.
            time.sleep(0.5)

            restore = authenticated_session.post(
                f"{gateway_url}/notes/{note_id}/versions/{v1_id}/restore",
                timeout=15,
            )
            assert restore.status_code == 200, restore.text

            listing = authenticated_session.get(f"{gateway_url}/notes/{note_id}/versions", timeout=15).json()
            restore_rows = [v for v in listing if v.get("kind") == "restore"]
            assert len(restore_rows) >= 1, "expected a kind=restore pivot snapshot"
            # The pre-restore snapshot must point its parent_version_id
            # at the version we restored TO so the UI can render the
            # "Restored from version X" pill and let the user undo.
            assert any(r.get("parent_version_id") == v1_id for r in restore_rows), "expected at least one restore row with parent_version_id == v1.id"
        finally:
            _delete_note(authenticated_session, gateway_url, note_id)
