"""Shared agent-definition primitive for the cross-surface agent harness.

An ``AgentDefinition`` is a single, surface-agnostic description of an agent
the user (or system) can define: a persona, an optional per-agent model
override, and an optional stance. It is the foundation the council (deep
research), the notes editor, and chat will all consume — see
``docs/prd-competitive/competitive_analysis_hermes_agent.md`` §4b.

PR #1 wires only the **council** surface (deep research). The model
deliberately carries the fields the later surfaces will need (model
override, stance) so the schema stays stable as notes/chat are added.

Roster data arrives from two places, both untrusted:
  * request ``metadata["council_members"]`` — a JSON string the UI sends, or
  * a saved template's ``ResearchTemplate.agent_config`` JSON column.

``parse_roster`` therefore never raises: a malformed member can only shrink
the roster, never break the caller (the council falls back to its built-in
archetypes when the roster ends up empty).
"""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, Field, field_validator


class AgentDefinition(BaseModel):
    """One user/system-defined agent (a council member, notes/chat agent, …)."""

    name: str = Field(..., max_length=80, description="Human label / member id, e.g. 'Bayesian skeptic'.")
    role: str = Field(
        default="",
        max_length=4000,
        description="Persona / system-prompt body — the lens this agent argues from.",
    )
    stance: str | None = Field(default=None, max_length=400, description="Optional one-line brief/stance.")
    model: str | None = Field(
        default=None,
        max_length=120,
        description="Optional 'provider:model' override (e.g. 'anthropic:claude-opus-4-8'). None → surface's system model.",
    )
    emoji: str | None = Field(default=None, max_length=8)

    @field_validator("name")
    @classmethod
    def _name_non_empty(cls, v: str) -> str:
        v = (v or "").strip()
        if not v:
            raise ValueError("AgentDefinition.name must be non-empty")
        return v


def parse_roster(raw: Any) -> list[AgentDefinition]:
    """Best-effort parse a roster into ``AgentDefinition``s; never raises.

    Accepts: a JSON string, a list of dicts/AgentDefinitions, or a dict with a
    ``members`` / ``council`` key. Malformed members are silently dropped.
    """
    if raw is None:
        return []

    if isinstance(raw, str):
        raw = raw.strip()
        if not raw:
            return []
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return []

    # Unwrap {"members": [...]} or {"council": {"members": [...]}}
    if isinstance(raw, dict):
        inner = raw.get("members")
        if inner is None and isinstance(raw.get("council"), dict):
            inner = raw["council"].get("members")
        raw = inner if inner is not None else []

    if not isinstance(raw, list):
        return []

    roster: list[AgentDefinition] = []
    for item in raw:
        if isinstance(item, AgentDefinition):
            roster.append(item)
            continue
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or item.get("id") or "").strip()
        role = (item.get("role") or item.get("persona") or item.get("system_prompt") or "").strip()
        if not name and role:
            name = role[:60]
        if not name:
            continue
        try:
            roster.append(
                AgentDefinition(
                    name=name,
                    role=role,
                    stance=item.get("stance"),
                    model=item.get("model"),
                    emoji=item.get("emoji"),
                )
            )
        except (ValueError, TypeError):
            continue
    return roster
