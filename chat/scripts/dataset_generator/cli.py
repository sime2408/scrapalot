"""Backward-compat re-export — canonical location is ``core.cli``.

Kept so ``scripts/dataset_generator.py`` (the user-facing CLI entry point) can
import ``parse_args`` from this path without modification.
"""

from scripts.dataset_generator.core.cli import *  # noqa: F401, F403
from scripts.dataset_generator.core.cli import parse_args  # noqa: F401
