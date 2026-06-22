"""Backward-compat re-export — canonical location is ``targets.postgres``.

Kept so the user-facing CLI entry point can import ``DbWriteContext`` and
``ScrapalotDbWriter`` from this path without modification.
"""

from scripts.dataset_generator.targets.postgres import DbWriteContext, ScrapalotDbWriter  # noqa: F401

__all__ = ["DbWriteContext", "ScrapalotDbWriter"]
